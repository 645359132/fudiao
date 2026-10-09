import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeModel, waitProposal } from '@fudiao/engine/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args';
import { main, type CliDeps } from './cli';
import { estimateCalls, estimateCost } from './cost';
import { buildPort, loadExperiment, runConfig, taskModel } from './experiment';
import { loadSceneFile } from './scene-file';
import { ulid } from './ulid';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const out = mkdtempSync(join(tmpdir(), 'fudiao-cli-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function deps(overrides: Partial<CliDeps> & { answers?: boolean[] } = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const answers = [...(overrides.answers ?? [])];
  let n = 0;
  const d: CliDeps = {
    console: {
      out: (t) => lines.push(t),
      err: (t) => errors.push(t),
      confirm: () => Promise.resolve(answers.shift() ?? false),
    },
    env: {},
    root,
    now: () => '2026-10-07T00:00:00.000Z',
    newId: () => `TESTRUN${String(n++).padStart(4, '0')}`,
    ...overrides,
  };
  return { d, lines, errors };
}

describe('命令行参数', () => {
  it('解析位置参数、带值与不带值的选项', () => {
    expect(parseArgs(['a.yaml', '--runs', '3', '--yes', '--mode=auto'])).toEqual({
      positionals: ['a.yaml'],
      flags: { runs: '3', yes: true, mode: 'auto' },
    });
  });

  it('ULID 为 26 位、按时间可排序', () => {
    const a = ulid(1_000, new Uint8Array(10));
    const b = ulid(2_000, new Uint8Array(10).fill(255));
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });
});

describe('默认实验配置与费用估算', () => {
  const experiment = loadExperiment(readFileSync(join(root, 'm0/experiments/default.yaml'), 'utf8'));

  it('通过校验，全部任务都有模型', () => {
    expect(experiment.ok).toBe(true);
  });

  it('仓库场景 8 回合的提案、裁决与认知更新约 45 次调用（含一成修正），费用约 3 至 6.5 美元', () => {
    if (!experiment.ok) return;
    const scene = loadSceneFile(readFileSync(join(root, 'm0/scenes/warehouse.yaml'), 'utf8'));
    if (!scene.ok) throw new Error('场景无效');
    const config = runConfig(experiment.value, scene.value.run, { seed: 1 });
    const counts = estimateCalls(config.protocol, 2, config.maxRounds);
    const estimate = estimateCost([
      { model: config.models.character_action, calls: counts.proposals },
      { model: config.models.semantic_ruling, calls: counts.rulings },
      { model: config.models.belief_update, calls: counts.beliefs },
    ]);
    expect(estimate.calls).toBe(45);
    expect(estimate.lowUsd).toBeGreaterThan(3);
    expect(estimate.highUsd).toBeLessThan(6.5);
  });

  it('OpenAI 写法的示例配置：按服务的写法发送请求', async () => {
    const example = loadExperiment(readFileSync(join(root, 'm0/experiments/openai-compatible.example.yaml'), 'utf8'));
    if (!example.ok) throw new Error(example.error);
    expect(buildPort(example.value, {})).toEqual({ ok: false, error: 'deepseek：环境变量 DEEPSEEK_API_KEY 未设置' });

    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(init.body as string) as Record<string, unknown> });
      const body = chunk({ content: '<think>先想想</think>{"ok":true}' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    });
    try {
      const port = buildPort(example.value, { DEEPSEEK_API_KEY: 'test-key' });
      if (!port.ok) throw new Error(port.error);
      const model = taskModel(example.value, 'character_action');
      const result = await port.value.complete({
        task: 'character_action',
        model: model.profile,
        template: { id: 'character_action', version: '1' },
        system: [{ text: '按要求输出 JSON。' }],
        messages: [{ role: 'user', content: '行动' }],
        output: { name: 'ActionProposal', schema: { type: 'object' } },
        maxOutputTokens: model.maxOutputTokens,
      });
      expect(result.ok && result.value.text).toBe('{"ok":true}');
      expect(sent[0]?.url).toBe('https://api.deepseek.com/chat/completions');
      expect(sent[0]?.body).toMatchObject({ model: 'deepseek-chat', max_tokens: 8000, response_format: { type: 'json_object' } });
      expect(sent[0]?.body).not.toHaveProperty('max_completion_tokens');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('价格未配置时费用为未知', () => {
    if (!experiment.ok) return;
    const model = taskModel(experiment.value, 'character_action');
    const unpriced = { ...model, profile: { ...model.profile, prices: undefined as never } };
    expect(estimateCost([{ model: unpriced, calls: 3 }]).lowUsd).toBeNull();
  });

  it('配置引用未定义的模型时报错', () => {
    const text = readFileSync(join(root, 'm0/experiments/default.yaml'), 'utf8').replace('character_action: { model: opus', 'character_action: { model: nope');
    expect(loadExperiment(text)).toEqual({ ok: false, error: 'tasks.character_action.model: 未定义的模型 nope' });
  });
});

describe('真实调用前的费用确认', () => {
  it('显示预计费用；作者不同意时不调用任何服务', async () => {
    const { d, lines } = deps({ answers: [false] });
    const code = await main(['run', 'm0/scenes/warehouse.yaml', '--out', out], d);
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/预计调用 61 次，费用约 \$\d+\.\d\d 至 \$\d+\.\d\d；每次运行的预算上限 \$6\.00/);
    expect(lines).toContain('已取消。');
  });

  it('同意后缺少 API Key 时报错，不发出请求', async () => {
    const { d, errors } = deps({ answers: [true] });
    const code = await main(['run', 'm0/scenes/warehouse.yaml', '--out', out], d);
    expect(code).toBe(1);
    expect(errors).toEqual(['anthropic：环境变量 ANTHROPIC_API_KEY 未设置']);
  });
});

describe('命令（测试模型）', () => {
  const model = fakeModel({
    character_action: (ctx) =>
      ctx.round === 1
        ? waitProposal({ kind: 'speak', utterance: { sentences: ['你来晚了。'], volume: 'normal' }, innerThought: '他怎么会在这里' })
        : waitProposal({ kind: 'observe' }),
  });

  it('run 写出事件记录、调用记录与摘要', async () => {
    const { d, lines } = deps({ port: model.port });
    const code = await main(['run', 'm0/scenes/pawnshop.yaml', '--out', out, '--runs', '1'], d);
    expect(code).toBe(0);
    const dir = join(out, 'TESTRUN0000');
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(true);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { phase: string; endReason: string; calls: number };
    expect(summary).toMatchObject({ phase: 'Ended', endReason: 'max_rounds' });
    expect(summary.calls).toBeGreaterThan(0);
    expect(lines.at(-1)).toMatch(/^运行 TESTRUN0000：Ended（max_rounds），20 回合/);
  }, 30_000);

  it('run --resume 继续已有的运行而不重复调用', async () => {
    const before = model.calls.length;
    const { d } = deps({ port: model.port });
    expect(await main(['run', 'm0/scenes/pawnshop.yaml', '--out', out, '--resume', 'TESTRUN0000'], d)).toBe(0);
    expect(model.calls.length).toBe(before);
  });

  it('narrate 由运行记录生成节拍表与候选稿', async () => {
    const { d, lines } = deps({ port: model.port });
    const code = await main(['narrate', 'TESTRUN0000', '--pov', 'lin_zhou', '--out', out, '--style', '冷峻'], d);
    expect(code).toBe(0);
    const dir = join(out, 'TESTRUN0000', 'narration-lin_zhou');
    expect(readFileSync(join(dir, 'text.md'), 'utf8')).toContain('雨下得更紧了');
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { beats: unknown[] };
    expect(meta.beats.length).toBeGreaterThan(0);
    expect(lines.at(-1)).toContain('lin_zhou 视角的候选稿');
    // 节拍表的请求只含视角人物的认知。
    const beatsCall = model.calls.find((c) => c.request.task === 'beat_sheet');
    expect(beatsCall?.text).not.toContain('赌债以外');
    expect(beatsCall?.text).not.toContain('城南王家丢了一块相似的玉佩');
  });

  it('view 生成单个 HTML 查看页', async () => {
    const { d, lines } = deps();
    expect(await main(['view', 'TESTRUN0000', '--out', out], d)).toBe(0);
    const html = readFileSync(join(out, 'TESTRUN0000', 'view.html'), 'utf8');
    expect(html).toContain('当铺夜谈');
    expect(lines.at(-1)).toContain('view.html');
  });

  it('baseline 写出对照组正文', async () => {
    const { d } = deps({ port: model.port, newId: () => 'BASE0001' });
    expect(await main(['baseline', 'm0/scenes/rainy-night.yaml', '--out', out, '--runs', '1'], d)).toBe(0);
    expect(readFileSync(join(out, 'baseline-BASE0001', 'text.md'), 'utf8')).toContain('雨下得更紧了');
  });

  it('baseline 与 narrate 都写出事件梗概，供分层比较', () => {
    expect(readFileSync(join(out, 'baseline-BASE0001', 'synopsis.md'), 'utf8')).toContain('- 两人在雨夜对峙');
    expect(readFileSync(join(out, 'TESTRUN0000', 'narration-lin_zhou', 'synopsis.md'), 'utf8')).toContain('- 两人试探');
    const meta = JSON.parse(readFileSync(join(out, 'TESTRUN0000', 'narration-lin_zhou', 'meta.json'), 'utf8')) as { costUsd: number };
    expect(meta.costUsd).toBeGreaterThan(0);
  });

  it('report 由清单生成评估包，report analyze 汇总评分', async () => {
    const manifest = join(out, 'round-test.yaml');
    writeFileSync(
      manifest,
      [
        'id: round-test',
        'evaluators: [e1, e2]',
        'perEvaluator: 2',
        'samples:',
        `  - { scene: rainy, condition: baseline, dir: ${JSON.stringify(join(out, 'baseline-BASE0001'))} }`,
        `  - { scene: pawnshop, condition: simulation, dir: ${JSON.stringify(join(out, 'TESTRUN0000', 'narration-lin_zhou'))} }`,
      ].join('\n'),
    );
    const { d, lines } = deps();
    expect(await main(['report', manifest, '--out', join(out, 'packets')], d)).toBe(0);
    expect(lines.at(-1)).toContain('已为 2 位评价者生成评估包');
    expect(readdirSync(join(out, 'packets', 'e1')).filter((f) => f.endsWith('.md'))).toHaveLength(3);
    const analyzed = deps();
    expect(await main(['report', 'analyze', '--out', join(out, 'packets')], analyzed.d)).toBe(0);
    expect(analyzed.lines.join('\n')).toContain('# 评分汇总：round-test');
  });

  it('motive-check 统计采样中选择指定行动的比例', async () => {
    // 动机检验的步骤键不含回合，用一个固定选择说话的测试模型。
    const speaker = fakeModel({ character_action: () => waitProposal({ kind: 'speak', utterance: { sentences: ['站住。'], volume: 'normal' } }) });
    const { d, lines } = deps({ port: speaker.port, newId: () => 'MOTIVE01' });
    expect(await main(['motive-check', 'm0/scenes/warehouse.yaml', '--actor', 'wei_qi', '--expect', 'speak', '--samples', '3', '--out', out], d)).toBe(0);
    expect(lines.at(-1)).toBe('动机可达性：3/3 次采样选择了 speak。');
    expect(readdirSync(out)).toContain('motive-MOTIVE01.json');
  });

  it('run --runs N --parallel P --director curve 并行写出 N 份记录，导演事件计入摘要', async () => {
    const batch = join(out, 'batch');
    const director = fakeModel({
      director: (ctx) =>
        ctx.round === 1
          ? {
              propose: true,
              rationale: '雨势加大，逼两人进屋',
              event: { zone: 'courtyard', visible: true, loudness: 4, visual: null, sound: '一声惊雷', setFlags: [] },
            }
          : { propose: false, rationale: '', event: null },
    });
    const { d, lines } = deps({ port: director.port });
    const code = await main(
      ['run', 'm0/scenes/rainy-night.yaml', '--out', batch, '--runs', '3', '--parallel', '2', '--director', 'curve', '--curve', '第三轮爆发'],
      d,
    );
    expect(code).toBe(0);
    // 3 次运行 × 20 回合；导演按张力曲线在 19 个回合边界各请求一次，连同证据链判断与一成修正计入估算。
    expect(lines[0]).toMatch(/^预计调用 453 次/);
    const runs = readdirSync(batch).filter((f) => f.startsWith('TESTRUN')).sort();
    expect(runs).toEqual(['TESTRUN0000', 'TESTRUN0001', 'TESTRUN0002']);
    for (const run of runs) {
      const summary = JSON.parse(readFileSync(join(batch, run, 'summary.json'), 'utf8')) as { directorEvents: number };
      expect(summary.directorEvents).toBe(1);
    }
    const directorCalls = director.calls.filter((c) => c.step === 'director');
    expect(directorCalls.length).toBe(3 * 19);
    expect(directorCalls[0]?.text).toContain('第三轮爆发');
  }, 30_000);

  it('outcomes 按结局归类，列出代表运行的关键转折', async () => {
    const batch = join(out, 'batch');
    const { d, lines } = deps();
    expect(await main(['outcomes', 'TESTRUN0000', 'TESTRUN0001', 'TESTRUN0002', '--out', batch], d)).toBe(0);
    expect(lines.at(-1)).toMatch(/^3 次运行，1 种结局/);
    const text = readFileSync(join(batch, 'outcomes-TESTRUN0000.md'), 'utf8');
    expect(text).toContain('## 结局 1（3 次）');
    expect(text).toContain('没寄出的信：阿青手里');
    expect(text).toContain('第 1 回合（导演事件）：一声惊雷');
  });

  it('run 的导演与并行参数有误时报错', async () => {
    const { d, errors } = deps();
    expect(await main(['run', 'm0/scenes/rainy-night.yaml', '--director', 'always'], d)).toBe(1);
    expect(await main(['run', 'm0/scenes/rainy-night.yaml', '--parallel', '0'], d)).toBe(1);
    expect(errors).toHaveLength(2);
  });

  it('未知命令与缺少参数时给出用法', async () => {
    const { d, errors } = deps();
    expect(await main(['deploy'], d)).toBe(1);
    expect(errors[0]).toContain('未知命令：deploy');
    expect(await main(['narrate'], d)).toBe(1);
  });
});

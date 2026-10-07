import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeModel, waitProposal } from '@novel-writer/engine/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs } from './args';
import { main, type CliDeps } from './cli';
import { estimateCalls, estimateCost } from './cost';
import { loadExperiment, runConfig, taskModel } from './experiment';
import { loadSceneFile } from './scene-file';
import { ulid } from './ulid';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const out = mkdtempSync(join(tmpdir(), 'novel-writer-cli-'));
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

  it('仓库场景 8 回合约 40 次调用，费用落在施工文档估算的 2 至 5 美元附近', () => {
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
    expect(estimate.calls).toBe(40);
    expect(estimate.lowUsd).toBeGreaterThan(1.5);
    expect(estimate.highUsd).toBeLessThan(5);
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
    expect(lines.join('\n')).toMatch(/预计调用 40 次，费用约 \$\d+\.\d\d 至 \$\d+\.\d\d；每次运行的预算上限 \$6\.00/);
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
    expect(lines.at(-1)).toMatch(/^运行 TESTRUN0000：Ended（max_rounds），10 回合/);
  });

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

  it('未知命令与缺少参数时给出用法', async () => {
    const { d, errors } = deps();
    expect(await main(['deploy'], d)).toBe(1);
    expect(errors[0]).toContain('未知命令：deploy');
    expect(await main(['narrate'], d)).toBe(1);
  });
});

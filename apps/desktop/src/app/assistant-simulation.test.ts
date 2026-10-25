import { rmSync } from 'node:fs';
import { warehouseSpec } from '@fudiao/domain/testing';
import { fakeModel } from '@fudiao/engine/testing';
import type { LlmPort } from '@fudiao/llm';
import type { AssistantTurnOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { dramaPolicy, sceneDraftFixture } from '../testing/scenes';
import type { AssistantEffect, AssistantItem } from './assistant';
import type { BackgroundJobs } from './assistant-tools';
import { createAppService } from './service';

const all: TestDeps[] = [];
afterEach(async () => {
  for (const d of all.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** 推演与写成正文的任务由测试模型应答，其余（能力自检、助手、场景配置草稿）按排好的回复。 */
const SIMULATED: ReadonlySet<string> = new Set(['character_action', 'semantic_ruling', 'belief_update', 'judgement', 'beat_sheet', 'candidate_text', 'director']);

/**
 * 助手的每一步与场景配置草稿按排好的回复应答（经 HTTP 夹具）；推演中的角色行动、裁决、节拍表与正文由测试模型应答。
 * 用例、引擎、SQLite 事件存储与调用记录都是真实的。
 */
async function setup() {
  const base = fsDeps();
  const fake = fakeModel(dramaPolicy);
  const routed = (provider: Parameters<TestDeps['llm']['forProvider']>[0]): LlmPort => ({
    complete: (request, options) => (SIMULATED.has(request.task) ? fake.port.complete(request, options) : base.llm.forProvider(provider).complete(request, options)),
  });
  const deps: TestDeps = { ...base, llm: { forProvider: routed } };
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('推演'));
  await addTestedModel(app, deps);
  deps.llmRequests.length = 0;
  return { deps, app, fake };
}

const step = (deps: TestDeps, output: AssistantTurnOutput) => deps.llmResponses.push(reply(JSON.stringify(output)));
const lastResults = (items: readonly AssistantItem[]) => items.filter((i): i is Extract<AssistantItem, { role: 'results' }> => i.role === 'results').at(-1);
const sceneFields = { chapterId: null, title: '废仓库', config: warehouseSpec(), protocol: 'simultaneous' as const, maxRounds: 3, firstSpeaker: null };

/** 状态层的后台推演：这里直接连续推进，测试等它推完。 */
function backgroundFor(app: Awaited<ReturnType<typeof setup>>['app']) {
  const runs: Promise<unknown>[] = [];
  const started: string[] = [];
  const jobs: BackgroundJobs = {
    writeChapters: () => null,
    reviewChapters: () => null,
    reviseIssues: () => Promise.resolve(null),
    workflow: () => null,
    simulating: () => false,
    run: () => Promise.resolve(null),
    writing: () => [],
    simulate(runId) {
      started.push(runId);
      runs.push(app.continueSimRun(runId));
      return null;
    },
    stop: () => '',
  };
  return { jobs, started, settled: () => Promise.all(runs) };
}

describe('AI 助手操作角色推演（M5-19）', () => {
  it('由一段局面描述建场景：生成草稿、按规则校验后保存；两个角色时轮流对话，没给回合上限时为 8', async () => {
    const { deps, app } = await setup();
    const chapter = value(await app.createChapter('第一章 当铺')).chapters[0]!;
    step(deps, {
      message: '',
      actions: [{ tool: 'create_sim_scene', description: '雨夜当铺，林舟来当玉，掌柜钱四认出玉是师父的遗作。', title: '当铺夜谈', chapter: '第一章 当铺', maxRounds: null }],
      done: true,
    });
    deps.llmResponses.push(reply(JSON.stringify(sceneDraftFixture())));
    const effects: AssistantEffect[] = [];
    const outcome = value(await app.sendToAssistant('让林舟和钱四在当铺里推演一下', { onEffect: (e) => effects.push(e) }));
    const [scene] = value(await app.listSimScenes());
    expect(scene).toMatchObject({ title: '当铺夜谈', chapterId: chapter.id, protocol: 'turn_based', maxRounds: 8 });
    expect(lastResults(outcome.items)?.results[0]).toMatchObject({ tool: 'create_sim_scene', ok: true, detail: expect.stringContaining('林舟（lin_zhou）') });
    expect(effects).toContainEqual({ kind: 'simulation_changed' });
  });

  it('生成的场景不合规则时不保存，把问题告诉模型', async () => {
    const { deps, app } = await setup();
    const broken = { ...sceneDraftFixture(), actors: sceneDraftFixture().actors.map((a) => ({ ...a, zone: 'nowhere' })) };
    step(deps, { message: '', actions: [{ tool: 'create_sim_scene', description: '当铺', title: null, chapter: null, maxRounds: 3 }], done: true });
    deps.llmResponses.push(reply(JSON.stringify(broken)));
    step(deps, { message: '场景没有建成。', actions: [], done: true });
    const outcome = value(await app.sendToAssistant('建个推演场景'));
    expect(value(await app.listSimScenes())).toEqual([]);
    expect(lastResults(outcome.items)?.results[0]).toMatchObject({ tool: 'create_sim_scene', ok: false, detail: expect.stringContaining('没有保存') });
  });

  it('开始推演交给后台、立即返回；推完后看全局概要（状态、费用、每回合发生的事与局面），再按一个角色的视角写成候选稿', async () => {
    const { deps, app, fake } = await setup();
    const scene = value(await app.saveSimScene(null, sceneFields));
    const chapter = value(await app.createChapter('第三章 仓库')).chapters[0]!;
    const background = backgroundFor(app);

    step(deps, { message: '开始推演，会按回合调用模型。', actions: [{ tool: 'start_simulation', scene: '废仓库', budgetUsd: null }], done: true });
    const started = value(await app.sendToAssistant('推演一下仓库这场戏', { background: background.jobs }));
    expect(lastResults(started.items)?.results[0]).toMatchObject({ tool: 'start_simulation', ok: true, detail: expect.stringContaining('已开始推演') });
    expect(background.started).toHaveLength(1);
    const runId = background.started[0]!;
    expect(value(await app.listSimRuns(scene.id)).map((r) => [r.id, r.mode])).toEqual([[runId, 'auto']]);
    await background.settled();

    // 给场景名也能找到它最近的一次推演。
    step(deps, { message: '', actions: [{ tool: 'get_simulation', run: '废仓库' }], done: true });
    const viewed = value(await app.sendToAssistant('推得怎么样了'));
    const summary = lastResults(viewed.items)?.results[0]?.detail ?? '';
    for (const part of [`推演 [${runId}]：已结束（到达回合上限），第 3 回合`, '已用 $', '主角（protagonist）', '第 1 回合：', '第 3 回合：', '此刻的局面：', '采纳进作品前要作者逐项复核']) {
      expect(summary).toContain(part);
    }

    const before = fake.calls.length;
    step(deps, { message: '', actions: [{ tool: 'narrate_simulation', run: runId, pov: '主角', chapter: '第三章 仓库', fromRound: null, toRound: null }], done: true });
    const effects: AssistantEffect[] = [];
    const narrated = value(await app.sendToAssistant('按主角的视角写进第三章', { onEffect: (e) => effects.push(e) }));
    expect(lastResults(narrated.items)?.results[0]).toMatchObject({ tool: 'narrate_simulation', ok: true, detail: expect.stringContaining('第 1–3 回合') });
    expect(fake.calls.slice(before).map((c) => c.request.task)).toEqual(['beat_sheet', 'candidate_text']);
    const [candidate] = value(await app.listCandidates(chapter.id));
    expect(candidate).toMatchObject({ operation: 'narrate', status: 'pending' });
    expect(value(await app.listBeatSheets(runId))).toMatchObject([{ sheet: { povActor: 'protagonist', fromRound: 1, toRound: 3, style: '' } }]);
    expect(effects).toContainEqual({ kind: 'show_candidates', chapterId: chapter.id });
    // 推演写成的候选稿要作者经“采纳…”写进作品。
    expect(await app.acceptCandidate(candidate!.id)).toMatchObject({ ok: false });
  });

  it('等作者确认裁决的推演不能由助手继续；已有推演在推进、没有后台时不开始', async () => {
    const { deps, app } = await setup();
    const scene = value(await app.saveSimScene(null, sceneFields));
    const runId = value(await app.startSimRun(scene.id, { mode: 'interactive', seed: 7 })).run.id;
    value(await app.continueSimRun(runId));
    const background = backgroundFor(app);
    const failing = (actions: AssistantTurnOutput['actions']) => {
      step(deps, { message: '', actions, done: true });
      step(deps, { message: '没有做成。', actions: [], done: true });
    };

    failing([{ tool: 'continue_simulation', run: runId }]);
    let outcome = value(await app.sendToAssistant('接着推', { background: background.jobs }));
    expect(lastResults(outcome.items)?.results[0]).toMatchObject({ ok: false, detail: expect.stringContaining('1 条待核实的裁决') });
    expect(background.started).toEqual([]);

    failing([{ tool: 'start_simulation', scene: scene.id, budgetUsd: null }]);
    outcome = value(await app.sendToAssistant('再推一次', { background: { ...background.jobs, workflow: () => null, simulating: () => true } }));
    expect(lastResults(outcome.items)?.results[0]).toMatchObject({ ok: false, detail: expect.stringContaining('已经有一次推演') });
    expect(value(await app.listSimRuns(scene.id))).toHaveLength(1);

    failing([{ tool: 'start_simulation', scene: scene.id, budgetUsd: null }]);
    outcome = value(await app.sendToAssistant('再推一次'));
    expect(lastResults(outcome.items)?.results[0]).toMatchObject({ ok: false, detail: expect.stringContaining('推演页') });
  });

  it('列出场景与推演；停下后台推演经 stop_background', async () => {
    const { deps, app } = await setup();
    const scene = value(await app.saveSimScene(null, sceneFields));
    const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
    value(await app.stopSimRun(runId));
    const asked: string[] = [];
    const background: BackgroundJobs = { ...backgroundFor(app).jobs, stop: (what) => (asked.push(what), '已停下：推演停在当前这一步之后（可以继续）。') };
    step(deps, {
      message: '',
      actions: [
        { tool: 'list_simulations', scene: null },
        { tool: 'stop_background', what: 'simulation' },
      ],
      done: true,
    });
    const outcome = value(await app.sendToAssistant('有哪些推演？先停下正在推的', { background }));
    const [listed, stopped] = lastResults(outcome.items)?.results ?? [];
    expect(listed?.detail).toContain(`[${scene.id}] 废仓库（同时行动，最多 3 回合；角色：`);
    expect(listed?.detail).toContain(`推演 [${runId}]：已结束（作者停止），第`);
    expect(stopped).toMatchObject({ ok: true });
    expect(asked).toEqual(['simulation']);
  });
});

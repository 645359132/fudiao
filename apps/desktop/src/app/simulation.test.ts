import { rmSync } from 'node:fs';
import { canarySpec, staticForbidden, warehouseSpec } from '@fudiao/domain/testing';
import { parseScene } from '@fudiao/domain';
import { createEngine, type RunConfig } from '@fudiao/engine';
import { contextOf, fakeModel, waitProposal, type Policy } from '@fudiao/engine/testing';
import { inspectRequests, memoryCallLog, type LlmPort } from '@fudiao/llm';
import { memoryEventStore } from '@fudiao/store';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { dramaPolicy as policy, sceneDraftFixture } from '../testing/scenes';
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

const sceneFields = (config: Record<string, unknown> = warehouseSpec()) => ({
  chapterId: null,
  title: '废仓库',
  config,
  protocol: 'simultaneous' as const,
  maxRounds: 3,
  firstSpeaker: null,
});

/**
 * 打开一部作品，配好通过自检的默认模型；之后模型调用改由 model 应答（不经 HTTP），
 * 其余（用例、引擎、SQLite 事件存储、llm_call 调用记录）都是真实的。
 */
async function setup(root?: string) {
  const base = fsDeps(root);
  let model: LlmPort | null = null;
  const deps: TestDeps = { ...base, llm: { forProvider: (provider) => model ?? base.llm.forProvider(provider) } };
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  return {
    deps,
    app,
    useModel: (port: LlmPort | null) => {
      model = port;
    },
  };
}

async function ready(use: Policy = policy) {
  const ctx = await setup();
  value(await ctx.app.createWork('推演'));
  await addTestedModel(ctx.app, ctx.deps);
  const fake = fakeModel(use);
  ctx.useModel(fake.port);
  const scene = value(await ctx.app.saveSimScene(null, sceneFields()));
  return { ...ctx, fake, scene };
}

const payloads = (events: readonly { payload: unknown }[]) => events.map((e) => e.payload);
const types = (events: readonly { payload: unknown }[]) => events.map((e) => (e.payload as { type: string }).type);

describe('推演场景', () => {
  it('保存前校验场景配置；修改配置后配置版本加一', async () => {
    const { app } = await setup();
    value(await app.createWork('推演'));
    expect(await app.saveSimScene(null, sceneFields({ zones: [] }))).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('场景配置') } });
    expect(await app.saveSimScene(null, { ...sceneFields(), firstSpeaker: 'nobody' })).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('nobody') } });
    expect(value(await app.listSimScenes())).toEqual([]);

    const scene = value(await app.saveSimScene(null, { ...sceneFields(), firstSpeaker: 'protagonist' }));
    expect(scene).toMatchObject({ title: '废仓库', configVersion: 1, firstSpeaker: 'protagonist' });
    const spec = warehouseSpec();
    spec.zones[0] = { ...spec.zones[0]!, name: '改过名字的区域' };
    expect(value(await app.saveSimScene(scene.id, sceneFields(spec as Record<string, unknown>)))).toMatchObject({ id: scene.id, configVersion: 2, version: 2 });
    expect(value(await app.listSimScenes())).toHaveLength(1);
  });
});

describe('开始推演', () => {
  it('没有默认模型、默认模型没有通过能力自检时不开始，也不登记运行', async () => {
    const { deps, app } = await setup();
    value(await app.createWork('推演'));
    const scene = value(await app.saveSimScene(null, sceneFields()));
    expect(await app.startSimRun(scene.id, { mode: 'auto' })).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('还没有设置默认模型') } });
    const provider = value(await app.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk-s' }));
    value(await app.addModel(provider.providers[0]?.id ?? '', 'm'));
    expect(await app.startSimRun(scene.id, { mode: 'auto' })).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('没有通过能力自检') } });
    expect(value(await app.listSimRuns(scene.id))).toEqual([]);
    expect(deps.llmRequests).toHaveLength(0);
  });

  it('运行配置里的模型来自默认模型：服务标识、模型名与按能力给出的输出上限；种子写在第一条事件里', async () => {
    const { app, scene } = await ready();
    const started = value(await app.startSimRun(scene.id, { mode: 'auto' }));
    expect(started).toMatchObject({ phase: 'BuildingViews', round: 0, run: { status: 'running', sceneId: scene.id, sceneConfigVersion: 1, mode: 'auto', lastSeq: 1 } });
    const [first] = value(await app.simRunEvents(started.run.id));
    const config = (first?.payload as { config: RunConfig }).config;
    const service = value(await app.loadModelServices());
    expect(config).toMatchObject({ protocol: 'simultaneous', mode: 'auto', maxRounds: 3, stalemate: { enabled: true }, director: { enabled: false } });
    expect(Number.isInteger(config.seed)).toBe(true);
    for (const task of [config.models.character_action, config.models.semantic_ruling, config.models.belief_update, config.models.judgement, config.models.stalemate]) {
      expect(task?.profile).toMatchObject({ provider: service.providers[0]?.id, model: 'm' });
      // 测试模型的最大输出是 4,096：上限不超过它。
      expect(task?.maxOutputTokens).toBe(4096);
    }
    // 指定种子时用指定的。
    const seeded = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 42 }));
    expect(((value(await app.simRunEvents(seeded.run.id))[0]?.payload as { config: RunConfig }).config).seed).toBe(42);
  });
});

describe('推演到结束', () => {
  it('事件写入作品库，与同一配置在内存事件存储上的运行逐事件一致；运行记录、调用记录与快照随之更新', async () => {
    const { app, scene, fake } = await ready();
    const started = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7 }));
    const runId = started.run.id;
    const ended = value(await app.continueSimRun(runId));
    expect(ended).toMatchObject({ phase: 'Ended', endReason: 'max_rounds', run: { status: 'ended', endReason: 'max_rounds', round: 3 } });

    const events = value(await app.simRunEvents(runId));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(ended.run.lastSeq).toBe(events.length);
    expect(types(events)).toEqual(expect.arrayContaining(['RunStarted', 'AdjudicationConfirmed', 'BeliefsUpdated', 'EvidenceGapFlagged', 'RunEnded']));

    // 同一配置、同一组模型回复，在内存事件存储上再跑一遍。
    const config = (events[0]?.payload as { config: RunConfig }).config;
    const parsed = parseScene(warehouseSpec());
    if (!parsed.ok) throw new Error('场景');
    const memory = memoryEventStore();
    const reference = createEngine({ llm: fakeModel(policy).port, events: memory, calls: memoryCallLog(), now: () => 'T' });
    await reference.start(runId, parsed.value, config);
    await reference.run(runId, parsed.value);
    expect(payloads(events)).toEqual(payloads(await memory.read(runId)));

    // 调用记录：每次模型调用都带步骤键写入 llm_call，没有重复完成的步骤。
    const usage = value(await app.usage());
    expect(usage.summary.total.calls).toBe(fake.calls.length);
    const keys = usage.recent.map((c) => c.stepKey);
    expect(keys.every((k) => k !== null && k.startsWith(runId))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);

    // 结束时记了快照；只读事件重算，哈希一致。
    expect(value(await app.verifySimRun(runId))).toEqual({ snapshots: 1, mismatchedSeqs: [] });
    // 读取状态不调用模型。
    const before = fake.calls.length;
    expect(value(await app.simRunStatus(runId))).toMatchObject({ phase: 'Ended' });
    expect(fake.calls.length).toBe(before);
  });

  it('单步推进一个阶段；暂停、继续与停止都是事件，运行记录的状态随之变化', async () => {
    const { app, scene } = await ready();
    const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
    const stepped = value(await app.stepSimRun(runId));
    expect(stepped.run.status).toBe('running');
    expect(stepped.run.lastSeq).toBeGreaterThan(1);

    const paused = value(await app.pauseSimRun(runId));
    expect(paused).toMatchObject({ phase: 'Paused', pause: { reason: 'author' }, run: { status: 'paused', pauseReason: 'author' } });
    // 暂停时继续推进不会前进。
    expect(value(await app.continueSimRun(runId)).run.lastSeq).toBe(paused.run.lastSeq);
    const resumed = value(await app.resumeSimRun(runId));
    expect(resumed.run).toMatchObject({ status: 'running', pauseReason: null });

    const stopped = value(await app.stopSimRun(runId));
    expect(stopped).toMatchObject({ phase: 'Ended', endReason: 'author_stop', run: { status: 'ended', endReason: 'author_stop' } });
    expect(types(value(await app.simRunEvents(runId))).filter((t) => ['RunPaused', 'RunResumed', 'RunEnded'].includes(t))).toEqual(['RunPaused', 'RunResumed', 'RunEnded']);
    // 暂停与结束处各有一个快照。
    expect(value(await app.verifySimRun(runId))).toEqual({ snapshots: 2, mismatchedSeqs: [] });
    expect(value(await app.listSimRuns(scene.id)).map((r) => r.id)).toEqual([runId]);
  });

  it('交互模式停在待核实的裁决上，运行记录标为等待作者', async () => {
    const { app, scene } = await ready();
    const runId = value(await app.startSimRun(scene.id, { mode: 'interactive', seed: 7 })).run.id;
    const waiting = value(await app.continueSimRun(runId));
    expect(waiting).toMatchObject({ phase: 'AwaitingAuthor', awaitingRulings: 1, run: { status: 'awaiting_author', mode: 'interactive' } });
  });
});

describe('中断与恢复', () => {
  it('模型调用中途崩溃：用例返回说明；再次继续时已完成的步骤不重复调用，结果与不中断时逐事件一致', async () => {
    const baseline = await ready();
    const baseId = value(await baseline.app.startSimRun(baseline.scene.id, { mode: 'auto', seed: 7 })).run.id;
    value(await baseline.app.continueSimRun(baseId));
    const expected = payloads(value(await baseline.app.simRunEvents(baseId)));
    const total = baseline.fake.calls.length;

    for (const crashAt of [2, 5, total]) {
      const { app, scene, fake, useModel } = await ready();
      let count = 0;
      useModel({
        complete(request, options) {
          count++;
          return count === crashAt ? Promise.reject(new Error(`第 ${crashAt} 次调用中崩溃`)) : fake.port.complete(request, options);
        },
      });
      const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
      expect(await app.continueSimRun(runId), `第 ${crashAt} 次`).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('崩溃') } });
      expect(value(await app.continueSimRun(runId))).toMatchObject({ phase: 'Ended' });
      // 运行标识不同只影响步骤键，事件内容相同。
      expect(payloads(value(await app.simRunEvents(runId))).slice(1), `第 ${crashAt} 次`).toEqual(expected.slice(1));
      // 模型一共只被成功调用了 total 次：崩溃的那一次没有完成，恢复后补上，其余没有重复。
      expect(fake.calls.length, `第 ${crashAt} 次`).toBe(total);
      const usage = value(await app.usage());
      expect(usage.summary.total.calls).toBe(total);
    }
  });

  it('关闭作品后重新打开，从停下的地方继续；场景之后改了，这次运行仍按开始时的配置', async () => {
    const first = await ready();
    const runId = value(await first.app.startSimRun(first.scene.id, { mode: 'auto', seed: 7 })).run.id;
    value(await first.app.stepSimRun(runId));
    value(await first.app.stepSimRun(runId));
    const midway = value(await first.app.simRunEvents(runId)).length;
    // 作者改了场景配置。
    const spec = warehouseSpec();
    spec.zones[0] = { ...spec.zones[0]!, name: '改过名字的区域' };
    value(await first.app.saveSimScene(first.scene.id, sceneFields(spec as Record<string, unknown>)));
    const workId = value(await first.app.reloadWork()).entry.id;
    await first.app.closeWork();

    value(await first.app.openWork(workId));
    expect(value(await first.app.simRunStatus(runId)).run.lastSeq).toBe(midway);
    const ended = value(await first.app.continueSimRun(runId));
    expect(ended).toMatchObject({ phase: 'Ended', run: { sceneConfigVersion: 1 } });

    // 与不中断、不改场景的运行逐事件一致。
    const baseline = await ready();
    const baseId = value(await baseline.app.startSimRun(baseline.scene.id, { mode: 'auto', seed: 7 })).run.id;
    value(await baseline.app.continueSimRun(baseId));
    expect(payloads(value(await first.app.simRunEvents(runId))).slice(1)).toEqual(payloads(value(await baseline.app.simRunEvents(baseId))).slice(1));
    // 新开的运行用改过的配置。
    expect(value(await first.app.startSimRun(first.scene.id, { mode: 'auto' })).run.sceneConfigVersion).toBe(2);
  });
});

describe('金丝雀：桌面端发出的角色请求（硬性规则 4）', () => {
  it('角色请求中不出现场景元信息、秘密与他人的角色卡', async () => {
    const ctx = await setup();
    value(await ctx.app.createWork('推演'));
    await addTestedModel(ctx.app, ctx.deps);
    const spec = canarySpec();
    const parsed = parseScene(spec);
    if (!parsed.ok) throw new Error('场景');
    let inspected = 0;
    ctx.useModel(
      inspectRequests(fakeModel(policy).port, (request) => {
        if (request.task !== 'character_action' && request.task !== 'belief_update') return;
        const call = contextOf(request);
        for (const marker of staticForbidden(parsed.value, call.subject as never)) {
          if (call.text.includes(marker)) throw new Error(`${call.subject} 的请求含有 ${marker}`);
        }
        inspected++;
      }),
    );
    const scene = value(await ctx.app.saveSimScene(null, sceneFields(spec as Record<string, unknown>)));
    const runId = value(await ctx.app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
    expect(value(await ctx.app.continueSimRun(runId))).toMatchObject({ phase: 'Ended' });
    expect(inspected).toBeGreaterThan(6);
  });
});

describe('经桌面端的模型适配器', () => {
  it('角色行动的请求经凭据代理发往默认模型的服务，回复经结构化输出管线进入事件', async () => {
    const ctx = await setup();
    value(await ctx.app.createWork('推演'));
    await addTestedModel(ctx.app, ctx.deps);
    const scene = value(await ctx.app.saveSimScene(null, sceneFields()));
    const runId = value(await ctx.app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
    ctx.deps.llmRequests.length = 0;
    // 两个角色各一次行动提案：都选择观望。
    const wait = JSON.stringify(waitProposal({ kind: 'wait' }));
    ctx.deps.llmResponses.push(reply(wait), reply(wait));
    let status = value(await ctx.app.stepSimRun(runId));
    for (let i = 0; i < 4 && ctx.deps.llmRequests.length < 2; i++) status = value(await ctx.app.stepSimRun(runId));

    expect(ctx.deps.llmRequests).toHaveLength(2);
    expect(ctx.deps.llmRequests.every((r) => r.url.startsWith('https://s.example.test/v1/'))).toBe(true);
    // 凭据由代理注入；占位值没有发到服务。
    expect(ctx.deps.llmRequests.every((r) => r.headers['authorization'] === 'Bearer sk-s')).toBe(true);
    const submitted = value(await ctx.app.simRunEvents(runId)).filter((e) => (e.payload as { type: string }).type === 'ProposalSubmitted');
    expect(submitted.map((e) => (e.payload as { actor: string }).actor).sort()).toEqual(['antagonist', 'protagonist']);
    expect(status.run.status).toBe('running');
    const usage = value(await ctx.app.usage());
    expect(usage.recent.map((c) => c.taskKind)).toEqual(['character_action', 'character_action']);
  });
});

describe('场景配置草稿（B39）', () => {
  const draft = sceneDraftFixture();

  it('由一段描述生成场景配置草稿：不保存；保存后可以开始推演', async () => {
    const { deps, app, useModel } = await ready();
    useModel(null);
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply(JSON.stringify(draft)));
    const result = value(await app.draftSimScene('雨夜，落魄书生林舟到钱四的当铺当玉。'));
    expect(result.problems).toEqual([]);
    expect(result.config.actors.map((a) => a.name)).toEqual(['林舟', '钱四']);
    expect(result.config.actors[1]?.card?.initialKnowledge?.[0]).toMatchObject({ order: 2, concerning: 'lin_zhou' });
    expect(JSON.stringify(deps.llmRequests[0]?.body)).toContain('雨夜，落魄书生林舟到钱四的当铺当玉。');
    // 草稿没有保存：场景列表里只有 ready 建的那一个。
    expect(value(await app.listSimScenes())).toHaveLength(1);

    const saved = value(await app.saveSimScene(null, { chapterId: null, title: '当铺', config: result.config, protocol: 'turn_based', maxRounds: 4, firstSpeaker: 'lin_zhou' }));
    useModel(fakeModel().port);
    expect(value(await app.startSimRun(saved.id, { mode: 'auto', seed: 1 }))).toMatchObject({ run: { status: 'running' } });
  });

  it('草稿里不对的地方列给作者；没有描述时不调用模型', async () => {
    const { deps, app, useModel } = await ready();
    useModel(null);
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply(JSON.stringify({ ...draft, actors: draft.actors.map((a, i) => (i === 1 ? { ...a, zone: 'cellar' } : a)) })));
    const result = value(await app.draftSimScene('当铺'));
    expect(result.problems).toEqual(['角色 第 2 项 › 所在区域：引用了场景里没有的“cellar”']);
    // 有问题的草稿不能保存，说明里写的是同样的话。
    expect(await app.saveSimScene(null, { chapterId: null, title: '当铺', config: result.config, protocol: 'turn_based', maxRounds: 4, firstSpeaker: null })).toMatchObject({
      ok: false,
      error: { code: 'settings', detail: expect.stringContaining('角色 第 2 项 › 所在区域：引用了场景里没有的“cellar”') },
    });
    expect(await app.draftSimScene('  ')).toMatchObject({ ok: false, error: { code: 'settings' } });
    expect(deps.llmRequests).toHaveLength(1);
  });
});

describe('推演工作区的数据（B28）', () => {
  it('按回合整理时间线：行动与内心片段、裁决、发生的事与感知、回合结束时的局面、每个角色当时所见；只读事件，不调用模型', async () => {
    const { app, scene, fake } = await ready();
    const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
    // 刚开始、还没有完成的回合。
    expect(value(await app.simRunDetail(runId))).toMatchObject({ view: { phase: 'BuildingViews' }, data: { rounds: [] }, timing: [] });
    value(await app.continueSimRun(runId));
    const before = fake.calls.length;
    const detail = value(await app.simRunDetail(runId));
    expect(fake.calls.length).toBe(before);

    expect(detail.view).toMatchObject({ phase: 'Ended', endReason: 'max_rounds', spentUsd: 0 });
    // 测试模型没有价格：每次调用的费用未知。
    expect(detail.view.unknownCostCalls).toBe(before);
    const data = detail.data!;
    expect(data).toMatchObject({ protocol: 'simultaneous', mode: 'auto', endReason: 'max_rounds' });
    expect(data.rounds.map((r) => r.round)).toEqual([1, 2, 3]);
    const first = data.rounds[0]!;
    expect(first.proposals.map((p) => [p.actor, p.kind])).toEqual([
      ['对手', 'attack'],
      ['主角', 'speak'],
    ]);
    expect(first.proposals.every((p) => p.innerThought !== null && p.innerThought !== '')).toBe(true);
    expect(first.rulings).toHaveLength(1);
    expect(first.rulings[0]).toMatchObject({ rationale: '弩箭擦过', by: 'auto' });
    expect(first.occurrences.length).toBeGreaterThan(0);
    expect(first.world.actors.find((a) => a.id === 'protagonist')).toMatchObject({ injury: 'severe' });
    // 每个角色各有自己的所见。
    expect(Object.keys(first.views).sort()).toEqual(['antagonist', 'protagonist']);
    expect(first.notes.some((n) => n.includes('缺少证据链'))).toBe(true);

    // 等待时间：每个回合一行，模型调用都归到所在的回合。
    expect(detail.timing.map((t) => t.round)).toEqual([1, 2, 3]);
    expect(detail.timing.every((t) => t.waitMs !== null && t.waitMs >= t.modelMs && t.calls > 0)).toBe(true);
    expect(detail.timing.reduce((n, t) => n + t.calls, 0)).toBe(before);
  });
});

describe('预算（B28）', () => {
  /** 给默认模型配上价格：每百万 Token 输入与输出各 1 美元。 */
  async function priced() {
    const ctx = await ready();
    const services = value(await ctx.app.loadModelServices());
    const model = services.models[0]!;
    value(await ctx.app.updateModel(model, { displayName: model.displayName, capabilities: model.capabilities, prices: { input: 1, output: 1 } }));
    return ctx;
  }

  it('默认模型没有价格时不能设预算；预算须大于 0', async () => {
    const { app, scene } = await ready();
    expect(await app.startSimRun(scene.id, { mode: 'auto', budgetUsd: 1 })).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('没有配置价格') } });
    const ctx = await priced();
    expect(await ctx.app.startSimRun(ctx.scene.id, { mode: 'auto', budgetUsd: 0 })).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('大于 0') } });
    expect(value(await ctx.app.listSimRuns(ctx.scene.id))).toEqual([]);
  });

  it('预算够用时跑到结束，已用的费用来自调用记录', async () => {
    const { app, scene, fake } = await priced();
    const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7, budgetUsd: 5 })).run.id;
    const ended = value(await app.continueSimRun(runId));
    expect(ended).toMatchObject({ phase: 'Ended', endReason: 'max_rounds', unknownCostCalls: 0, run: { budgetUsd: 5 } });
    // 测试模型每次调用 1,000 输入、200 输出 Token。
    expect(ended.spentUsd).toBeCloseTo((fake.calls.length * 1200) / 1_000_000, 9);
  });

  it('预计将超出预算时不再调用模型，运行以预算用完结束；单步推进时已用的费用接着算，不会因为换了引擎实例而清零', async () => {
    const { app, scene, fake } = await priced();
    // 一次调用按最坏情况估算约 0.005 美元（输入字数加 4,096 的输出上限）：0.02 美元只够几次调用。
    const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7, budgetUsd: 0.02 })).run.id;
    let view = value(await app.stepSimRun(runId));
    for (let i = 0; i < 200 && view.phase !== 'Ended'; i++) view = value(await app.stepSimRun(runId));
    expect(view).toMatchObject({ phase: 'Ended', endReason: 'budget', run: { status: 'ended', endReason: 'budget' } });
    expect(view.spentUsd).toBeLessThanOrEqual(0.02);
    expect(fake.calls.length).toBeGreaterThan(0);

    // 不设预算的同一场景要调用得多得多。
    const free = await ready();
    const freeId = value(await free.app.startSimRun(free.scene.id, { mode: 'auto', seed: 7 })).run.id;
    value(await free.app.continueSimRun(freeId));
    expect(fake.calls.length).toBeLessThan(free.fake.calls.length);
  });
});

describe('待核实裁决的确认（B26）', () => {
  /** 交互模式推进到第一条待核实的裁决。 */
  async function waiting() {
    const ctx = await ready();
    const runId = value(await ctx.app.startSimRun(ctx.scene.id, { mode: 'interactive', seed: 7 })).run.id;
    expect(value(await ctx.app.continueSimRun(runId))).toMatchObject({ phase: 'AwaitingAuthor', awaitingRulings: 1 });
    const detail = value(await ctx.app.simRunDetail(runId));
    return { ...ctx, runId, pending: detail.pendingRulings[0]!, detail };
  }

  it('列出待确认的裁决：理由、效果与发生的事写成文字，并给出可修改的内容；按原样接受后继续推进', async () => {
    const { app, runId, pending, detail } = await waiting();
    expect(detail.pendingRulings).toHaveLength(1);
    expect(pending).toMatchObject({ rationale: '弩箭擦过', effects: ['主角的伤势变为“重伤”'] });
    expect(pending.occurrences[0]).toContain('弩箭擦过主角肩头');
    expect(JSON.parse(pending.editable)).toMatchObject({ rationale: '弩箭擦过', effects: [{ type: 'setInjury', actor: 'protagonist', level: 'severe' }] });
    // 等待确认时记了快照，可以从这里分支。
    expect(detail.forkPoints.map((f) => f.label)).toEqual(['等待确认裁决时']);

    expect(value(await app.confirmSimRuling(runId, pending.requestId))).toMatchObject({ awaitingRulings: 0 });
    const after = value(await app.simRunDetail(runId));
    expect(after.pendingRulings).toEqual([]);
    const confirmed = value(await app.simRunEvents(runId)).map((e) => e.payload as { type: string; by?: string; needsReview?: boolean }).filter((p) => p.type === 'AdjudicationConfirmed');
    expect(confirmed).toMatchObject([{ by: 'author', needsReview: false }]);
    // 已确认的裁决不能再确认一次。
    expect(await app.confirmSimRuling(runId, pending.requestId)).toMatchObject({ ok: false, error: { code: 'settings' } });
  });

  it('作者改过的裁决经同样的转换与校验：改轻伤势生效；不是合法的 JSON、格式不对、超出裁决范围时拒绝，仍在等待', async () => {
    const { app, runId, pending } = await waiting();
    const edit = (change: (ruling: { effects: unknown[] }) => void) => {
      const ruling = JSON.parse(pending.editable) as { effects: unknown[] };
      change(ruling);
      return JSON.stringify(ruling);
    };
    expect(await app.confirmSimRuling(runId, pending.requestId, '{')).toMatchObject({ ok: false, error: { detail: expect.stringContaining('不是合法的 JSON') } });
    expect(await app.confirmSimRuling(runId, pending.requestId, '{"effects":[]}')).toMatchObject({ ok: false, error: { detail: expect.stringContaining('格式不对') } });
    // 裁决里出现了场景中没有的标记：不合规则。
    const outOfScope = edit((r) => r.effects.push({ type: 'setFlag', flag: 'no_such_flag', value: true }));
    expect(await app.confirmSimRuling(runId, pending.requestId, outOfScope)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('裁决不符合规则') } });
    expect(value(await app.simRunStatus(runId))).toMatchObject({ phase: 'AwaitingAuthor', awaitingRulings: 1 });

    const lighter = edit((r) => {
      r.effects = [{ type: 'setInjury', actor: 'protagonist', level: 'light' }];
    });
    value(await app.confirmSimRuling(runId, pending.requestId, lighter));
    value(await app.continueSimRun(runId));
    const first = value(await app.simRunDetail(runId)).data!.rounds[0]!;
    expect(first.world.actors.find((a) => a.id === 'protagonist')).toMatchObject({ injury: 'light' });
    expect(first.rulings[0]).toMatchObject({ by: 'author' });
  });

  it('没有等待决定的导演提议时，决定导演提议会说明现在不能做', async () => {
    const { app, runId } = await waiting();
    expect(await app.decideSimDirector(runId, true)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('现在这个阶段不能做这个操作') } });
  });
});

describe('作者介入与分支（B30）', () => {
  const types = (events: readonly { payload: unknown }[]) => events.map((e) => (e.payload as { type: string }).type);

  it('修改角色的认知：先记下介入前的快照，介入写成事件，角色此刻的认知随之变化；必须写原因', async () => {
    const { app, scene } = await ready();
    const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
    const before = value(await app.simRunDetail(runId));
    const add = [{ text: '有人在南门埋了绊线', modality: 'heard' as const, confidence: 0.6, about: ['south_gate'] }];
    expect(await app.interveneSimRun(runId, { kind: 'edit_knowledge', actor: 'protagonist', add, retract: [], reason: ' ' })).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('原因') } });
    expect(await app.interveneSimRun(runId, { kind: 'edit_knowledge', actor: '不是 键', add, retract: [], reason: '试试' })).toMatchObject({ ok: false, error: { code: 'settings' } });

    value(await app.interveneSimRun(runId, { kind: 'edit_knowledge', actor: 'protagonist', add, retract: [], reason: '让他提前听到风声' }));
    const after = value(await app.simRunDetail(runId));
    expect(after.knowledge['protagonist']?.map((k) => k.text)).toContain('有人在南门埋了绊线');
    expect(after.knowledge['protagonist']?.length).toBe((before.knowledge['protagonist']?.length ?? 0) + 1);
    expect(after.knowledge['antagonist']).toEqual(before.knowledge['antagonist']);
    expect(types(value(await app.simRunEvents(runId)))).toEqual(['RunStarted', 'AuthorIntervened', 'KnowledgeEdited']);
    expect(after.forkPoints).toEqual([{ seq: 1, round: 0, label: '作者介入之前' }]);

    // 撤回刚加的那一条。
    const added = after.knowledge['protagonist']!.find((k) => k.text === '有人在南门埋了绊线')!;
    value(await app.interveneSimRun(runId, { kind: 'edit_knowledge', actor: 'protagonist', add: [], retract: [added.id], reason: '改主意了' }));
    expect(value(await app.simRunDetail(runId)).knowledge['protagonist']?.map((k) => k.text)).not.toContain('有人在南门埋了绊线');
    // 介入之后照常推进到结束，回放与快照一致。
    expect(value(await app.continueSimRun(runId))).toMatchObject({ phase: 'Ended' });
    expect(value(await app.verifySimRun(runId)).mismatchedSeqs).toEqual([]);
  });

  it('两个回合之间加入外部事件：按感知规则分发，记在时间线里；回合进行中不能加', async () => {
    const { app, scene } = await ready();
    const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
    const event = { kind: 'external_event' as const, zone: 'center', visible: true, loudness: 3, visual: '一盏灯笼从梁上掉下来', sound: '哗啦一声', reason: '逼他们动起来' };
    value(await app.interveneSimRun(runId, event));
    expect(types(value(await app.simRunEvents(runId)))).toEqual(expect.arrayContaining(['AuthorIntervened', 'Committed', 'StateChanged']));

    // 推进到回合中途：外部事件加不进去。
    let view = value(await app.stepSimRun(runId));
    for (let i = 0; i < 10 && view.phase !== 'AwaitingProposals'; i++) view = value(await app.stepSimRun(runId));
    expect(view.phase).toBe('AwaitingProposals');
    expect(await app.interveneSimRun(runId, event)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('外部事件只能加在两个回合之间') } });

    value(await app.continueSimRun(runId));
    const first = value(await app.simRunDetail(runId)).data!.rounds[0]!;
    expect(first.occurrences.some((o) => o.visual === '一盏灯笼从梁上掉下来')).toBe(true);
    expect(first.notes).toContain('作者介入（external_event）：逼他们动起来');
  });

  it('替换一个角色的行动：这一回合不再向模型请求他的行动，其余照常', async () => {
    const { app, scene, fake } = await ready();
    const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
    let view = value(await app.stepSimRun(runId));
    for (let i = 0; i < 10 && view.phase !== 'AwaitingProposals'; i++) view = value(await app.stepSimRun(runId));
    const calls = fake.calls.length;
    value(await app.interveneSimRun(runId, { kind: 'replace_action', actor: 'antagonist', action: { kind: 'wait', sentences: ['我不动手。'], volume: 'normal' }, reason: '看看他不出手会怎样' }));
    // 不合规则的行动被拒绝。
    expect(await app.interveneSimRun(runId, { kind: 'replace_action', actor: 'antagonist', action: { kind: 'wait', sentences: [], volume: 'normal' }, reason: '再来一次' })).toMatchObject({ ok: false });

    value(await app.continueSimRun(runId));
    const first = value(await app.simRunDetail(runId)).data!.rounds[0]!;
    expect(first.proposals.find((p) => p.actor === '对手')).toMatchObject({ kind: 'wait', source: '作者替换', sentences: ['我不动手。'] });
    // 第一回合没有向模型问过对手的行动，也就没有那次出手与裁决。
    expect(fake.calls.slice(calls).some((c) => c.round === 1 && c.step === 'propose' && c.subject === 'antagonist')).toBe(false);
    expect(first.rulings).toEqual([]);
  });

  it('从介入前的快照分出新的推演：原来的运行不动，新的运行带着到那一刻为止的事件，可以走另一条路', async () => {
    const { app, scene } = await ready();
    const runId = value(await app.startSimRun(scene.id, { mode: 'auto', seed: 7 })).run.id;
    value(await app.stepSimRun(runId));
    const at = value(await app.simRunStatus(runId)).run.lastSeq;
    value(await app.interveneSimRun(runId, { kind: 'edit_knowledge', actor: 'protagonist', add: [{ text: '对手带着弩', modality: 'inferred', confidence: 0.5, about: ['antagonist'] }], retract: [], reason: '给他一点提示' }));
    value(await app.continueSimRun(runId));
    const original = value(await app.simRunEvents(runId));

    expect(await app.forkSimRun(runId, at + 1)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('快照') } });
    const fork = value(await app.forkSimRun(runId, at));
    expect(fork.run).toMatchObject({ parentRunId: runId, branchFromSeq: at, lastSeq: at, status: 'running', sceneConfigVersion: 1 });
    const copied = value(await app.simRunEvents(fork.run.id));
    expect(copied.map((e) => e.payload).slice(1)).toEqual(original.slice(1, at).map((e) => e.payload));
    expect(copied[0]?.payload).toMatchObject({ type: 'RunStarted', parent: { runId, seq: at } });

    // 分支上没有那次介入，照常推进到结束；原来的运行一条事件也没有变。
    expect(value(await app.continueSimRun(fork.run.id))).toMatchObject({ phase: 'Ended' });
    expect(types(value(await app.simRunEvents(fork.run.id)))).not.toContain('AuthorIntervened');
    expect(value(await app.simRunEvents(runId))).toEqual(original);
    expect(value(await app.listSimRuns(scene.id)).map((r) => r.id)).toEqual([fork.run.id, runId]);
    expect(value(await app.verifySimRun(fork.run.id)).mismatchedSeqs).toEqual([]);
  });
});

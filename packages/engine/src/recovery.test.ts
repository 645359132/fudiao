import { stateHash, type Scene } from '@fudiao/domain';
import { A, P, canaryScene, staticForbidden, warehouse } from '@fudiao/domain/testing';
import { inspectRequests, memoryCallLog, type CallLog, type LlmPort } from '@fudiao/llm';
import { memoryEventStore, type EventStore } from '@fudiao/store';
import { describe, expect, it } from 'vitest';
import type { RunConfig } from './config';
import { createEngine } from './engine';
import type { RunEvent } from './events';
import { contextOf, fakeModel, testConfig, waitProposal, type FakeOptions, type Policy } from './testing/fake-model';

const AT = '2026-10-07T00:00:00.000Z';

// 一组覆盖各个阶段的行为：裁决、观察与认知更新、推测与证据链判断。
const policy: Policy = {
  character_action: (ctx) => {
    if (ctx.subject === 'antagonist') {
      return ctx.round === 1 ? waitProposal({ kind: 'attack', target: 'protagonist', item: 'crossbow' }) : waitProposal({ kind: 'defend' });
    }
    return waitProposal({
      kind: ctx.round === 2 ? 'observe' : 'speak',
      ...(ctx.round !== 2 && { utterance: { sentences: ['你到底想要什么？'], volume: 'shout' as const } }),
      inferences: [{ content: '南门恐怕有埋伏', about: ['south_gate'], confidence: 0.5, concerning: null }],
    });
  },
  semantic_ruling: () => ({
    rationale: '弩箭擦过',
    effects: [{ type: 'setInjury', actor: 'protagonist', level: 'severe' }],
    occurrences: [{ participants: ['antagonist', 'protagonist'], zones: ['center'], visible: true, loudness: 2, visual: '弩箭擦过主角肩头', sound: null }],
    uncertainties: [],
  }),
  judgement: (ctx) => ({
    judgements: [...ctx.text.matchAll(/推测 \[([^\]]+)\] 对照秘密 \[([^\]]+)\]/g)].map((m) => ({
      inference: m[1] ?? '',
      secret: m[2] ?? '',
      hit: true,
      supported: false,
      explanation: '没有线索',
    })),
  }),
};

class Crash extends Error {}

/** 在第 n 次追加时崩溃：写入前或写入后。 */
function crashingStore(inner: EventStore, n: number, when: 'before' | 'after'): EventStore {
  let count = 0;
  return {
    ...inner,
    async append(runId, expectedSeq, payloads, at) {
      count++;
      if (count === n && when === 'before') throw new Crash(`第 ${n} 次追加前崩溃`);
      const result = await inner.append(runId, expectedSeq, payloads, at);
      if (count === n && when === 'after') throw new Crash(`第 ${n} 次追加后崩溃`);
      return result;
    },
    read: (runId) => inner.read(runId),
    runs: () => inner.runs(),
  };
}

/** 在第 n 次模型调用进行中崩溃：调用没有完成，也没有计费。 */
function crashingModel(inner: LlmPort, n: number): LlmPort {
  let count = 0;
  return {
    complete(request, options) {
      count++;
      if (count === n) return Promise.reject(new Crash(`第 ${n} 次调用中崩溃`));
      return inner.complete(request, options);
    },
  };
}

async function runAll(scene: Scene, config: RunConfig, store: EventStore, calls: CallLog, llm: LlmPort): Promise<void> {
  const engine = createEngine({ llm, events: store, calls, now: () => AT });
  if ((await store.read('run1')).length === 0) await engine.start('run1', scene, config);
  let result = await engine.run('run1', scene);
  // 截断、拒答等暂停后，作者点继续。
  while (result.ok && result.value.phase === 'Paused') {
    await engine.resume('run1', scene);
    result = await engine.run('run1', scene);
  }
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

/** 运行；崩溃时换一个新的引擎实例，从同一存储与调用记录恢复，直到结束。 */
async function runWithCrash(
  scene: Scene,
  config: RunConfig,
  wrap: { store?: (s: EventStore) => EventStore; llm?: (p: LlmPort) => LlmPort },
  use: Policy = policy,
  options: FakeOptions = {},
) {
  const store = memoryEventStore();
  const calls = memoryCallLog();
  const model = fakeModel(use, options);
  let crashed = false;
  try {
    await runAll(scene, config, wrap.store?.(store) ?? store, calls, wrap.llm?.(model.port) ?? model.port);
  } catch (error) {
    if (!(error instanceof Crash)) throw error;
    crashed = true;
    await runAll(scene, config, store, calls, model.port);
  }
  const events = (await store.read('run1')).map((e) => e.payload);
  return { events, crashed, completedCalls: calls.records().filter((r) => r.status === 'completed').length, modelCalls: model.calls.length };
}

describe('故障注入：任一阶段中断后恢复', () => {
  const scene = warehouse();
  const config = testConfig({ maxRounds: 3 });

  it('基线运行覆盖裁决、认知更新与证据链', async () => {
    const baseline = await runWithCrash(scene, config, {});
    const types = baseline.events.map((e) => (e as { type: string }).type);
    expect(types).toContain('AdjudicationConfirmed');
    expect(types).toContain('BeliefsUpdated');
    expect(types).toContain('EvidenceGapFlagged');
    expect(types.at(-1)).toBe('RunEnded');
  });

  it('在每一次事件追加前后崩溃：恢复后事件记录与不中断时完全一致，模型调用不重复', async () => {
    const baseline = await runWithCrash(scene, config, {});
    const appends = new Set(baseline.events.map((_, i) => i)).size; // 事件条数是追加次数的上界
    let crashes = 0;
    for (let n = 1; n <= appends; n++) {
      for (const when of ['before', 'after'] as const) {
        const result = await runWithCrash(scene, config, { store: (s) => crashingStore(s, n, when) });
        if (!result.crashed) continue;
        crashes++;
        expect(result.events, `第 ${n} 次追加${when === 'before' ? '前' : '后'}崩溃`).toEqual(baseline.events);
        expect(result.completedCalls).toBe(baseline.completedCalls);
        expect(result.modelCalls).toBe(baseline.modelCalls);
      }
    }
    expect(crashes).toBeGreaterThan(20);
  }, 60_000);

  it('在每一次模型调用中崩溃：恢复后只重做未完成的调用，结果一致', async () => {
    const baseline = await runWithCrash(scene, config, {});
    for (let n = 1; n <= baseline.modelCalls; n++) {
      const result = await runWithCrash(scene, config, { llm: (p) => crashingModel(p, n) });
      expect(result.crashed).toBe(true);
      expect(result.events, `第 ${n} 次调用中崩溃`).toEqual(baseline.events);
      expect(result.completedCalls).toBe(baseline.completedCalls);
    }
  }, 60_000);

  it('每回合恰好提交一次', async () => {
    const baseline = await runWithCrash(scene, config, {});
    const committed = baseline.events.filter((e) => (e as { type: string; origin?: string }).type === 'Committed');
    expect(committed).toHaveLength(3);
  });
});

describe('故障注入：开启僵局检测与导演', () => {
  const scene = warehouse();
  const model = testConfig().models.character_action;
  const config = testConfig({
    maxRounds: 4,
    stalemate: { enabled: true, window: 2 },
    director: { enabled: true, trigger: 'curve', tensionCurve: '第二轮后加压', maxProposals: 2 },
    models: { ...testConfig().models, stalemate: model, director: model },
  });
  const drama: Policy = {
    ...policy,
    stalemate: () => ({ type: 'polite_resolution', explanation: '客气寒暄' }),
    director: (ctx) =>
      ctx.round === 2
        ? {
            propose: true,
            rationale: '加压',
            event: { zone: 'center', visible: true, loudness: 3, visual: '风灯坠落', sound: '一声巨响', setFlags: [{ flag: 'office_open', value: true }] },
          }
        : { propose: false, rationale: '', event: null },
  };

  it('基线运行包含僵局与导演事件', async () => {
    const baseline = await runWithCrash(scene, config, {}, drama);
    const types = baseline.events.map((e) => (e as { type: string }).type);
    expect(types).toContain('StalemateDetected');
    expect(types).toContain('DirectorDecided');
    expect(baseline.events.some((e) => (e as { type: string; origin?: string }).origin === 'director')).toBe(true);
  });

  it('每一次追加前后与每一次调用中崩溃：恢复后记录一致，调用不重复', async () => {
    const baseline = await runWithCrash(scene, config, {}, drama);
    let crashes = 0;
    for (let n = 1; n <= baseline.events.length; n++) {
      for (const when of ['before', 'after'] as const) {
        const result = await runWithCrash(scene, config, { store: (s) => crashingStore(s, n, when) }, drama);
        if (!result.crashed) continue;
        crashes++;
        expect(result.events, `第 ${n} 次追加${when === 'before' ? '前' : '后'}崩溃`).toEqual(baseline.events);
        expect(result.modelCalls).toBe(baseline.modelCalls);
      }
    }
    expect(crashes).toBeGreaterThan(20);
    for (let n = 1; n <= baseline.modelCalls; n++) {
      const result = await runWithCrash(scene, config, { llm: (p) => crashingModel(p, n) }, drama);
      expect(result.events, `第 ${n} 次调用中崩溃`).toEqual(baseline.events);
      expect(result.completedCalls).toBe(baseline.completedCalls);
    }
  }, 120_000);
});

describe('故障注入：截断暂停、作者继续后重试', () => {
  const scene = warehouse();
  const config = testConfig({ maxRounds: 3 });
  // 第 1 回合的裁决、第 2 回合主角的认知更新各截断一次。
  const options: FakeOptions = {
    outcome: (ctx) =>
      ctx.redo === 0 && ((ctx.step === 'rule' && ctx.round === 1) || (ctx.step === 'beliefs' && ctx.round === 2 && ctx.subject === 'protagonist'))
        ? 'truncated'
        : undefined,
  };

  it('基线运行经过两次暂停与继续，跑完', async () => {
    const baseline = await runWithCrash(scene, config, {}, policy, options);
    const events = baseline.events as RunEvent[];
    expect(events.filter((e) => e.type === 'RunResumed')).toEqual([
      { type: 'RunResumed', retry: 'all' },
      { type: 'RunResumed', retry: P },
    ]);
    expect(events.at(-1)?.type).toBe('RunEnded');
  });

  it('每一次追加前后与每一次调用中崩溃：恢复后记录一致，调用不重复', async () => {
    const baseline = await runWithCrash(scene, config, {}, policy, options);
    let crashes = 0;
    for (let n = 1; n <= baseline.events.length; n++) {
      for (const when of ['before', 'after'] as const) {
        const result = await runWithCrash(scene, config, { store: (s) => crashingStore(s, n, when) }, policy, options);
        if (!result.crashed) continue;
        crashes++;
        expect(result.events, `第 ${n} 次追加${when === 'before' ? '前' : '后'}崩溃`).toEqual(baseline.events);
        expect(result.modelCalls).toBe(baseline.modelCalls);
      }
    }
    expect(crashes).toBeGreaterThan(20);
    for (let n = 1; n <= baseline.modelCalls; n++) {
      const result = await runWithCrash(scene, config, { llm: (p) => crashingModel(p, n) }, policy, options);
      expect(result.events, `第 ${n} 次调用中崩溃`).toEqual(baseline.events);
      expect(result.completedCalls).toBe(baseline.completedCalls);
    }
  }, 120_000);
});

describe('金丝雀：引擎发出的角色请求', () => {
  it('轮流对话：听不到的耳语与被打断后没说出口的句子不进入其他角色的任何后续请求与认知', async () => {
    const WHISPER = 'CANARY-WHISPER';
    const MARK = 'CANARY-UNSAID';
    const store = memoryEventStore();
    const model = fakeModel({
      character_action: (ctx) => {
        if (ctx.subject === 'protagonist') {
          return ctx.round === 1
            ? waitProposal({ kind: 'speak', utterance: { sentences: [`${WHISPER}在梁上。`], volume: 'whisper' } })
            : waitProposal({ kind: 'speak', utterance: { sentences: ['你先听我说。', `${MARK}-没说出口。`], volume: 'shout' } });
        }
        // 对手一开口就打断；回应里的内心片段提到了后面的句子，也必须作废。
        return waitProposal({ kind: 'speak', interruptAfter: 1, innerThought: ctx.text.includes(`${MARK}-没说出口`) ? `${MARK}-想到了` : '', utterance: { sentences: ['住口。'], volume: 'shout' } });
      },
    });
    const seen: { subject: string; round: number; step: string; text: string }[] = [];
    const llm = inspectRequests(model.port, (request) => {
      const ctx = contextOf(request);
      seen.push({ subject: ctx.subject, round: ctx.round, step: ctx.step, text: ctx.text });
    });
    const engine = createEngine({ llm, events: store, calls: memoryCallLog(), now: () => AT });
    // 对手在南门，与主角隔一个区域：耳语听不到，喊话听得清。
    const scene = warehouse();
    await engine.start('run1', scene, testConfig({ protocol: 'turn_based', maxRounds: 4, firstSpeaker: P }));
    const done = await engine.run('run1', scene);
    expect(done.ok && done.value.phase).toBe('Ended');

    const toAntagonist = seen.filter((c) => c.subject === 'antagonist');
    expect(toAntagonist.length).toBeGreaterThan(2);
    for (const c of toAntagonist) {
      expect(c.text, `${c.round}:${c.step}`).not.toContain(WHISPER);
      // 唯一的例外是听者决定打断点的那一次回应请求（作者确认的“一次决策”），它的结果在被打断后作废。
      if (c.step !== 'respond') expect(c.text, `${c.round}:${c.step}`).not.toContain(MARK);
    }
    expect(toAntagonist.some((c) => c.step === 'respond')).toBe(true);
    if (!done.ok) return;
    expect(JSON.stringify(done.value.state.sim.knowledge[A])).not.toContain(MARK);
    expect(JSON.stringify(done.value.state.sim.knowledge[A])).not.toContain(WHISPER);
    // 作废的回应不会成为行动，内心片段不会出现在用上的提案里。
    const used = (await store.read('run1')).map((e) => e.payload as RunEvent).filter((e) => e.type === 'ProposalSubmitted' && e.forRound === e.round);
    expect(JSON.stringify(used)).not.toContain(MARK + '-想到了');
  });


  it('角色请求中不出现场景元信息、秘密与他人的角色卡', async () => {
    const scene = canaryScene();
    const store = memoryEventStore();
    const model = fakeModel(policy);
    let inspected = 0;
    const llm = inspectRequests(model.port, (request) => {
      if (request.task !== 'character_action' && request.task !== 'belief_update') return;
      const ctx = contextOf(request);
      const text = ctx.text;
      for (const marker of staticForbidden(scene, ctx.subject as never)) {
        if (text.includes(marker)) throw new Error(`${ctx.subject} 的请求含有 ${marker}`);
      }
      inspected++;
    });
    const engine = createEngine({ llm, events: store, calls: memoryCallLog(), now: () => AT });
    await engine.start('run1', scene, testConfig({ maxRounds: 3 }));
    const result = await engine.run('run1', scene);
    expect(result.ok && result.value.phase).toBe('Ended');
    expect(inspected).toBeGreaterThan(6);
  });

  it('同一组提案与不同的到达顺序得到相同的最终状态', async () => {
    const scene = warehouse();
    const a = await runWithCrash(scene, testConfig({ maxRounds: 2 }), {});
    const store = memoryEventStore();
    const delayed = fakeModel(policy, { delay: (ctx) => (ctx.subject === 'protagonist' ? 20 : 0) });
    const engine = createEngine({ llm: delayed.port, events: store, calls: memoryCallLog(), now: () => AT });
    await engine.start('run1', scene, testConfig({ maxRounds: 2 }));
    const done = await engine.run('run1', scene);
    expect((await store.read('run1')).map((e) => e.payload)).toEqual(a.events);
    expect(done.ok && stateHash(done.value.state.sim)).toBeTruthy();
  });
});

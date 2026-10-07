import { stateHash, type Scene } from '@novel-writer/domain';
import { canaryScene, staticForbidden, warehouse } from '@novel-writer/domain/testing';
import { inspectRequests, memoryCallLog, type CallLog, type LlmPort } from '@novel-writer/llm';
import { memoryEventStore, type EventStore } from '@novel-writer/store';
import { describe, expect, it } from 'vitest';
import type { RunConfig } from './config';
import { createEngine } from './engine';
import { contextOf, fakeModel, testConfig, waitProposal, type Policy } from './testing/fake-model';

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
    judgements: [...ctx.text.matchAll(/推测 \[([^\]]+)\]/g)].map((m) => ({ inference: m[1] ?? '', hit: true, supported: false, explanation: '没有线索' })),
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
  const result = await engine.run('run1', scene);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

/** 运行；崩溃时换一个新的引擎实例，从同一存储与调用记录恢复，直到结束。 */
async function runWithCrash(scene: Scene, config: RunConfig, wrap: { store?: (s: EventStore) => EventStore; llm?: (p: LlmPort) => LlmPort }) {
  const store = memoryEventStore();
  const calls = memoryCallLog();
  const model = fakeModel(policy);
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

describe('金丝雀：引擎发出的角色请求', () => {
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

import { buildCharacterView, type Scene } from '@fudiao/domain';
import { A, P, warehouse } from '@fudiao/domain/testing';
import { memoryCallLog } from '@fudiao/llm';
import { canonicalJson, sha256 } from '@fudiao/shared';
import { memoryEventStore } from '@fudiao/store';
import { describe, expect, it } from 'vitest';
import type { RunConfig } from './config';
import { createEngine } from './engine';
import type { RunEvent } from './events';
import { fakeModel, testConfig, waitProposal, type FakeOptions, type Policy } from './testing/fake-model';

// 暂停后作者点“继续”：截断、拒答、输出不合格不再复用同一失败结果；暂停时已完成的结果不丢；
// 作者改认知后继续不会 step_conflict；证据链恢复不重复写入；多条裁决的恢复不卡死。

const AT = '2026-10-07T00:00:00.000Z';

function setup(policy: Policy, options: FakeOptions = {}) {
  const store = memoryEventStore();
  const calls = memoryCallLog();
  const model = fakeModel(policy, options);
  const engine = createEngine({ llm: model.port, events: store, calls, now: () => AT });
  const events = async () => (await store.read('run1')).map((e) => e.payload as RunEvent);
  return { store, calls, model, engine, events };
}

const ofType = <T extends RunEvent['type']>(events: readonly RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

async function start(s: ReturnType<typeof setup>, scene: Scene, config: RunConfig) {
  await s.engine.start('run1', scene, config);
  const result = await s.engine.run('run1', scene);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** 作者点继续：恢复并推进到下一次停下。 */
async function resume(s: ReturnType<typeof setup>, scene: Scene) {
  const resumed = await s.engine.resume('run1', scene);
  if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
  const result = await s.engine.run('run1', scene);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const scene = warehouse();
// 两人各做一件交给语义裁决的事，互不指向：一回合两条裁决请求 1:r0（对手）、1:r1（主角）。
const twoRulings: Policy = {
  character_action: (ctx) => (ctx.round === 1 ? waitProposal({ kind: 'other', description: `${ctx.subject}在原地比划` }) : waitProposal()),
  semantic_ruling: () => ({ rationale: '无事发生', effects: [], occurrences: [], uncertainties: [] }),
};
const truncateOnce = (step: string, subject: string): FakeOptions => ({
  outcome: (ctx) => (ctx.step === step && ctx.subject === subject && ctx.redo === 0 ? 'truncated' : undefined),
});

describe('多条语义裁决：后一条暂停后恢复', () => {
  for (const failing of ['1:r0', '1:r1']) {
    it(`自动模式：${failing} 截断暂停，继续后补上这一条再提交，不卡在 missing_ruling`, async () => {
      const s = setup(twoRulings, truncateOnce('rule', failing));
      const paused = await start(s, scene, testConfig({ maxRounds: 1 }));
      expect(paused.state.pause).toMatchObject({ reason: 'truncated' });
      // 没出问题的那一条已经写入，不丢。
      expect(ofType(await s.events(), 'AdjudicationConfirmed').map((e) => e.requestId)).toEqual([failing === '1:r0' ? '1:r1' : '1:r0']);

      const done = await resume(s, scene);
      expect(done.phase).toBe('Ended');
      const events = await s.events();
      expect(ofType(events, 'AdjudicationConfirmed').map((e) => e.requestId).sort()).toEqual(['1:r0', '1:r1']);
      expect(ofType(events, 'Committed')).toHaveLength(1);
      // 成功的那一条只调用过一次；失败的那一条换了步骤键重新调用。
      const rule = s.model.calls.filter((c) => c.step === 'rule');
      expect(rule.map((c) => `${c.subject}/${c.redo}`).sort()).toEqual([...['1:r0/0', '1:r1/0'], `${failing}/1`].sort());
    });
  }

  it('交互模式：确认了先提出的一条之后，回到裁决阶段补问后一条', async () => {
    const s = setup(twoRulings, truncateOnce('rule', '1:r1'));
    await start(s, scene, testConfig({ maxRounds: 1, mode: 'interactive' }));
    const waiting = await resume(s, scene);
    expect(waiting.phase).toBe('AwaitingAuthor');
    expect(waiting.awaiting.map((r) => r.requestId)).toEqual(['1:r0']);
    const confirmed = await s.engine.confirmRuling('run1', scene, '1:r0');
    expect(confirmed.ok && confirmed.value.phase).toBe('Adjudicating');
    const second = await s.engine.run('run1', scene);
    expect(second.ok && second.value.awaiting.map((r) => r.requestId)).toEqual(['1:r1']);
    await s.engine.confirmRuling('run1', scene, '1:r1');
    const done = await s.engine.run('run1', scene);
    expect(done.ok && done.value.phase).toBe('Ended');
  });
});

// 两人互相喊话：各自听到对方，都需要认知更新。
const shouting: Policy = {
  character_action: (ctx) =>
    ctx.round === 1 ? waitProposal({ kind: 'speak', utterance: { sentences: [`${ctx.subject}在此。`], volume: 'shout' } }) : waitProposal(),
};

describe('截断、拒答、输出不合格后继续', () => {
  for (const ended of ['truncated', 'refused'] as const) {
    it(`认知更新${ended === 'truncated' ? '截断' : '拒答'}后继续：换步骤键重新调用，不复用失败结果`, async () => {
      const s = setup(shouting, { outcome: (ctx) => (ctx.step === 'beliefs' && ctx.subject === 'protagonist' && ctx.redo === 0 ? ended : undefined) });
      const paused = await start(s, scene, testConfig({ maxRounds: 1 }));
      expect(paused.state.pause).toMatchObject({ reason: ended, actor: P });
      const done = await resume(s, scene);
      expect(done.phase).toBe('Ended');
      expect(ofType(await s.events(), 'RunResumed')).toEqual([{ type: 'RunResumed', retry: P }]);
      const beliefs = s.model.calls.filter((c) => c.step === 'beliefs').map((c) => `${c.subject}/${c.redo}`);
      expect(beliefs.sort()).toEqual(['antagonist/0', 'protagonist/0', 'protagonist/1']);
    });
  }

  it('输出不合格（修正次数用完）后继续：重新调用', async () => {
    const s = setup({
      ...shouting,
      // 第一次（含修正）都给出不合格的输出。
      belief_update: (ctx) => {
        if (ctx.subject === 'protagonist' && ctx.redo === 0) return { add: 'oops' } as never;
        return { add: [], revise: [], retract: [] };
      },
    });
    const paused = await start(s, scene, testConfig({ maxRounds: 1 }));
    expect(paused.state.pause).toMatchObject({ reason: 'invalid_output', actor: P });
    const done = await resume(s, scene);
    expect(done.phase).toBe('Ended');
  });

  it('作者手动暂停后继续不换步骤键', async () => {
    const s = setup(shouting);
    await s.engine.start('run1', scene, testConfig({ maxRounds: 1 }));
    await s.engine.step('run1', scene);
    await s.engine.pause('run1', scene);
    await resume(s, scene);
    expect(ofType(await s.events(), 'RunResumed')).toEqual([{ type: 'RunResumed' }]);
    expect(s.model.calls.every((c) => c.redo === 0)).toBe(true);
  });
});

describe('暂停时不丢已完成的结果；改认知后继续', () => {
  it('一人的认知更新失败时，另一人已完成的结果照常写入', async () => {
    const s = setup(shouting, truncateOnce('beliefs', 'antagonist'));
    const paused = await start(s, scene, testConfig({ maxRounds: 1 }));
    expect(paused.state.pause).toMatchObject({ reason: 'truncated', actor: A });
    expect(ofType(await s.events(), 'BeliefsReviewed').map((e) => e.actor)).toEqual([P]);
  });

  it('暂停后修改另一人的认知再继续：不会 step_conflict', async () => {
    const s = setup(shouting, truncateOnce('beliefs', 'antagonist'));
    await start(s, scene, testConfig({ maxRounds: 1 }));
    const edited = await s.engine.intervene('run1', scene, {
      kind: 'edit_knowledge',
      actor: P,
      add: [{ text: '对手的嗓子是哑的', modality: 'observed', confidence: 1, about: ['antagonist'] }],
      retract: [],
      reason: '补一条观察',
    });
    expect(edited.ok).toBe(true);
    const done = await resume(s, scene);
    expect(done.phase).toBe('Ended');
    expect(ofType(await s.events(), 'RunPaused').map((e) => e.detail ?? e.reason)).toEqual(['truncated']);
  });

  it('取消后修改已完成调用的那个人的认知再继续：重新调用，不会 step_conflict', async () => {
    const s = setup({}, { delay: (ctx) => (ctx.subject === 'protagonist' ? 30 : 0) });
    await s.engine.start('run1', scene, testConfig({ maxRounds: 1 }));
    await s.engine.step('run1', scene);
    const controller = new AbortController();
    const stepping = s.engine.step('run1', scene, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const cancelled = await stepping;
    expect(cancelled.ok && cancelled.value.phase).toBe('AwaitingProposals');
    expect(s.calls.records().filter((r) => r.status === 'completed').map((r) => r.stepKey)).toEqual(['run1:1:propose:antagonist:0']);

    const edited = await s.engine.intervene('run1', scene, {
      kind: 'edit_knowledge',
      actor: A,
      add: [{ text: '主角的刀在左手', modality: 'observed', confidence: 1, about: ['protagonist'] }],
      retract: [],
      reason: '补一条观察',
    });
    expect(edited.ok).toBe(true);
    const done = await s.engine.run('run1', scene);
    expect(done.ok && done.value.phase).toBe('Ended');
    expect(ofType(await s.events(), 'RunPaused')).toEqual([]);
    expect(s.model.calls.filter((c) => c.subject === 'antagonist' && c.step === 'propose').map((c) => c.redo)).toEqual([0, 1]);
  });

  it('回合内改认知后，ViewBuilt 记下改后视图的哈希', async () => {
    const s = setup({});
    await s.engine.start('run1', scene, testConfig({ maxRounds: 1 }));
    await s.engine.step('run1', scene);
    const edited = await s.engine.intervene('run1', scene, {
      kind: 'edit_knowledge',
      actor: P,
      add: [{ text: '南门有人', modality: 'heard', confidence: 0.5, about: ['south_gate'] }],
      retract: [],
      reason: '补一条听闻',
    });
    if (!edited.ok) throw new Error(JSON.stringify(edited.error));
    const built = ofType(await s.events(), 'ViewBuilt').filter((e) => e.actor === P);
    expect(built).toHaveLength(2);
    expect(built.at(-1)?.viewHash).toBe(sha256(canonicalJson(buildCharacterView(scene, edited.value.state.sim, P))));
  });
});

describe('证据链中途停下后恢复', () => {
  // 两人都不知道的秘密，两人都推测到了：两次证据链判断。
  const shared = warehouse((sc) => {
    sc.secrets!.push({ id: 'gate_watch', text: '巡夜人今晚不走南门', subjects: ['south_gate'], knownBy: [] });
  });
  const policy: Policy = {
    character_action: () => waitProposal({ inferences: [{ content: '南门有古怪', about: ['south_gate'], confidence: 0.6, concerning: null }] }),
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

  it('后一人的判断截断：继续后命中不重复写入，前一人的判断不重复调用', async () => {
    const s = setup(policy, truncateOnce('evidence', 'protagonist'));
    const paused = await start(s, shared, testConfig({ maxRounds: 1 }));
    expect(paused.state.pause).toMatchObject({ reason: 'truncated', actor: P });
    const done = await resume(s, shared);
    expect(done.phase).toBe('Ended');
    const flagged = ofType(await s.events(), 'EvidenceGapFlagged').map((e) => `${e.actor}/${e.secret}`);
    expect(flagged).toEqual([...new Set(flagged)]);
    expect(flagged.filter((f) => f.startsWith('antagonist/'))).toEqual(['antagonist/gate_watch']);
    expect(s.model.calls.filter((c) => c.step === 'evidence' && c.subject === 'antagonist')).toHaveLength(1);
  });
});

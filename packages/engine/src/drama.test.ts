import type { Scene } from '@novel-writer/domain';
import { CANARY, canaryScene, warehouse } from '@novel-writer/domain/testing';
import { inspectRequests, memoryCallLog, type LlmRequest } from '@novel-writer/llm';
import type { DirectorProposalOutput } from '@novel-writer/prompts';
import { memoryEventStore } from '@novel-writer/store';
import { describe, expect, it } from 'vitest';
import type { RunConfig } from './config';
import { createEngine } from './engine';
import type { RunEvent } from './events';
import { contextOf, fakeModel, testConfig, waitProposal, type Policy } from './testing/fake-model';

const AT = '2026-10-07T00:00:00.000Z';
const model = testConfig().models.character_action;

function setup(policy: Policy = {}, inspect?: (request: LlmRequest) => void) {
  const store = memoryEventStore();
  const fake = fakeModel(policy);
  const llm = inspect ? inspectRequests(fake.port, inspect) : fake.port;
  const engine = createEngine({ llm, events: store, calls: memoryCallLog(), now: () => AT });
  const events = async () => (await store.read('run1')).map((e) => e.payload as RunEvent);
  return { engine, events, calls: fake.calls };
}

async function start(s: ReturnType<typeof setup>, scene: Scene, config: RunConfig) {
  const started = await s.engine.start('run1', scene, config);
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const result = await s.engine.run('run1', scene);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const ofType = <T extends RunEvent['type']>(events: readonly RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

const stalemateConfig = (overrides: Partial<RunConfig> = {}) =>
  testConfig({ maxRounds: 5, stalemate: { enabled: true, window: 3 }, models: { ...testConfig().models, stalemate: model }, ...overrides });

/** 主角每回合说不同的话，对手等待：世界状态不变但有对话。 */
const talking: Policy = {
  character_action: (ctx) =>
    ctx.subject === 'protagonist'
      ? waitProposal({ kind: 'speak', target: 'antagonist', utterance: { sentences: [`第${ctx.round}句：好说好商量。`], volume: 'normal' } })
      : waitProposal(),
};

const tilesNoise: DirectorProposalOutput = {
  propose: true,
  rationale: '局面停滞，需要外部压力',
  event: {
    zone: 'center',
    visible: true,
    loudness: 4,
    visual: '一盏风灯从梁上坠落',
    sound: '哐当一声巨响',
    setFlags: [
      { flag: 'office_open', value: true },
      { flag: 'undeclared_flag', value: true },
    ],
  },
};

describe('僵局分类', () => {
  const scene = warehouse();

  it('双方观望：窗口内只有等待且世界状态不变；检测后窗口重新计数', async () => {
    const s = setup();
    const result = await start(s, scene, stalemateConfig({ maxRounds: 6 }));
    expect(result.phase).toBe('Ended');
    expect(result.state.endReason).toBe('max_rounds');
    const found = ofType(await s.events(), 'StalemateDetected');
    expect(found.map((e) => [e.round, e.kind])).toEqual([
      [3, 'standoff'],
      [6, 'standoff'],
    ]);
    // 程序判定的类型不调用模型。
    expect(s.calls.filter((c) => c.step === 'stalemate')).toHaveLength(0);
  });

  it('世界状态有变化时不算观望', async () => {
    const s = setup({
      character_action: (ctx) =>
        ctx.subject === 'protagonist' ? waitProposal({ kind: 'move', toZone: ctx.round % 2 === 1 ? 'shelves' : 'center' }) : waitProposal(),
    });
    await start(s, scene, stalemateConfig());
    expect(ofType(await s.events(), 'StalemateDetected')).toEqual([]);
  });

  it('重复相同动作：同一个人每回合说同样的话', async () => {
    const s = setup({
      character_action: (ctx) =>
        ctx.subject === 'protagonist'
          ? waitProposal({ kind: 'speak', target: 'antagonist', utterance: { sentences: ['把信交出来。'], volume: 'normal' } })
          : waitProposal(),
    });
    await start(s, scene, stalemateConfig({ maxRounds: 3 }));
    expect(ofType(await s.events(), 'StalemateDetected').map((e) => e.kind)).toEqual(['repetition']);
  });

  it('有对话但内容不同时不算重复，交给僵局判断；判断为礼貌化解时记录并继续', async () => {
    const s = setup({ ...talking, stalemate: () => ({ type: 'polite_resolution', explanation: '两人客气寒暄' }) });
    const result = await start(s, scene, stalemateConfig({ maxRounds: 4 }));
    expect(result.state.endReason).toBe('max_rounds');
    const found = ofType(await s.events(), 'StalemateDetected');
    expect(found.map((e) => [e.round, e.kind, e.explanation])).toEqual([[3, 'polite_resolution', '两人客气寒暄']]);
    expect(s.calls.filter((c) => c.step === 'stalemate').map((c) => c.round)).toEqual([3]);
  });

  it('判断为没有僵局时每回合按窗口继续判断', async () => {
    const s = setup(talking);
    await start(s, scene, stalemateConfig());
    expect(ofType(await s.events(), 'StalemateDetected')).toEqual([]);
    expect(s.calls.filter((c) => c.step === 'stalemate').map((c) => c.round)).toEqual([3, 4, 5]);
  });

  it('未配置僵局判断的模型时只做程序判定', async () => {
    const s = setup(talking);
    await start(s, scene, stalemateConfig({ models: testConfig().models }));
    expect(ofType(await s.events(), 'StalemateDetected')).toEqual([]);
    expect(s.calls.filter((c) => c.step === 'stalemate')).toHaveLength(0);
  });

  it('自动模式下目标已无法达成时以僵局结束', async () => {
    const s = setup({ ...talking, stalemate: () => ({ type: 'goal_unreachable', explanation: '密信已经烧毁' }) });
    const result = await start(s, scene, stalemateConfig());
    expect(result.phase).toBe('Ended');
    expect(result.state.endReason).toBe('stalemate');
    expect(result.state.sim.round).toBe(3);
  });

  it('交互模式检测到僵局时暂停，作者可以继续', async () => {
    const s = setup();
    const paused = await start(s, scene, stalemateConfig({ mode: 'interactive' }));
    expect(paused.phase).toBe('Paused');
    expect(paused.state.pause).toEqual({ reason: 'stalemate', detail: 'standoff' });
    expect(paused.state.sim.round).toBe(3);
    await s.engine.resume('run1', scene);
    const done = await s.engine.run('run1', scene);
    expect(done.ok && done.value.state.endReason).toBe('max_rounds');
  });
});

describe('导演提议', () => {
  const scene = warehouse();
  const director = (overrides: Partial<RunConfig['director']> = {}, config: Partial<RunConfig> = {}) =>
    testConfig({
      maxRounds: 3,
      director: { enabled: true, trigger: 'curve', tensionCurve: '前两轮蓄势，第三轮爆发', maxProposals: 3, ...overrides },
      models: { ...testConfig().models, director: model },
      ...config,
    });

  it('按张力曲线在每个回合边界询问；导演可以不提议', async () => {
    const s = setup();
    const result = await start(s, scene, director());
    expect(result.state.endReason).toBe('max_rounds');
    const events = await s.events();
    // 最后一回合之后不再询问。
    expect(s.calls.filter((c) => c.step === 'director').map((c) => c.round)).toEqual([1, 2]);
    expect(ofType(events, 'DirectorDecided').map((e) => [e.accepted, e.by])).toEqual([
      [false, 'auto'],
      [false, 'auto'],
    ]);
    expect(ofType(events, 'Committed').filter((e) => e.origin === 'director')).toEqual([]);
  });

  it('自动模式采用提议：只设置已声明的标记，事件按感知规则分发并标记来源', async () => {
    const s = setup({ director: (ctx) => (ctx.round === 1 ? tilesNoise : { propose: false, rationale: '', event: null }) });
    const result = await start(s, scene, director());
    expect(result.state.sim.world.flags).toEqual({ office_open: true });
    const events = await s.events();
    const committedAt = events.findIndex((e) => e.type === 'Committed' && e.origin === 'director');
    expect(committedAt).toBeGreaterThan(0);
    expect(events[committedAt - 1]).toEqual({ type: 'DirectorDecided', round: 1, accepted: true, by: 'auto' });
    const changed = events[committedAt + 1];
    expect(changed?.type === 'StateChanged' && changed.effects).toEqual([{ type: 'setFlag', flag: 'office_open', value: true }]);
    const heard = ofType(events.slice(committedAt), 'PerceptionDelivered').filter((e) => e.observations.length > 0);
    expect(heard.length).toBeGreaterThan(0);
    // 导演事件在回合之间注入，角色在下一回合的视图中看到。
    expect(ofType(events.slice(committedAt), 'RoundStarted')[0]?.round).toBe(2);
  });

  it('达到提议次数上限后不再询问', async () => {
    const s = setup({ director: () => tilesNoise });
    await start(s, scene, director({ maxProposals: 1 }, { maxRounds: 4 }));
    expect(s.calls.filter((c) => c.step === 'director').map((c) => c.round)).toEqual([1]);
  });

  it('区域不存在的提议视为没有提议', async () => {
    const s = setup({ director: () => ({ ...tilesNoise, event: tilesNoise.event && { ...tilesNoise.event, zone: 'nowhere' } }) });
    const result = await start(s, scene, director());
    expect(result.state.sim.world.flags).toEqual({ office_open: false });
    expect(ofType(await s.events(), 'DirectorProposed').every((e) => e.event === null)).toBe(true);
  });

  it('只在僵局后询问（stalemate 触发）', async () => {
    const s = setup({ director: () => tilesNoise });
    await start(s, scene, director({ trigger: 'stalemate' }, { maxRounds: 5, stalemate: { enabled: true, window: 3 } }));
    expect(s.calls.filter((c) => c.step === 'director').map((c) => c.round)).toEqual([3]);
    const request = s.calls.find((c) => c.step === 'director');
    expect(request?.text).toContain('观望');
  });

  it('交互模式等待作者；拒绝时不改变局面，采用时注入', async () => {
    const s = setup({ director: () => tilesNoise });
    const waiting = await start(s, scene, director({}, { mode: 'interactive' }));
    expect(waiting.phase).toBe('AwaitingAuthor');
    expect(waiting.awaitingDirector?.rationale).toBe('局面停滞，需要外部压力');

    const rejected = await s.engine.decideDirector('run1', scene, false);
    expect(rejected.ok && rejected.value.state.sim.world.flags).toEqual({ office_open: false });
    const next = await s.engine.run('run1', scene);
    expect(next.ok && next.value.phase).toBe('AwaitingAuthor');
    expect(next.ok && next.value.state.sim.round).toBe(2);

    const accepted = await s.engine.decideDirector('run1', scene, true);
    expect(accepted.ok && accepted.value.state.sim.world.flags).toEqual({ office_open: true });
    const events = await s.events();
    expect(ofType(events, 'DirectorDecided').map((e) => [e.round, e.accepted, e.by])).toEqual([
      [1, false, 'author'],
      [2, true, 'author'],
    ]);
    expect(ofType(events, 'Committed').filter((e) => e.origin === 'director').map((e) => e.round)).toEqual([2]);
    // 已经决定的提议不能再决定一次。
    expect((await s.engine.decideDirector('run1', scene, true)).ok).toBe(false);
  });
});

describe('金丝雀：导演与僵局判断的请求', () => {
  it('不含角色的认知、内心片段、秘密与场景元信息；僵局判断只读当前目标', async () => {
    const scene = canaryScene();
    const inner = `${CANARY}-INNER`;
    let director = 0;
    let stalemate = 0;
    const s = setup(
      {
        character_action: (ctx) =>
          waitProposal({
            kind: 'speak',
            target: ctx.subject === 'protagonist' ? 'antagonist' : 'protagonist',
            utterance: { sentences: [`第${ctx.round}回合`], volume: 'normal' },
            innerThought: inner,
            intent: inner,
            rationale: inner,
          }),
      },
      (request) => {
        const ctx = contextOf(request);
        if (ctx.step !== 'director' && ctx.step !== 'stalemate') return;
        const allowed = ctx.step === 'stalemate' ? /CANARY-CARD-[a-z]+-goal/g : null;
        const text = allowed ? ctx.text.replace(allowed, '') : ctx.text;
        for (const marker of [inner, `${CANARY}-META-`, `${CANARY}-SECRET-`, `${CANARY}-CARD-`, `${CANARY}-MECH-`]) {
          if (text.includes(marker)) throw new Error(`${ctx.step} 请求含有 ${marker}`);
        }
        // 确认检查的是实际内容：导演读得到全局局面，僵局判断读得到目标。
        if (ctx.step === 'director') {
          expect(ctx.text).toContain('仓库中央');
          director++;
        } else {
          expect(ctx.text).toContain(`${CANARY}-CARD-protagonist-goal`);
          stalemate++;
        }
      },
    );
    const result = await start(
      s,
      scene,
      testConfig({
        maxRounds: 4,
        stalemate: { enabled: true, window: 2 },
        director: { enabled: true, trigger: 'curve', tensionCurve: '', maxProposals: 3 },
        models: { ...testConfig().models, stalemate: model, director: model },
      }),
    );
    expect(result.phase).toBe('Ended');
    expect(director).toBe(3);
    expect(stalemate).toBeGreaterThan(0);
  });
});

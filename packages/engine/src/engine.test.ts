import { stateHash, type Scene } from '@fudiao/domain';
import { A, P, item, warehouse, zone } from '@fudiao/domain/testing';
import { BudgetGuard, memoryCallLog } from '@fudiao/llm';
import { memoryEventStore } from '@fudiao/store';
import { describe, expect, it } from 'vitest';
import type { RunConfig } from './config';
import { createEngine, replayRun } from './engine';
import type { RunEvent } from './events';
import { fakeModel, testConfig, waitProposal, type FakeOptions, type Policy } from './testing/fake-model';

const AT = '2026-10-07T00:00:00.000Z';

function setup(policy: Policy = {}, options: FakeOptions = {}, budget?: BudgetGuard) {
  const store = memoryEventStore();
  const calls = memoryCallLog();
  const model = fakeModel(policy, options);
  const engine = createEngine({ llm: model.port, events: store, calls, now: () => AT, ...(budget && { budget }) });
  const events = async (runId = 'run1') => (await store.read(runId)).map((e) => e.payload as RunEvent);
  return { store, calls, model, engine, events };
}

async function runToStop(s: ReturnType<typeof setup>, scene: Scene, config: RunConfig, runId = 'run1') {
  const started = await s.engine.start(runId, scene, config);
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const result = await s.engine.run(runId, scene);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const types = (events: readonly RunEvent[]) => events.map((e) => e.type);
const ofType = <T extends RunEvent['type']>(events: readonly RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

describe('同时行动的一回合', () => {
  const scene = warehouse();

  it('按状态机推进到回合上限；每回合恰好一次提交', async () => {
    const s = setup();
    const result = await runToStop(s, scene, testConfig({ maxRounds: 2 }));
    expect(result.phase).toBe('Ended');
    expect(result.state.endReason).toBe('max_rounds');
    const events = await s.events();
    expect(types(events).slice(0, 12)).toEqual([
      'RunStarted',
      'RoundStarted',
      'ViewBuilt',
      'ViewBuilt',
      'ProposalSubmitted',
      'ProposalSubmitted',
      'ProposalsComplete',
      'Committed',
      'StateChanged',
      'BeliefsReviewed',
      'BeliefsReviewed',
      'EvidenceChecked',
    ]);
    expect(ofType(events, 'Committed')).toHaveLength(2);
    expect(types(events).at(-1)).toBe('RunEnded');
    // 双方都在等待，没有新观察，不请求认知更新：每回合两次提案调用。
    expect(s.model.calls.map((c) => c.step)).toEqual(['propose', 'propose', 'propose', 'propose']);
  });

  it('提案按角色标识写入，与模型响应的到达顺序无关（同轮行动）', async () => {
    const policy: Policy = {
      character_action: (ctx) =>
        ctx.subject === 'protagonist'
          ? waitProposal({ kind: 'move', toZone: 'shelves', intent: '躲到货架后' })
          : waitProposal({ kind: 'attack', target: 'protagonist', item: 'crossbow' }),
    };
    const fast = setup(policy, { delay: (ctx) => (ctx.subject === 'antagonist' ? 30 : 0) });
    const slow = setup(policy, { delay: (ctx) => (ctx.subject === 'protagonist' ? 30 : 0) });
    await runToStop(fast, scene, testConfig({ maxRounds: 1 }));
    await runToStop(slow, scene, testConfig({ maxRounds: 1 }));
    expect(await slow.events()).toEqual(await fast.events());
    const submitted = ofType(await fast.events(), 'ProposalSubmitted').map((e) => e.actor);
    expect(submitted).toEqual([A, P]);
  });

  it('被规则拒绝的提案在同一对话中请求修正', async () => {
    const s = setup({
      character_action: (ctx) =>
        ctx.subject === 'antagonist' && ctx.attempt === 0
          ? waitProposal({ kind: 'move', toZone: 'shelves' })
          : waitProposal(),
    });
    await runToStop(s, scene, testConfig({ maxRounds: 1 }));
    const events = await s.events();
    expect(ofType(events, 'ProposalRejected')).toEqual([
      expect.objectContaining({ actor: A, attempt: 0, violation: expect.objectContaining({ code: 'not_adjacent' }) }),
    ]);
    const retry = s.model.calls.find((c) => c.subject === 'antagonist' && c.attempt === 1);
    expect(retry?.request.messages.at(-2)?.role).toBe('assistant');
    expect(retry?.request.messages.at(-1)?.content).toContain('一回合到不了');
  });

  it('超过修正次数时暂停；作者替换行动并恢复后继续', async () => {
    const s = setup({
      character_action: (ctx) => (ctx.subject === 'antagonist' ? waitProposal({ kind: 'move', toZone: 'shelves' }) : waitProposal()),
    });
    const paused = await runToStop(s, scene, testConfig({ maxRounds: 1, maxProposalAttempts: 1 }));
    expect(paused.phase).toBe('Paused');
    expect(paused.state.pause).toMatchObject({ reason: 'proposal_invalid', actor: A });

    const replaced = await s.engine.intervene('run1', scene, { kind: 'replace_action', action: { actor: A, kind: 'defend' }, reason: '对手应当守住南门' });
    expect(replaced.ok).toBe(true);
    await s.engine.resume('run1', scene);
    const done = await s.engine.run('run1', scene);
    expect(done.ok && done.value.phase).toBe('Ended');
    const events = await s.events();
    expect(ofType(events, 'AuthorIntervened')).toEqual([
      expect.objectContaining({ kind: 'replace_action', actor: A, reason: '对手应当守住南门', stateHashBefore: expect.any(String) }),
    ]);
    expect(ofType(events, 'ProposalSubmitted').filter((e) => e.source === 'author')).toHaveLength(1);
  });
});

describe('裁决', () => {
  const scene = warehouse();
  const attack: Policy = {
    character_action: (ctx) => (ctx.subject === 'antagonist' && ctx.round === 1 ? waitProposal({ kind: 'attack', target: 'protagonist', item: 'crossbow' }) : waitProposal()),
    semantic_ruling: () => ({
      rationale: '主角没有防备',
      effects: [{ type: 'setInjury', actor: 'protagonist', level: 'severe' }],
      occurrences: [{ participants: ['antagonist', 'protagonist'], zones: ['center'], visible: true, loudness: 2, visual: '弩箭钉进主角右臂', sound: '一声闷哼' }],
      uncertainties: ['弩箭是否淬毒'],
    }),
  };

  it('交互模式：待核实裁决等待作者确认，期间状态与角色反馈保持在提交前', async () => {
    const s = setup(attack);
    const waiting = await runToStop(s, scene, testConfig({ mode: 'interactive', maxRounds: 1 }));
    expect(waiting.phase).toBe('AwaitingAuthor');
    expect(waiting.awaiting).toEqual([expect.objectContaining({ requestId: '1:r0', uncertainties: ['弩箭是否淬毒'] })]);
    const before = stateHash(waiting.state.sim);
    expect(ofType(await s.events(), 'PerceptionDelivered')).toEqual([]);

    // 等待期间再推进不会提交。
    const again = await s.engine.step('run1', scene);
    expect(again.ok && stateHash(again.value.state.sim)).toBe(before);

    // 作者把伤势改为轻伤后确认。
    const proposed = waiting.awaiting[0]!.ruling;
    const confirmed = await s.engine.confirmRuling('run1', scene, '1:r0', {
      ...proposed,
      effects: [{ type: 'setInjury', actor: P, level: 'light' }],
    });
    expect(confirmed.ok && confirmed.value.phase).toBe('Committing');
    const done = await s.engine.run('run1', scene);
    expect(done.ok && done.value.state.sim.world.actors[P]?.injury).toBe('light');
    const events = await s.events();
    expect(ofType(events, 'Committed')).toHaveLength(1);
    expect(ofType(events, 'AdjudicationConfirmed')).toEqual([expect.objectContaining({ by: 'author', needsReview: false })]);
  });

  it('作者确认的裁决越界时拒绝', async () => {
    const s = setup(attack);
    const waiting = await runToStop(s, scene, testConfig({ mode: 'interactive', maxRounds: 1 }));
    const bad = await s.engine.confirmRuling('run1', scene, '1:r0', {
      ...waiting.awaiting[0]!.ruling,
      effects: [{ type: 'moveActor', actor: P, to: zone('office') }],
    });
    expect(bad).toEqual({ ok: false, error: expect.objectContaining({ code: 'invalid_ruling' }) });
  });

  it('自动模式：不等待作者，自动接受的裁决都带待复核标记', async () => {
    const s = setup(attack);
    const done = await runToStop(s, scene, testConfig({ maxRounds: 1 }));
    expect(done.phase).toBe('Ended');
    expect(done.state.needsReview).toEqual([expect.objectContaining({ requestId: '1:r0', by: 'auto', needsReview: true })]);
    expect(done.state.sim.world.actors[P]?.injury).toBe('severe');
  });

  it('越界的裁决带错误信息请求修正', async () => {
    const s = setup({
      ...attack,
      semantic_ruling: (ctx) =>
        ctx.attempt === 0
          ? { rationale: '', effects: [{ type: 'moveActor', actor: 'protagonist', to: 'office' }], occurrences: [], uncertainties: [] }
          : { rationale: '', effects: [], occurrences: [], uncertainties: [] },
    });
    const done = await runToStop(s, scene, testConfig({ maxRounds: 1 }));
    expect(done.phase).toBe('Ended');
    const second = s.model.calls.find((c) => c.step === 'rule' && c.attempt === 1);
    expect(second?.request.messages.at(-1)?.content).toContain('not_adjacent');
    // 调用记录写明修正原因，便于统计哪类裁决需要修正。
    const logged = s.calls.records().filter((r) => r.stepKey?.includes(':rule:'));
    expect(logged.map((r) => r.repairIssues)).toEqual([undefined, [expect.stringContaining('not_adjacent')]]);
  });
});

describe('轮流对话', () => {
  const scene = warehouse((sp) => {
    sp.actors[1]!.zone = 'center';
  });
  const config = testConfig({ protocol: 'turn_based', maxRounds: 3, firstSpeaker: P });
  const policy: Policy = {
    character_action: (ctx) => {
      if (ctx.subject === 'protagonist') {
        return waitProposal({ kind: 'speak', utterance: { sentences: ['我不是来找麻烦的。', '这封信……', '是给你们东家的。'], volume: 'normal' } });
      }
      // 对手听到第二句就打断。
      return waitProposal({ kind: 'speak', interruptAfter: 2, utterance: { sentences: ['少废话，把信交出来。'], volume: 'shout' } });
    },
  };

  it('听者在第 2 句后打断：后半句不进入任何认知，打断者获得发言权，看过后半句的回应作废重问', async () => {
    const s = setup(policy);
    await runToStop(s, scene, config);
    const events = await s.events();
    const firstSpeech = ofType(events, 'StateChanged')[0]!.occurrences.find((o) => o.kind === 'speak');
    expect(firstSpeech?.speech?.sentences).toEqual(['我不是来找麻烦的。', '这封信……']);
    expect(ofType(events, 'ProposalsComplete')[0]?.interruption).toEqual({ by: A, after: 2 });
    expect(JSON.stringify(events.filter((e) => e.type !== 'ProposalSubmitted'))).not.toContain('是给你们东家的');

    const rounds = ofType(events, 'RoundEnded');
    expect(rounds.map((r) => r.nextFloor)).toEqual([A, P, A]);
    // 对手在第 1 回合的回应看到了没说出口的第 3 句，作废；第 2 回合按他实际听到的重新询问。
    const asked = s.model.calls.filter((c) => c.round === 2 && c.subject === 'antagonist' && c.step === 'propose');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text).not.toContain('是给你们东家的');
    const used = ofType(events, 'ProposalSubmitted').filter((e) => e.forRound === e.round);
    expect(used.filter((e) => e.source === 'prepared').map((e) => e.round)).toEqual([3]);
    // 没有被打断的回应（第 2 回合主角听完了对手的话）照常留到下一次发言，不再额外调用。
    expect(s.model.calls.filter((c) => c.round === 3 && c.step === 'propose')).toEqual([]);
  });

  it('听不到或听不清台词的人不拿到台词，轮到他发言时按自己的认知再问', async () => {
    // 对手在南门：耳语隔一个区域听不到，正常音量只听得到有人在说话。
    const apart = warehouse();
    for (const volume of ['whisper', 'normal'] as const) {
      const s = setup({
        character_action: (ctx) =>
          ctx.subject === 'protagonist'
            ? waitProposal({ kind: 'speak', utterance: { sentences: ['金丝雀暗号在第三根梁上。'], volume } })
            : waitProposal({ interruptAfter: 0 }),
      });
      await runToStop(s, apart, testConfig({ protocol: 'turn_based', maxRounds: 2, firstSpeaker: P }));
      const antagonist = s.model.calls.filter((c) => c.subject === 'antagonist');
      // 对手只在自己持有发言权时被问行动；他看见主角在说话，认知更新照常进行，但请求里没有台词。
      const actions = antagonist.filter((c) => c.request.task === 'character_action');
      expect(actions.map((c) => `${c.round}:${c.step}`), volume).toEqual(['2:propose']);
      for (const c of antagonist) expect(c.text, volume).not.toContain('金丝雀暗号');
      // 听不到的人的回应不参与打断。
      expect(ofType(await s.events(), 'ProposalsComplete')[0]?.interruption, volume).toBeNull();
    }
  });

  it('离场的人不再接收发言，在场少于两人时结束', async () => {
    const s = setup({
      character_action: (ctx) => (ctx.subject === 'antagonist' ? waitProposal({ kind: 'withdraw' }) : policy.character_action!(ctx)),
    });
    const scene2 = warehouse((sp) => {
      sp.actors[1]!.zone = 'south_gate';
      sp.actors[0]!.zone = 'south_gate';
    });
    const done = await runToStop(s, scene2, testConfig({ protocol: 'turn_based', maxRounds: 5, firstSpeaker: A }));
    expect(done.state.endReason).toBe('actors_left');
    expect(done.state.sim.world.actors[A]?.status).toBe('withdrawn');
  });
});

describe('认知与证据链', () => {
  const scene = warehouse();

  it('有新观察的角色请求认知更新，提案中的推测写入认知', async () => {
    const s = setup({
      character_action: (ctx) =>
        ctx.subject === 'protagonist'
          ? waitProposal({ kind: 'observe', inferences: [{ content: '对手在等更好的机会', about: ['antagonist'], confidence: 0.4, concerning: null }] })
          : waitProposal(),
    });
    const done = await runToStop(s, scene, testConfig({ maxRounds: 1 }));
    expect(s.model.calls.filter((c) => c.step === 'beliefs').map((c) => c.subject).sort()).toEqual(['antagonist', 'protagonist']);
    const own = done.state.sim.knowledge[P] ?? [];
    expect(own.some((k) => k.body.kind === 'text' && k.body.text === '对手在等更好的机会')).toBe(true);
  });

  it('没有线索却推测出南门绊索：记录缺少证据链的命中（只作提示）', async () => {
    const s = setup({
      character_action: (ctx) =>
        ctx.subject === 'protagonist'
          ? waitProposal({ inferences: [{ content: '南门门槛下多半有绊索', about: ['south_gate'], confidence: 0.6, concerning: null }] })
          : waitProposal(),
      judgement: (ctx) => ({
        judgements: [...ctx.text.matchAll(/推测 \[([^\]]+)\] 对照秘密 \[([^\]]+)\]/g)].map((m) => ({
          inference: m[1] ?? '',
          secret: m[2] ?? '',
          hit: true,
          supported: false,
          explanation: '没有任何观察',
        })),
      }),
    });
    await runToStop(s, scene, testConfig({ maxRounds: 1 }));
    expect(ofType(await s.events(), 'EvidenceGapFlagged')).toEqual([
      expect.objectContaining({ actor: P, secret: 'tripwire_secret', explanation: '没有任何观察' }),
    ]);
  });

  // 第二个秘密也涉及南门，且两人都不知情：一条关于南门的推测会对照两个秘密。
  const twoSecrets = warehouse((sc) => {
    sc.secrets!.push({ id: 'gate_watch', text: '巡夜人今晚不走南门', subjects: ['south_gate'], knownBy: [] });
  });
  const gateGuess = waitProposal({ inferences: [{ content: '南门有古怪', about: ['south_gate'], confidence: 0.6, concerning: null }] });
  const pairs = (text: string) => [...text.matchAll(/推测 \[([^\]]+)\] 对照秘密 \[([^\]]+)\]/g)].map((m) => ({ inference: m[1] ?? '', secret: m[2] ?? '' }));

  it('一条推测同时对照两个秘密时，命中记在判断所指的那个秘密上', async () => {
    const s = setup({
      character_action: (ctx) => (ctx.subject === 'protagonist' ? gateGuess : waitProposal()),
      judgement: (ctx) => ({
        judgements: pairs(ctx.text).map((c) => ({ ...c, hit: c.secret === 'gate_watch', supported: false, explanation: `对照 ${c.secret}` })),
      }),
    });
    await runToStop(s, twoSecrets, testConfig({ maxRounds: 1 }));
    expect(ofType(await s.events(), 'EvidenceGapFlagged')).toEqual([
      expect.objectContaining({ actor: P, secret: 'gate_watch', explanation: '对照 gate_watch' }),
    ]);
  });

  it('各人的证据链判断同时发出，事件按角色标识的顺序写入，与响应的到达顺序无关', async () => {
    let inFlight = 0;
    let peak = 0;
    const s = setup(
      {
        character_action: () => gateGuess,
        judgement: (ctx) => {
          inFlight--;
          return { judgements: pairs(ctx.text).map((c) => ({ ...c, hit: true, supported: false, explanation: ctx.subject })) };
        },
      },
      {
        // 先发出的主角判断最晚返回。
        delay: (ctx) => {
          if (ctx.step !== 'evidence') return 0;
          inFlight++;
          peak = Math.max(peak, inFlight);
          return ctx.subject === 'protagonist' ? 30 : 5;
        },
      },
    );
    await runToStop(s, twoSecrets, testConfig({ maxRounds: 1 }));
    expect(peak).toBe(2);
    expect(ofType(await s.events(), 'EvidenceGapFlagged').map((e) => e.actor)).toEqual([A, P, P]);
  });
});

describe('停止、预算与恢复', () => {
  const scene = warehouse();

  it('预算将超出时以“预算”结束，不再发起新调用', async () => {
    // 每次预估约 0.04 美元（最大输出 2000 × 20/百万），实际 0.008 美元。
    const s = setup({}, {}, new BudgetGuard({ limitUsd: 0.06 }));
    const done = await runToStop(s, scene, testConfig({ maxRounds: 5 }));
    expect(done.state.endReason).toBe('budget');
    const callsAtEnd = s.model.calls.length;
    await s.engine.run('run1', scene);
    expect(s.model.calls.length).toBe(callsAtEnd);
  });

  it('暂停后恢复从原阶段继续；停止后不再推进', async () => {
    const s = setup();
    await s.engine.start('run1', scene, testConfig({ maxRounds: 3 }));
    await s.engine.step('run1', scene);
    const paused = await s.engine.pause('run1', scene);
    expect(paused.ok && paused.value.phase).toBe('Paused');
    expect((await s.engine.run('run1', scene)).ok).toBe(true);
    expect(s.model.calls).toHaveLength(0);
    await s.engine.resume('run1', scene);
    const stepped = await s.engine.step('run1', scene);
    expect(stepped.ok && stepped.value.phase).toBe('Adjudicating');
    const stopped = await s.engine.stop('run1', scene);
    expect(stopped.ok && stopped.value.state.endReason).toBe('author_stop');
  });

  it('回放只读事件，得到相同的状态，不调用模型', async () => {
    const s = setup();
    const done = await runToStop(s, scene, testConfig({ maxRounds: 2 }));
    const replayed = replayRun(scene, 'run1', await s.store.read('run1'));
    expect(replayed.ok && stateHash(replayed.value.sim)).toBe(stateHash(done.state.sim));
  });

  it('换了场景配置的运行拒绝继续', async () => {
    const s = setup();
    await s.engine.start('run1', scene, testConfig());
    const other = warehouse((sp) => {
      sp.actors[0]!.injury = 'none';
    });
    expect(await s.engine.step('run1', other)).toEqual({ ok: false, error: { code: 'scene_mismatch' } });
  });
});

describe('作者介入与分支', () => {
  const scene = warehouse();

  it('回合之间修改认知与安排外部事件，记录介入前的状态哈希', async () => {
    const s = setup();
    await runToStop(s, scene, testConfig({ maxRounds: 2, mode: 'interactive' }));
    // 运行已结束：用分支在第 1 回合结束处介入。
    const roundEnd = (await s.store.read('run1')).find((e) => (e.payload as RunEvent).type === 'RoundEnded')!;
    const forked = await s.engine.fork('run1', scene, roundEnd.seq, 'run2');
    expect(forked.ok && forked.value.round).toBe(1);

    const edited = await s.engine.intervene('run2', scene, {
      kind: 'edit_knowledge',
      actor: P,
      add: [{ text: '南门门槛下有一道绊索', modality: 'heard', confidence: 0.9, about: ['tripwire', 'south_gate'] }],
      retract: [],
      reason: '让主角提前知道绊索',
    });
    expect(edited.ok).toBe(true);
    const external = await s.engine.intervene('run2', scene, {
      kind: 'external_event',
      event: { effects: [], occurrences: [{ participants: [], zones: [zone('south_gate')], visible: true, loudness: 3, description: { sound: '巷子里传来巡夜人的梆子声' } }] },
      reason: '巡夜人逼近',
    });
    expect(external.ok).toBe(true);
    const done = await s.engine.run('run2', scene);
    expect(done.ok && done.value.phase).toBe('Ended');

    const events = await s.events('run2');
    expect(events[0]).toMatchObject({ type: 'RunStarted', parent: { runId: 'run1', seq: roundEnd.seq } });
    expect(ofType(events, 'AuthorIntervened').map((e) => e.kind)).toEqual(['edit_knowledge', 'external_event']);
    // 原记录不受影响。
    expect(ofType(await s.events('run1'), 'AuthorIntervened')).toEqual([]);
  });

  it('在回合中途不能安排外部事件', async () => {
    const s = setup();
    await s.engine.start('run1', scene, testConfig());
    await s.engine.step('run1', scene);
    const result = await s.engine.intervene('run1', scene, {
      kind: 'external_event',
      event: { effects: [], occurrences: [] },
      reason: '测试',
    });
    expect(result).toEqual({ ok: false, error: { code: 'invalid_phase' } });
  });

  it('不合法的替换行动被拒绝', async () => {
    const s = setup();
    await s.engine.start('run1', scene, testConfig());
    await s.engine.step('run1', scene);
    const result = await s.engine.intervene('run1', scene, {
      kind: 'replace_action',
      action: { actor: A, kind: 'move', toZone: zone('shelves') },
      reason: '测试',
    });
    expect(result).toEqual({ ok: false, error: { code: 'invalid_intervention', detail: 'not_adjacent' } });
  });
});

describe('同轮行动中的拾取争夺', () => {
  it('争夺交给裁决，裁决只能把物品交给争夺者之一', async () => {
    const scene = warehouse((sp) => {
      sp.items![0]!.location = { kind: 'zone', zone: 'center' };
      sp.actors[1]!.zone = 'center';
    });
    const s = setup({
      character_action: (ctx) => (ctx.round === 1 ? waitProposal({ kind: 'take', item: 'letter' }) : waitProposal()),
      semantic_ruling: () => ({
        rationale: '对手离得更近',
        effects: [{ type: 'transferItem', item: 'letter', toActor: 'antagonist', toZone: null }],
        occurrences: [],
        uncertainties: [],
      }),
    });
    const done = await runToStop(s, scene, testConfig({ maxRounds: 1 }));
    expect(done.state.sim.world.items[item('letter')]?.location).toEqual({ kind: 'actor', actor: A });
  });
});

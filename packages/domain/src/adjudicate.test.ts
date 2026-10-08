import { describe, expect, it } from 'vitest';
import type { Action } from './actions';
import { adjudicate } from './adjudicate';
import type { CounterKey } from './ids';
import { withEffects } from './testing/state';
import { A, P, actor, item, warehouse, zone } from './testing/warehouse';
import { initialState, type SimState } from './world';

const W = actor('watchman');
const bolts = 'bolts' as CounterKey;

/** 密信掉在仓库中央，两人都在中央。 */
function looseLetter(contest: 'draw' | 'ruling') {
  const scene = warehouse((s) => {
    s.items![0]!.location = { kind: 'zone', zone: 'center' };
    s.actors[1]!.zone = 'center';
    s.rules!.contests = { take: contest };
  });
  return { scene, state: { ...initialState(scene, 7), round: 1 } };
}

const scene = warehouse();
const round1: SimState = { ...initialState(scene, 1), round: 1 };

describe('adjudicate', () => {
  it('行动按角色标识排序，与传入顺序无关', () => {
    const actions: Action[] = [
      { actor: P, kind: 'move', toZone: zone('shelves') },
      { actor: A, kind: 'defend' },
    ];
    const forward = adjudicate(scene, round1, actions);
    const backward = adjudicate(scene, round1, [...actions].reverse());
    expect(forward).toEqual(backward);
    expect(forward.ok && forward.value.actions.map((a) => a.action.actor)).toEqual([A, P]);
  });

  it('同一角色提交两次行动是调用方错误', () => {
    expect(adjudicate(scene, round1, [{ actor: P, kind: 'wait' }, { actor: P, kind: 'defend' }])).toEqual({
      ok: false,
      error: { code: 'duplicate_actor', actor: P },
    });
  });

  it('被拒绝的提案不能进入裁决', () => {
    expect(adjudicate(scene, round1, [{ actor: A, kind: 'move', toZone: zone('shelves') }])).toEqual({
      ok: false,
      error: { code: 'rejected_action', actor: A, violation: expect.objectContaining({ code: 'not_adjacent' }) },
    });
  });

  it('移动、放下与撤离由程序直接结算', () => {
    const result = adjudicate(scene, round1, [
      { actor: P, kind: 'drop', item: item('letter') },
      { actor: A, kind: 'withdraw' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pending).toEqual([]);
    expect(result.value.effects).toEqual([
      { type: 'setActorStatus', actor: A, status: 'withdrawn' },
      { type: 'transferItem', item: 'letter', to: { kind: 'zone', zone: 'center' } },
    ]);
    expect(result.value.occurrences.map((o) => o.kind)).toEqual(['withdraw', 'drop']);
  });

  it('边做事边说话：附带的台词与动作在同一回合发生，交给语义裁决的动作同样不丢台词', () => {
    const speech = { sentences: ['信在这儿。', '你拿去。'], volume: 'normal' as const };
    const result = adjudicate(scene, round1, [
      { actor: P, kind: 'drop', item: item('letter'), utterance: speech },
      { actor: A, kind: 'other', target: P, utterance: { ...speech, deliveredCount: 1 } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const said = result.value.occurrences.filter((o) => o.kind === 'speak');
    expect(said.map((o) => [o.actor, o.speech?.sentences])).toEqual([
      [A, ['信在这儿。']],
      [P, ['信在这儿。', '你拿去。']],
    ]);
    expect(said.find((o) => o.actor === A)?.target).toBe(P);
    expect(result.value.occurrences.map((o) => o.kind)).toEqual(['speak', 'drop', 'speak']);
    // “其他”行动本身仍交给语义裁决。
    expect(result.value.pending.flatMap((r) => r.actors)).toContain(A);
  });

  it('使用带内容的物品（读信）由程序结算：旁人看见在用这件物品，内容只给持有者', () => {
    const lettered = warehouse((s) => {
      s.items![0]!.content = '货在城西第三个码头。';
    });
    const result = adjudicate(lettered, { ...initialState(lettered, 1), round: 1 }, [{ actor: P, kind: 'use_item', item: item('letter') }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pending).toEqual([]);
    expect(result.value.occurrences).toEqual([
      expect.objectContaining({ kind: 'use_item', actor: P, item: 'letter', visible: true }),
      expect.objectContaining({ kind: 'read', actor: P, item: 'letter', visible: false, loudness: 0, participants: [P], content: '货在城西第三个码头。' }),
    ]);
  });

  it('把带内容的物品递给别人（指定了对象）不是读信，交给语义裁决', () => {
    const lettered = warehouse((s) => {
      s.items![0]!.content = '货在城西第三个码头。';
    });
    const result = adjudicate(lettered, { ...initialState(lettered, 1), round: 1 }, [{ actor: P, kind: 'use_item', item: item('letter'), target: A }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurrences.filter((o) => o.kind === 'read')).toEqual([]);
    expect(result.value.pending.flatMap((r) => r.actors)).toContain(P);
  });

  it('没有句子的台词不生成说话', () => {
    const result = adjudicate(scene, round1, [{ actor: P, kind: 'defend', utterance: { sentences: [], volume: 'normal' } }]);
    expect(result.ok && result.value.occurrences.map((o) => o.kind)).toEqual(['defend']);
  });

  describe('同轮争夺同一物品', () => {
    it('draw 规则下用推演状态中的随机数抽取，恰好一人得到物品', () => {
      const { scene: s, state } = looseLetter('draw');
      const result = adjudicate(s, state, [
        { actor: P, kind: 'take', item: item('letter') },
        { actor: A, kind: 'take', item: item('letter') },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const transfers = result.value.effects.filter((e) => e.type === 'transferItem');
      expect(transfers).toHaveLength(1);
      const rng = result.value.effects.find((e) => e.type === 'advanceRng');
      expect(rng).toMatchObject({ draws: [{ purpose: 'contest:letter', bound: 2 }] });
      const loser = result.value.occurrences.find((o) => o.kind === 'failed_attempt');
      expect(loser?.violation?.code).toBe('contest_lost');
      expect(result.value.pending).toEqual([]);
    });

    it('未声明随机对抗时生成语义裁决请求，不转移物品', () => {
      const { scene: s, state } = looseLetter('ruling');
      const result = adjudicate(s, state, [
        { actor: P, kind: 'take', item: item('letter') },
        { actor: A, kind: 'take', item: item('letter') },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.effects).toEqual([]);
      expect(result.value.pending).toEqual([
        expect.objectContaining({ id: '1:r0', actors: [A, P], items: expect.arrayContaining(['letter']) }),
      ]);
    });
  });

  describe('消耗', () => {
    it('射击完成即扣减弩箭，命中与否交给语义裁决', () => {
      const result = adjudicate(scene, round1, [
        { actor: A, kind: 'attack', target: P, item: item('crossbow') },
        { actor: P, kind: 'move', toZone: zone('shelves') },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.effects).toEqual([
        { type: 'adjustCounter', item: 'crossbow', counter: 'bolts', delta: -1 },
        { type: 'moveActor', actor: P, to: 'shelves' },
      ]);
      expect(result.value.pending).toEqual([
        expect.objectContaining({ actors: [A, P], semantic: [A], items: expect.arrayContaining(['crossbow', 'letter']) }),
      ]);
    });

    it('余量为零时形成失败尝试，不扣减，也不请求裁决', () => {
      const empty = withEffects(scene, round1, [
        { type: 'adjustCounter', item: item('crossbow'), counter: bolts, delta: -1 },
      ]);
      const result = adjudicate(scene, empty, [{ actor: A, kind: 'attack', target: P, item: item('crossbow') }]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.effects).toEqual([]);
      expect(result.value.pending).toEqual([]);
      expect(result.value.occurrences).toEqual([
        expect.objectContaining({ kind: 'failed_attempt', attempted: 'attack', violation: expect.objectContaining({ code: 'resource_exhausted' }) }),
      ]);
    });
  });

  it('配置了效果的物品由程序结算', () => {
    const atShelves = withEffects(scene, round1, [
      { type: 'moveActor', actor: P, to: zone('shelves') },
      { type: 'transferItem', item: item('tiles'), to: { kind: 'actor', actor: P } },
    ]);
    const result = adjudicate(scene, atShelves, [{ actor: P, kind: 'use_item', item: item('tiles') }]);
    expect(result.ok && result.value.occurrences).toEqual([
      expect.objectContaining({ kind: 'use_item', zones: ['shelves'], loudness: 5 }),
    ]);
    expect(result.ok && result.value.pending).toEqual([]);
  });

  it('前提条件满足时按声明设置标记', () => {
    const keyed = withEffects(scene, round1, [
      { type: 'transferItem', item: item('office_key'), to: { kind: 'actor', actor: P } },
    ]);
    const result = adjudicate(scene, keyed, [
      { actor: P, kind: 'use_item', item: item('office_key'), target: 'office' },
    ]);
    expect(result.ok && result.value.effects).toEqual([{ type: 'setFlag', flag: 'office_open', value: true }]);
    expect(result.ok && result.value.pending).toEqual([]);
  });

  it('同区域的观察发现隐藏机关，只有观察者知情', () => {
    const atGate = withEffects(scene, round1, [{ type: 'moveActor', actor: P, to: zone('south_gate') }]);
    const result = adjudicate(scene, atGate, [{ actor: P, kind: 'observe' }]);
    expect(result.ok && result.value.occurrences).toEqual([
      expect.objectContaining({ kind: 'observe', participants: [P] }),
      expect.objectContaining({ kind: 'discovered', mechanism: 'tripwire', participants: [P], visible: false, loudness: 0 }),
    ]);
  });

  it('攻击对象无论标识先后都在请求之内', () => {
    const close = withEffects(scene, round1, [{ type: 'moveActor', actor: P, to: zone('south_gate') }]);
    const result = adjudicate(scene, close, [{ actor: P, kind: 'attack', target: A, item: item('dagger') }]);
    expect(result.ok && result.value.pending.map((r) => [r.actors, r.semantic])).toEqual([[[A, P], [P]]]);
  });

  it('相互关联的语义行动并为一个请求，无关的角色不在其中', () => {
    const crowded = warehouse((s) => {
      s.actors.push({ id: 'watchman', name: '巡夜人', zone: 'office' });
    });
    const state = { ...initialState(crowded, 1), round: 2 };
    const result = adjudicate(crowded, state, [
      { actor: A, kind: 'attack', target: P, item: item('crossbow') },
      { actor: P, kind: 'defend' },
      { actor: W, kind: 'probe' },
    ]);
    expect(result.ok && result.value.pending.map((r) => [r.id, r.actors, r.semantic])).toEqual([
      ['2:r0', [A, P], [A]],
      ['2:r1', [W], [W]],
    ]);
  });
});

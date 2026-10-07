import { canonicalJson } from '@fudiao/shared';
import { describe, expect, it } from 'vitest';
import type { FlagKey } from '../ids';
import { crowded, run } from '../testing/round';
import { withEffects } from '../testing/state';
import { A, P, actor, item, zone } from '../testing/warehouse';
import { initialState, type SimState } from '../world';
import { buildCharacterView, viewIds } from './view';

const W = actor('watchman');
const scene = crowded();
const start: SimState = { ...initialState(scene, 3), round: 1 };

describe('buildCharacterView', () => {
  it('包含本人的位置、伤势、持有物与计数，以及去掉初始认知的角色卡', () => {
    const view = buildCharacterView(scene, start, A);
    expect(view.self).toEqual({
      name: '对手',
      zone: 'south_gate',
      injury: 'none',
      status: 'present',
      card: { goal: '夺信且保全自己', traits: [] },
      items: [{ id: 'crossbow', name: '弩', counters: { bolts: 1 }, reach: 'ranged' }],
    });
  });

  it('看得见他人与其手中未藏匿的物品，看不见他人的伤势与计数', () => {
    const view = buildCharacterView(scene, start, A);
    expect(view.visible.actors).toEqual([
      { id: P, name: '主角', zone: 'center', holding: [{ id: 'dagger', name: '短刀' }] },
      { id: W, name: '巡夜人', zone: 'center', holding: [] },
    ]);
    const fromP = buildCharacterView(scene, start, P);
    expect(fromP.visible.actors.find((a) => a.id === A)?.holding).toEqual([{ id: 'crossbow', name: '弩' }]);
    expect(canonicalJson(fromP.visible)).not.toContain('bolts');
    expect(canonicalJson(fromP.visible)).not.toContain('injury');
  });

  it('只看得见可见区域中无人持有的物品', () => {
    const view = buildCharacterView(scene, start, P);
    expect(view.visible.items.map((i) => i.id)).toEqual(['tiles', 'office_key']);
    expect(buildCharacterView(scene, start, A).visible.items).toEqual([]);
  });

  it('隐藏机关只对知情者出现，发现后才出现在发现者的视图中', () => {
    expect(buildCharacterView(scene, start, A).visible.mechanisms.map((m) => m.id)).toEqual(['tripwire']);
    expect(buildCharacterView(scene, start, P).visible.mechanisms).toEqual([]);
    const atGate = withEffects(scene, start, [{ type: 'moveActor', actor: P, to: zone('south_gate') }]);
    const after = run(scene, atGate, [{ actor: P, kind: 'observe' }]).nextState;
    expect(buildCharacterView(scene, after, P).visible.mechanisms.map((m) => m.id)).toEqual(['tripwire']);
    expect(buildCharacterView(scene, after, W).visible.mechanisms).toEqual([]);
  });

  it('感知传播：视线外被拿走的物品，之后看过去只剩空位置，旧认知仍在', () => {
    const s = withEffects(scene, start, [
      { type: 'moveActor', actor: W, to: zone('south_gate') },
      { type: 'moveActor', actor: P, to: zone('shelves') },
    ]);
    const before = buildCharacterView(scene, s, W);
    expect(before.visible.items).toEqual([]);
    const after = run(scene, s, [{ actor: P, kind: 'take', item: item('tiles') }]).nextState;
    expect(canonicalJson(after.knowledge[W] ?? [])).not.toContain('tiles');
    const later = withEffects(scene, after, [{ type: 'moveActor', actor: W, to: zone('center') }]);
    expect(buildCharacterView(scene, later, W).visible.items.map((i) => i.id)).toEqual(['office_key']);
  });

  it('只包含本人有效的认知与听清的说法', () => {
    const together = withEffects(scene, start, [{ type: 'moveActor', actor: A, to: zone('center') }]);
    const after = run(scene, together, [
      { actor: A, kind: 'speak', target: P, utterance: { sentences: ['援兵就在门外。'], volume: 'normal' } },
    ]).nextState;
    const view = buildCharacterView(scene, after, P);
    expect(view.knowledge.every((k) => k.holder === P && k.status === 'active')).toBe(true);
    expect(view.claims.map((c) => c.sentences)).toEqual([['援兵就在门外。']]);
    const retracted = {
      ...after,
      knowledge: {
        ...after.knowledge,
        [P]: (after.knowledge[P] ?? []).map((k, i) => (i === 0 ? { ...k, status: 'retracted' as const } : k)),
      },
    };
    expect(buildCharacterView(scene, retracted, P).knowledge.map((k) => k.id)).not.toContain('protagonist:0:0');
  });

  it('已撤离的角色看不见任何人与物', () => {
    const gone = withEffects(scene, start, [{ type: 'setActorStatus', actor: A, status: 'withdrawn' }]);
    const view = buildCharacterView(scene, gone, A);
    expect(view.visible.actors).toEqual([]);
    expect(view.visible.items).toEqual([]);
    expect(buildCharacterView(scene, gone, P).visible.actors.map((a) => a.id)).toEqual([W]);
  });

  it('打开的门不改变可见关系：账房仍看不见', () => {
    const open = withEffects(scene, start, [{ type: 'setFlag', flag: 'office_open' as FlagKey, value: true }]);
    expect(buildCharacterView(scene, open, P).visible.items.map((i) => i.id)).not.toContain('ledger');
  });

  it('names 只为视图中出现过的标识提供名称', () => {
    const view = buildCharacterView(scene, start, P);
    const names = Object.fromEntries(view.names.map((n) => [n.id, n.name]));
    expect(names).toMatchObject({ protagonist: '主角', antagonist: '对手', crossbow: '弩', center: '仓库中央' });
    expect(names).not.toHaveProperty('tripwire');
    expect(names).not.toHaveProperty('ledger');
    expect(view.names.every((n) => viewIds(view).has(n.id))).toBe(true);
  });

  it('viewIds 收集视图中出现过的标识', () => {
    const ids = viewIds(buildCharacterView(scene, start, P));
    expect(ids.has('crossbow')).toBe(true);
    expect(ids.has('ledger')).toBe(false);
    expect(ids.has('tripwire')).toBe(false);
  });
});

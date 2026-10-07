import { describe, expect, it } from 'vitest';
import { applyEffects, type Effect } from './effects';
import type { ActorId, CounterKey, FlagKey, MechanismId } from './ids';
import { seedRng } from './rng';
import { A, P, item, warehouse, zone } from './testing/warehouse';
import { initialState } from './world';

const scene = warehouse();
const start = initialState(scene, 1);
const bolts = 'bolts' as CounterKey;
const ghost = 'ghost' as ActorId;

const apply = (effects: readonly Effect[]) => applyEffects(scene, start, effects);

describe('初始状态', () => {
  it('由场景配置得到', () => {
    expect(start.round).toBe(0);
    expect(start.world.actors[P]).toEqual({ zone: 'center', injury: 'light', status: 'present' });
    expect(start.world.items[item('crossbow')]).toEqual({
      location: { kind: 'actor', actor: 'antagonist' },
      counters: { bolts: 1 },
    });
    expect(start.world.mechanisms['tripwire' as MechanismId]).toEqual({ armed: true });
    expect(start.world.flags).toEqual({ office_open: false });
    expect(start.rng).toEqual(seedRng(1));
  });
});

describe('applyEffects', () => {
  it('依次应用效果，不修改原状态', () => {
    const result = apply([
      { type: 'moveActor', actor: P, to: zone('shelves') },
      { type: 'transferItem', item: item('tiles'), to: { kind: 'actor', actor: P } },
      { type: 'adjustCounter', item: item('crossbow'), counter: bolts, delta: -1 },
      { type: 'setInjury', actor: A, level: 'severe' },
      { type: 'disarmMechanism', mechanism: 'tripwire' as MechanismId },
      { type: 'setFlag', flag: 'office_open' as FlagKey, value: true },
      { type: 'setActorStatus', actor: A, status: 'withdrawn' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const w = result.value.world;
    expect(w.actors[P]?.zone).toBe('shelves');
    expect(w.items[item('tiles')]?.location).toEqual({ kind: 'actor', actor: 'protagonist' });
    expect(w.items[item('crossbow')]?.counters).toEqual({ bolts: 0 });
    expect(w.actors[A]).toEqual({ zone: 'south_gate', injury: 'severe', status: 'withdrawn' });
    expect(w.mechanisms['tripwire' as MechanismId]?.armed).toBe(false);
    expect(w.flags['office_open' as FlagKey]).toBe(true);
    expect(start.world.actors[P]?.zone).toBe('center');
  });

  it('推进随机数状态', () => {
    const to = seedRng(99);
    const result = apply([
      { type: 'advanceRng', to, draws: [{ purpose: 'contest', bound: 2, value: 1 }] },
    ]);
    expect(result.ok && result.value.rng).toEqual(to);
  });

  it.each<[string, Effect, string]>([
    ['计数为负', { type: 'adjustCounter', item: item('crossbow'), counter: bolts, delta: -2 }, 'negative_counter'],
    ['未声明的计数', { type: 'adjustCounter', item: item('crossbow'), counter: 'arrows' as CounterKey, delta: 1 }, 'unknown_ref'],
    ['未知区域', { type: 'moveActor', actor: P, to: zone('roof') }, 'unknown_ref'],
    ['未知角色', { type: 'setInjury', actor: ghost, level: 'light' }, 'unknown_ref'],
    ['未知物品', { type: 'transferItem', item: item('sword'), to: { kind: 'zone', zone: zone('center') } }, 'unknown_ref'],
    ['未声明的标记', { type: 'setFlag', flag: 'secret_door' as FlagKey, value: true }, 'unknown_ref'],
    ['交给不存在的角色', { type: 'transferItem', item: item('letter'), to: { kind: 'actor', actor: ghost } }, 'unknown_ref'],
  ])('违反不变式时整体失败：%s', (_name, effect, code) => {
    const result = apply([{ type: 'moveActor', actor: P, to: zone('shelves') }, effect]);
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ index: 1, code }) });
  });

  it('物品不能交给已撤离的角色', () => {
    const result = apply([
      { type: 'setActorStatus', actor: A, status: 'withdrawn' },
      { type: 'transferItem', item: item('letter'), to: { kind: 'actor', actor: A } },
    ]);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ index: 1, code: 'holder_withdrawn' }),
    });
  });

  it('已撤离的角色不能被移动', () => {
    const result = apply([
      { type: 'setActorStatus', actor: A, status: 'withdrawn' },
      { type: 'moveActor', actor: A, to: zone('center') },
    ]);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ index: 1, code: 'actor_withdrawn' }),
    });
  });
});

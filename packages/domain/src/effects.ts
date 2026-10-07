import { err, ok, type Result } from '@novel-writer/shared';
import type { ActorId, CounterKey, FlagKey, ItemId, MechanismId, ZoneId } from './ids';
import type { RngState } from './rng';
import type { InjuryLevel } from './scene/schema';
import type { Scene } from './scene/validate';
import type { ActorStatus, ItemLocation, SimState, WorldState } from './world';

export type RngDraw = { readonly purpose: string; readonly bound: number; readonly value: number };

/** 状态变更的最小单位。状态只能通过效果改变，效果写入事件后可直接回放。 */
export type Effect =
  | { readonly type: 'moveActor'; readonly actor: ActorId; readonly to: ZoneId }
  | { readonly type: 'transferItem'; readonly item: ItemId; readonly to: ItemLocation }
  | {
      readonly type: 'adjustCounter';
      readonly item: ItemId;
      readonly counter: CounterKey;
      readonly delta: number;
    }
  | { readonly type: 'setInjury'; readonly actor: ActorId; readonly level: InjuryLevel }
  | { readonly type: 'setActorStatus'; readonly actor: ActorId; readonly status: ActorStatus }
  | { readonly type: 'disarmMechanism'; readonly mechanism: MechanismId }
  | { readonly type: 'setFlag'; readonly flag: FlagKey; readonly value: boolean }
  | { readonly type: 'advanceRng'; readonly to: RngState; readonly draws: readonly RngDraw[] };

export type InvariantViolation = {
  /** 出错的效果在列表中的位置。 */
  readonly index: number;
  readonly code:
    | 'unknown_ref'
    | 'negative_counter'
    | 'non_integer'
    | 'holder_withdrawn'
    | 'actor_withdrawn';
  readonly ref?: string;
};

type Violation = Omit<InvariantViolation, 'index'>;

/** 依次应用效果；任何一个效果违反不变式时整体失败，原状态不变。 */
export function applyEffects(
  scene: Scene,
  state: SimState,
  effects: readonly Effect[],
): Result<SimState, InvariantViolation> {
  let current = state;
  for (const [index, effect] of effects.entries()) {
    const next = applyOne(scene, current, effect);
    if (!next.ok) return err({ index, ...next.error });
    current = next.value;
  }
  return ok(current);
}

function applyOne(scene: Scene, state: SimState, effect: Effect): Result<SimState, Violation> {
  const { world } = state;
  const unknown = (ref: string) => err<Violation>({ code: 'unknown_ref', ref });
  const withWorld = (patch: Partial<WorldState>) => ok({ ...state, world: { ...world, ...patch } });
  const zoneExists = (zone: ZoneId) => scene.zones.some((z) => z.id === zone);

  switch (effect.type) {
    case 'moveActor': {
      const actor = world.actors[effect.actor];
      if (actor === undefined) return unknown(effect.actor);
      if (!zoneExists(effect.to)) return unknown(effect.to);
      if (actor.status === 'withdrawn') return err({ code: 'actor_withdrawn', ref: effect.actor });
      return withWorld({ actors: { ...world.actors, [effect.actor]: { ...actor, zone: effect.to } } });
    }
    case 'transferItem': {
      const item = world.items[effect.item];
      if (item === undefined) return unknown(effect.item);
      const to = effect.to;
      if (to.kind === 'zone' && !zoneExists(to.zone)) return unknown(to.zone);
      if (to.kind === 'actor') {
        const holder = world.actors[to.actor];
        if (holder === undefined) return unknown(to.actor);
        if (holder.status === 'withdrawn') return err({ code: 'holder_withdrawn', ref: to.actor });
      }
      return withWorld({ items: { ...world.items, [effect.item]: { ...item, location: to } } });
    }
    case 'adjustCounter': {
      const item = world.items[effect.item];
      if (item === undefined) return unknown(effect.item);
      const value = item.counters[effect.counter];
      if (value === undefined) return unknown(effect.counter);
      if (!Number.isInteger(effect.delta)) return err({ code: 'non_integer', ref: effect.counter });
      if (value + effect.delta < 0) return err({ code: 'negative_counter', ref: effect.counter });
      const counters = { ...item.counters, [effect.counter]: value + effect.delta };
      return withWorld({ items: { ...world.items, [effect.item]: { ...item, counters } } });
    }
    case 'setInjury': {
      const actor = world.actors[effect.actor];
      if (actor === undefined) return unknown(effect.actor);
      return withWorld({ actors: { ...world.actors, [effect.actor]: { ...actor, injury: effect.level } } });
    }
    case 'setActorStatus': {
      const actor = world.actors[effect.actor];
      if (actor === undefined) return unknown(effect.actor);
      return withWorld({ actors: { ...world.actors, [effect.actor]: { ...actor, status: effect.status } } });
    }
    case 'disarmMechanism': {
      if (world.mechanisms[effect.mechanism] === undefined) return unknown(effect.mechanism);
      return withWorld({ mechanisms: { ...world.mechanisms, [effect.mechanism]: { armed: false } } });
    }
    case 'setFlag': {
      if (world.flags[effect.flag] === undefined) return unknown(effect.flag);
      return withWorld({ flags: { ...world.flags, [effect.flag]: effect.value } });
    }
    case 'advanceRng':
      return ok({ ...state, rng: effect.to });
  }
}

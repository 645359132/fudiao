import { initialKnowledge } from './cognition/knowledge';
import type { Claim, KnowledgeItem } from './cognition/types';
import type { ActorId, ClaimId, CounterKey, FlagKey, ItemId, MechanismId, ZoneId } from './ids';
import { seedRng, type RngState } from './rng';
import type { InjuryLevel } from './scene/schema';
import type { Scene } from './scene/validate';

export type ActorStatus = 'present' | 'withdrawn';

export type ActorState = {
  readonly zone: ZoneId;
  readonly injury: InjuryLevel;
  readonly status: ActorStatus;
};

/** 物品只有一个位置字段，因此任何时刻最多一个持有者。 */
export type ItemLocation =
  | { readonly kind: 'actor'; readonly actor: ActorId }
  | { readonly kind: 'zone'; readonly zone: ZoneId };

export type ItemState = {
  readonly location: ItemLocation;
  readonly counters: Readonly<Record<CounterKey, number>>;
};

export type MechanismState = { readonly armed: boolean };

export type WorldState = {
  readonly actors: Readonly<Record<ActorId, ActorState>>;
  readonly items: Readonly<Record<ItemId, ItemState>>;
  readonly mechanisms: Readonly<Record<MechanismId, MechanismState>>;
  readonly flags: Readonly<Record<FlagKey, boolean>>;
};

/** 领域内核负责的推演状态。回合阶段属于引擎的运行状态。 */
export type SimState = {
  readonly round: number;
  readonly world: WorldState;
  /** 各角色的认知，可以与世界事实不同。 */
  readonly knowledge: Readonly<Record<ActorId, readonly KnowledgeItem[]>>;
  /** 人物说法：说出的内容，不是事实。 */
  readonly claims: Readonly<Record<ClaimId, Claim>>;
  /** 已记录的“发生的事”的数目，用于分配在整次运行中唯一的标识。 */
  readonly occurrences: number;
  readonly rng: RngState;
};

export const INJURY_ORDER: readonly InjuryLevel[] = ['none', 'light', 'severe', 'incapacitated'];

export const injuryRank = (level: InjuryLevel): number => INJURY_ORDER.indexOf(level);

export function worsenInjury(level: InjuryLevel, steps: number): InjuryLevel {
  const rank = Math.min(injuryRank(level) + steps, INJURY_ORDER.length - 1);
  return INJURY_ORDER[rank] ?? 'incapacitated';
}

export function initialWorld(scene: Scene): WorldState {
  return {
    actors: Object.fromEntries(
      scene.actors.map((a) => [a.id, { zone: a.zone, injury: a.injury, status: 'present' }]),
    ),
    items: Object.fromEntries(
      scene.items.map((i) => [i.id, { location: i.location, counters: i.counters }]),
    ),
    mechanisms: Object.fromEntries(scene.mechanisms.map((m) => [m.id, { armed: true }])),
    flags: scene.flags,
  };
}

export function initialState(scene: Scene, seed: number): SimState {
  return {
    round: 0,
    world: initialWorld(scene),
    knowledge: initialKnowledge(scene),
    claims: {},
    occurrences: 0,
    rng: seedRng(seed),
  };
}

/** 物品此刻所在的区域：被持有时取持有者的区域。 */
export function itemZone(world: WorldState, item: ItemId): ZoneId | undefined {
  const location = world.items[item]?.location;
  if (location === undefined) return undefined;
  return location.kind === 'zone' ? location.zone : world.actors[location.actor]?.zone;
}

export const holds = (world: WorldState, actor: ActorId, item: ItemId): boolean => {
  const location = world.items[item]?.location;
  return location?.kind === 'actor' && location.actor === actor;
};

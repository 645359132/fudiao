// 属性测试用的随机场景、行动与裁决。仅供测试使用。
import fc from 'fast-check';
import type { Action } from '../actions';
import type { Adjudication } from '../adjudicate';
import { applyEffects, type Effect } from '../effects';
import { checkAction } from '../rules/check';
import type { SemanticRuling } from '../rulings';
import { ActionKind, InjuryLevel, type SceneSpecInput } from '../scene/schema';
import type { Scene } from '../scene/validate';
import { holds, type SimState } from '../world';
import { canMove } from '../zone-graph';
import { sceneOf } from './warehouse';

const KINDS = ActionKind.options;
const LEVELS = InjuryLevel.options;
const CONSUMED_BY: readonly ActionKind[] = ['attack', 'use_item'];

/** 从 fast-check 生成的整数序列中取值，使行动与裁决的生成可以依赖当前局面。 */
export class Tape {
  private i = 0;
  constructor(private readonly values: readonly number[]) {}
  next(): number {
    const v = this.values[this.i % this.values.length] ?? 0;
    this.i++;
    return v;
  }
  pick<T>(list: readonly T[]): T | undefined {
    return list.length === 0 ? undefined : list[this.next() % list.length];
  }
  chance(percent: number): boolean {
    return this.next() % 100 < percent;
  }
}

export const tapeArb = fc.array(fc.nat({ max: 1_000_000 }), { minLength: 1, maxLength: 200 });

export const sceneArb: fc.Arbitrary<Scene> = fc
  .record({
    zoneCount: fc.integer({ min: 2, max: 5 }),
    edges: fc.array(
      fc.record({
        a: fc.nat(4),
        b: fc.nat(4),
        adjacent: fc.boolean(),
        visible: fc.boolean(),
        sound: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
      }),
      { maxLength: 8 },
    ),
    actors: fc.array(fc.record({ zone: fc.nat(4), injury: fc.constantFrom(...LEVELS) }), {
      minLength: 2,
      maxLength: 3,
    }),
    items: fc.array(
      fc.record({
        holder: fc.option(fc.nat(2), { nil: undefined }),
        zone: fc.nat(4),
        charges: fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
        reach: fc.option(fc.constantFrom('melee' as const, 'ranged' as const), { nil: undefined }),
        use: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    contest: fc.constantFrom('draw' as const, 'ruling' as const),
    whenEmpty: fc.constantFrom('reject' as const, 'fail' as const),
    trap: fc.option(
      fc.record({ zone: fc.nat(4), injury: fc.nat(2), loudness: fc.nat(4), exemptFirst: fc.boolean() }),
      { nil: undefined },
    ),
    exitAtFirst: fc.boolean(),
  })
  .map((g): Scene => {
    const zoneIds = Array.from({ length: g.zoneCount }, (_, i) => `z${i}`);
    const zoneOf = (n: number) => zoneIds[n % zoneIds.length]!;
    const actorIds = g.actors.map((_, i) => `a${i}`);
    const seen = new Set<string>();
    const edges = g.edges.flatMap((e) => {
      const [a, b] = [zoneOf(e.a), zoneOf(e.b)];
      const key = [a, b].sort().join('|');
      if (a === b || seen.has(key)) return [];
      seen.add(key);
      return [{ between: [a, b] as [string, string], adjacent: e.adjacent, visible: e.visible, sound: e.sound }];
    });
    const items = g.items.map((it, i) => {
      const counters: Record<string, number> = it.charges === undefined ? {} : { charges: it.charges };
      return {
      id: `i${i}`,
      name: `物品${i}`,
      location:
        it.holder !== undefined && it.holder < actorIds.length
          ? { kind: 'actor' as const, actor: actorIds[it.holder]! }
          : { kind: 'zone' as const, zone: zoneOf(it.zone) },
      counters,
      ...(it.reach && { reach: it.reach }),
      ...(it.use !== undefined && { use: { loudness: it.use } }),
      };
    });
    const spec: SceneSpecInput = {
      zones: zoneIds.map((id) => ({ id, name: id })),
      edges,
      actors: g.actors.map((a, i) => ({ id: actorIds[i]!, name: actorIds[i]!, zone: zoneOf(a.zone), injury: a.injury })),
      items,
      mechanisms: g.trap
        ? [
            {
              id: 'trap',
              name: '机关',
              zone: zoneOf(g.trap.zone),
              trigger: 'enter',
              exempt: g.trap.exemptFirst ? [actorIds[0]!] : [],
              effect: { injury: g.trap.injury, loudness: g.trap.loudness },
            },
          ]
        : [],
      exits: g.exitAtFirst ? [zoneIds[0]!] : [],
      rules: {
        consumption: items
          .filter((it) => 'charges' in it.counters)
          .map((it) => ({
            item: it.id,
            counter: 'charges',
            kinds: [...CONSUMED_BY],
            amount: 1,
            whenEmpty: g.whenEmpty,
          })),
        contests: { take: g.contest },
      },
    };
    return sceneOf(spec);
  });

/** 为每个在场角色生成一条通过检查的行动；不合法的提案改为等待。 */
export function randomActions(scene: Scene, state: SimState, tape: Tape): Action[] {
  const zones = scene.zones.map((z) => z.id);
  const items = scene.items.map((i) => i.id);
  const actors = scene.actors.map((a) => a.id);
  const targets: string[] = [...actors, ...zones, ...items];
  const actions: Action[] = [];

  for (const actor of actors) {
    const self = state.world.actors[actor];
    if (self?.status !== 'present') continue;
    const kind = tape.pick(KINDS) ?? 'wait';
    // 多数时候选取合理的参数，让较多提案通过检查；少数时候随机选取，覆盖拒绝与失败路径。
    const plausible = tape.chance(80);
    const held = items.filter((i) => holds(state.world, actor, i));
    const lying = items.filter((i) => {
      const loc = state.world.items[i]?.location;
      return loc?.kind === 'zone' && loc.zone === self.zone;
    });
    const others = actors.filter((a) => a !== actor);
    const neighbours = zones.filter((z) => canMove(scene, state.world.flags, self.zone, z));

    const target = plausible && ['attack', 'probe', 'other', 'speak'].includes(kind)
      ? tape.pick(others)
      : tape.chance(40) ? tape.pick(targets) : undefined;
    const item = plausible
      ? kind === 'take' ? tape.pick(lying) : ['use_item', 'drop'].includes(kind) || tape.chance(30) ? tape.pick(held) : undefined
      : tape.chance(40) ? tape.pick(items) : undefined;
    const toZone = kind === 'move' ? tape.pick(plausible && neighbours.length > 0 ? neighbours : zones) : undefined;

    const candidate: Action = {
      actor,
      kind,
      ...(target !== undefined && { target }),
      ...(item !== undefined && { item }),
      ...(toZone !== undefined && { toZone }),
      ...(kind === 'speak' && {
        utterance: {
          sentences: ['一', '二', '三'].slice(0, 1 + (tape.next() % 3)),
          volume: tape.pick(['whisper', 'normal', 'shout'] as const) ?? 'normal',
          ...(tape.chance(30) && { deliveredCount: tape.next() % 2 }),
        },
      }),
    };
    const result = checkAction(scene, state, candidate);
    actions.push(result.kind === 'reject' ? { actor, kind: 'wait' } : candidate);
  }
  return actions;
}

/** 为每个请求生成范围内的裁决：调整涉及角色的伤势，把涉及的物品交给在场的涉及角色。 */
export function randomRulings(
  scene: Scene,
  state: SimState,
  adjudication: Adjudication,
  tape: Tape,
): SemanticRuling[] {
  const afterProgram = applyEffects(scene, state, adjudication.effects);
  if (!afterProgram.ok) throw new Error('程序效果不应违反不变式');
  const world = afterProgram.value.world;

  return adjudication.pending.map((request) => {
    const effects: Effect[] = [];
    const present = request.actors.filter((a) => world.actors[a]?.status === 'present');
    if (tape.chance(50)) {
      const actor = tape.pick(request.actors);
      const level = tape.pick(LEVELS);
      if (actor && level) effects.push({ type: 'setInjury', actor, level });
    }
    for (const item of request.contested.length > 0 ? request.contested : request.items) {
      const to = tape.pick(present);
      if (to && tape.chance(50)) effects.push({ type: 'transferItem', item, to: { kind: 'actor', actor: to } });
    }
    const zone = world.actors[request.actors[0]!]?.zone;
    return {
      requestId: request.id,
      effects,
      occurrences: zone
        ? [{ participants: request.actors, zones: [zone], visible: true, loudness: tape.next() % 4, description: {} }]
        : [],
    };
  });
}

/** 递归冻结，用来发现对“不可变”数据的意外修改。 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

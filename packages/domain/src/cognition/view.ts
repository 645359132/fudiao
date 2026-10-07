import type { ActorId, ItemId, MechanismId, ZoneId } from '../ids';
import type { CharacterCard, InjuryLevel } from '../scene/schema';
import type { Scene } from '../scene/validate';
import type { ActorStatus, SimState } from '../world';
import { canSee } from '../zone-graph';
import type { Claim, KnowledgeItem } from './types';

declare const lens: unique symbol;

/**
 * 角色视图：角色代理唯一的输入（硬性规则 1）。只能由 buildCharacterView 生成，
 * 角色提示词模板的参数类型就是它，因此在类型层面拿不到世界状态。
 */
export type CharacterView = {
  readonly actorId: ActorId;
  readonly round: number;
  readonly self: {
    readonly name: string;
    readonly zone: ZoneId;
    readonly injury: InjuryLevel;
    readonly status: ActorStatus;
    /** 本人的角色卡。初始认知已在 knowledge 中，这里不重复。 */
    readonly card: Omit<CharacterCard, 'initialKnowledge'>;
    readonly items: readonly {
      readonly id: ItemId;
      readonly name: string;
      readonly counters: Readonly<Record<string, number>>;
      readonly reach?: 'melee' | 'ranged';
    }[];
  };
  /** 场景布局视为公开：区域、相邻与可见关系、出口。 */
  readonly map: {
    readonly zones: readonly { readonly id: ZoneId; readonly name: string }[];
    readonly edges: readonly {
      readonly between: readonly [ZoneId, ZoneId];
      readonly adjacent: boolean;
      readonly visible: boolean;
    }[];
    readonly exits: readonly ZoneId[];
  };
  /** 此刻看得见的内容。他人的伤势与物品计数看不见，只能推测。 */
  readonly visible: {
    readonly actors: readonly {
      readonly id: ActorId;
      readonly name: string;
      readonly zone: ZoneId;
      readonly holding: readonly { readonly id: ItemId; readonly name: string }[];
    }[];
    readonly items: readonly { readonly id: ItemId; readonly name: string; readonly zone: ZoneId }[];
    readonly mechanisms: readonly { readonly id: MechanismId; readonly name: string; readonly zone: ZoneId }[];
  };
  /** 本人有效的认知条目。 */
  readonly knowledge: readonly KnowledgeItem[];
  /** 本人听清的人物说法。 */
  readonly claims: readonly Claim[];
  /**
   * 视图中出现过的标识对应的名称（例如认知里提到、此刻已看不见的人与物）。
   * 只为已在视图中的标识提供名称，不引入新的信息。
   */
  readonly names: readonly { readonly id: string; readonly name: string }[];
  readonly [lens]: 'character';
};

/**
 * 按信息权限构建角色视图。不包含场景标题、题材、探索问题、秘密、
 * 其他角色的角色卡与认知、随机数状态（B24、B44）。
 */
export function buildCharacterView(scene: Scene, state: SimState, actor: ActorId): CharacterView {
  const { world } = state;
  const me = world.actors[actor];
  const spec = scene.actors.find((a) => a.id === actor);
  if (me === undefined || spec === undefined) throw new Error(`未知角色：${actor}`);
  const present = me.status === 'present';
  const sees = (zone: ZoneId) => present && canSee(scene, me.zone, zone);

  const knowledge = (state.knowledge[actor] ?? []).filter((k) => k.status === 'active');
  const mentioned = new Set(knowledge.flatMap((k) => k.about));
  const claimIds = new Set(knowledge.flatMap((k) => (k.body.kind === 'claim' ? [k.body.claim] : [])));
  const { initialKnowledge, ...card } = spec.card;

  const view: Omit<CharacterView, typeof lens | 'names'> = {
    actorId: actor,
    round: state.round,
    self: {
      name: spec.name,
      zone: me.zone,
      injury: me.injury,
      status: me.status,
      card,
      items: scene.items
        .filter((i) => {
          const loc = world.items[i.id]?.location;
          return loc?.kind === 'actor' && loc.actor === actor;
        })
        .map((i) => ({
          id: i.id,
          name: i.name,
          counters: world.items[i.id]?.counters ?? {},
          ...(i.reach && { reach: i.reach }),
        })),
    },
    map: {
      zones: scene.zones.map((z) => ({ id: z.id, name: z.name })),
      edges: scene.edges.map((e) => ({ between: e.between, adjacent: e.adjacent, visible: e.visible })),
      exits: scene.exits,
    },
    visible: {
      actors: scene.actors
        .filter((a) => {
          const other = world.actors[a.id];
          return a.id !== actor && other?.status === 'present' && sees(other.zone);
        })
        .map((a) => ({
          id: a.id,
          name: a.name,
          zone: world.actors[a.id]!.zone,
          holding: scene.items
            .filter((i) => {
              const loc = world.items[i.id]?.location;
              return !i.concealed && loc?.kind === 'actor' && loc.actor === a.id;
            })
            .map((i) => ({ id: i.id, name: i.name })),
        })),
      items: scene.items.flatMap((i) => {
        const loc = world.items[i.id]?.location;
        return loc?.kind === 'zone' && sees(loc.zone) ? [{ id: i.id, name: i.name, zone: loc.zone }] : [];
      }),
      mechanisms: scene.mechanisms
        .filter((m) => (!m.hidden && sees(m.zone)) || mentioned.has(m.id))
        .map((m) => ({ id: m.id, name: m.name, zone: m.zone })),
    },
    knowledge,
    claims: Object.values(state.claims).filter((c) => claimIds.has(c.id)),
  };
  const ids = collectIds(view);
  const names = [...scene.zones, ...scene.actors, ...scene.items, ...scene.mechanisms]
    .filter((entity) => ids.has(entity.id))
    .map((entity) => ({ id: entity.id, name: entity.name }));
  const complete: Omit<CharacterView, typeof lens> = { ...view, names };
  return complete as CharacterView;
}

/** 视图中出现过的全部标识。角色提出的推测只能引用这些标识。 */
export const viewIds = (view: CharacterView): ReadonlySet<string> => collectIds(view);

function collectIds(view: Omit<CharacterView, typeof lens | 'names'>): Set<string> {
  const ids = new Set<string>([view.actorId, ...view.map.exits]);
  for (const z of view.map.zones) ids.add(z.id);
  for (const i of view.self.items) ids.add(i.id);
  for (const a of view.visible.actors) {
    ids.add(a.id);
    for (const i of a.holding) ids.add(i.id);
  }
  for (const i of view.visible.items) ids.add(i.id);
  for (const m of view.visible.mechanisms) ids.add(m.id);
  for (const k of view.knowledge) {
    for (const ref of k.about) ids.add(ref);
    if (k.concerning !== undefined) ids.add(k.concerning);
  }
  for (const c of view.claims) {
    ids.add(c.speaker);
    if (c.addressee !== undefined) ids.add(c.addressee);
  }
  return ids;
}

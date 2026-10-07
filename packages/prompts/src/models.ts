import type { CharacterView, Claim, KnowledgeItem, Observation, RuleViolation } from '@fudiao/domain';
import type { RenderContext } from './engine';

// 渲染模型只包含数据：名称、标识、数值与布尔标志。所有文字都在模板文件中。

export type Names = (id: string | undefined | null) => string | null;

export function namesOf(entries: readonly { readonly id: string; readonly name: string }[]): Names {
  const map = new Map(entries.map((e) => [e.id, e.name]));
  return (id) => (id === undefined || id === null ? null : (map.get(id) ?? id));
}

/** 把枚举值变成模板可以判断的标志：{ light: true }。 */
export const flag = (value: string): RenderContext => ({ [value]: true });

export function violationModel(v: RuleViolation, names: Names): RenderContext {
  return { v: flag(v.code), ref: names(v.ref) ?? '' };
}

/** 观察的渲染模型。viewer 为 null 时（裁决者看到的结算结果）用名字称呼行动者。 */
export function observationModel(o: Observation, names: Names, viewer: string | null): RenderContext {
  const speech = o.speech;
  return {
    sound: o.channel === 'sound',
    // 语义裁决与外部事件只有描述文字。
    ruled: o.kind === 'ruled' || o.kind === 'external',
    who: o.actor !== undefined && o.actor === viewer ? '你' : (names(o.actor) ?? '有人'),
    kind: o.kind === undefined ? null : flag(o.kind),
    zone: names(o.zones[0]) ?? '',
    toZone: names(o.zones[1]),
    item: names(o.item),
    target: names(o.target),
    mechanism: names(o.mechanism),
    attempted: o.attempted === undefined ? null : { k: flag(o.attempted) },
    violation: o.violation === undefined ? null : violationModel(o.violation, names),
    speechFull: speech?.clarity === 'full' ? speech.sentences.join('') : null,
    speechMuffled: speech?.clarity === 'muffled',
    speechUnheard: speech?.clarity === 'unheard',
    soundKind: o.sound === undefined ? null : flag(o.sound),
    visual: o.description?.visual ?? null,
    soundText: o.description?.sound ?? null,
  };
}

export function knowledgeModel(
  k: KnowledgeItem,
  names: Names,
  viewer: string,
  claims: readonly Claim[],
): RenderContext {
  const body = k.body;
  const claim = body.kind === 'claim' ? claims.find((c) => c.id === body.claim) : undefined;
  return {
    id: k.id,
    round: k.round,
    modality: flag(k.modality),
    confidence: k.confidence === null ? null : Number(k.confidence.toFixed(2)),
    second: k.order === 2,
    concerning: names(k.concerning),
    text: body.kind === 'text' ? body.text : null,
    obs: body.kind === 'observation' ? observationModel(body.observation, names, viewer) : null,
    claim: claim === undefined ? null : { speaker: names(claim.speaker) ?? '', sentences: claim.sentences.join('') },
  };
}

const card = (view: CharacterView): RenderContext => {
  const c = view.self.card;
  return {
    goal: c.goal ?? null,
    bottomLine: c.bottomLine ?? null,
    traits: c.traits,
    riskPreference: c.riskPreference ?? null,
    emotionThreshold: c.emotionThreshold ?? null,
    lossOfControl: c.lossOfControl ?? null,
    speechStyle: c.speechStyle ?? null,
  };
};

/** 角色视图的渲染模型：角色提示词唯一的数据来源。 */
export function viewModel(view: CharacterView): RenderContext {
  const names = namesOf([...view.names, { id: view.actorId, name: view.self.name }]);
  const viewer = view.actorId;
  return {
    actorId: viewer,
    round: view.round,
    self: {
      name: view.self.name,
      zone: names(view.self.zone) ?? '',
      injury: flag(view.self.injury),
      withdrawn: view.self.status === 'withdrawn',
      items: view.self.items.map((i) => ({
        id: i.id,
        name: i.name,
        counters: Object.entries(i.counters).map(([name, value]) => ({ name, value })),
      })),
    },
    card: card(view),
    hasTraits: view.self.card.traits.length > 0,
    map: {
      zones: view.map.zones.map((z) => ({ id: z.id, name: z.name })),
      edges: view.map.edges.map((e) => ({
        a: names(e.between[0]) ?? '',
        b: names(e.between[1]) ?? '',
        adjacent: e.adjacent,
        visible: e.visible,
      })),
      exits: view.map.exits.map((z) => names(z) ?? z),
    },
    hasExits: view.map.exits.length > 0,
    visible: {
      actors: view.visible.actors.map((a) => ({
        id: a.id,
        name: a.name,
        zone: names(a.zone) ?? '',
        holding: a.holding.map((h) => ({ id: h.id, name: h.name })),
        holdsSomething: a.holding.length > 0,
      })),
      items: view.visible.items.map((i) => ({ id: i.id, name: i.name, zone: names(i.zone) ?? '' })),
      mechanisms: view.visible.mechanisms.map((m) => ({ id: m.id, name: m.name, zone: names(m.zone) ?? '' })),
    },
    knowledge: view.knowledge.map((k) => knowledgeModel(k, names, viewer, view.claims)),
  };
}


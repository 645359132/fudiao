import type { SceneSpecInput } from '@fudiao/domain';
import type { SceneDraftOutput } from './schemas';

const optional = (s: string) => (s.trim() === '' ? undefined : s);

/**
 * 把模型给出的扁平草稿转换为场景配置。只做结构转换，不做校验；
 * 结果交给 parseScene 校验，错误连同路径展示给作者修改（B39）。
 */
export function sceneDraftToSpec(draft: SceneDraftOutput): SceneSpecInput {
  return {
    zones: draft.zones,
    edges: draft.edges.map((e) => ({
      between: [e.a, e.b],
      adjacent: e.adjacent,
      visible: e.visible,
      sound: e.sound,
      ...(e.requiresFlag !== null && { requiresFlag: e.requiresFlag }),
    })),
    flags: Object.fromEntries(draft.flags.map((f) => [f.key, f.value])),
    actors: draft.actors.map((a) => ({
      id: a.id,
      name: a.name,
      zone: a.zone,
      injury: a.injury,
      card: {
        goal: optional(a.goal),
        bottomLine: optional(a.bottomLine),
        traits: a.traits,
        riskPreference: optional(a.riskPreference),
        emotionThreshold: optional(a.emotionThreshold),
        lossOfControl: optional(a.lossOfControl),
        speechStyle: optional(a.speechStyle),
        // 内容为空的条目（模型省掉了 text 又没有别名）丢弃，不让它卡住校验。
        initialKnowledge: a.knowledge
          .filter((k) => k.text.trim() !== '')
          .map((k) => ({
            text: k.text,
            modality: k.modality,
            confidence: k.confidence,
            about: k.about,
            order: k.concerning === null ? 1 : 2,
            ...(k.concerning !== null && { concerning: k.concerning }),
          })),
      },
    })),
    items: draft.items.map((i) => ({
      id: i.id,
      name: i.name,
      location: i.holder !== null ? { kind: 'actor', actor: i.holder } : { kind: 'zone', zone: i.zone ?? '' },
      counters: Object.fromEntries(i.counters.map((c) => [c.name, c.value])),
      ...(i.reach !== null && { reach: i.reach }),
      ...(i.noise !== null && { use: { loudness: i.noise } }),
      concealed: i.concealed,
    })),
    mechanisms: draft.mechanisms.map((m) => ({
      id: m.id,
      name: m.name,
      zone: m.zone,
      trigger: 'enter',
      exempt: m.exempt,
      hidden: m.hidden,
      effect: { injury: m.injury, loudness: m.loudness },
    })),
    secrets: draft.secrets,
    exits: draft.exits,
    rules: {
      consumption: draft.consumption,
      injuryLimits: draft.injuryLimits.map((l) => ({
        ...(l.actor !== null && { actor: l.actor }),
        atLeast: l.atLeast,
        forbidKinds: l.forbidKinds,
        forbidItems: l.forbidItems,
      })),
      requirements: draft.requirements.map((r) => ({
        target: r.target,
        ...(r.kinds.length > 0 && { kinds: r.kinds }),
        requiresHolding: r.requiresHolding,
        whenMissing: r.whenMissing,
        ...(r.setsFlag !== null && { onSuccess: { setFlag: r.setsFlag, value: true } }),
      })),
      contests: { take: draft.contest },
      narrativeRules: draft.narrativeRules,
    },
  };
}

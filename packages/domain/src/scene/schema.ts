import { z } from 'zod';
import { ActorId, CounterKey, FlagKey, ItemId, MechanismId, SecretId, ZoneId } from '../ids';

export const ActionKind = z.enum([
  'observe',
  'move',
  'probe',
  'attack',
  'defend',
  'use_item',
  'take',
  'drop',
  'speak',
  'withdraw',
  'wait',
  'other',
]);
export type ActionKind = z.infer<typeof ActionKind>;

export const InjuryLevel = z.enum(['none', 'light', 'severe', 'incapacitated']);
export type InjuryLevel = z.infer<typeof InjuryLevel>;

export const Volume = z.enum(['whisper', 'normal', 'shout']);
export type Volume = z.infer<typeof Volume>;

/** 当前尚未达到或无法满足条件时，提案被拒绝（请求修正）还是形成失败尝试。 */
export const OnUnmet = z.enum(['reject', 'fail']);
export type OnUnmet = z.infer<typeof OnUnmet>;

const Amount = z.number().int().nonnegative();
const Counters = z.record(CounterKey, Amount);

export const ItemLocation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('actor'), actor: ActorId }),
  z.object({ kind: z.literal('zone'), zone: ZoneId }),
]);
export type ItemLocation = z.infer<typeof ItemLocation>;

export const ZoneSpec = z.object({ id: ZoneId, name: z.string().min(1) });

export const EdgeSpec = z.object({
  between: z.tuple([ZoneId, ZoneId]),
  /** 可以在一回合内移动通过。 */
  adjacent: z.boolean(),
  /** 两区域互相可见。视线不传递。 */
  visible: z.boolean(),
  /** 声音经过这条边时的衰减量；null 表示声音无法通过。 */
  sound: Amount.nullable(),
  /** 只有该标记为 true 时才能通行，例如锁住的门。 */
  requiresFlag: FlagKey.optional(),
});
export type EdgeSpec = z.infer<typeof EdgeSpec>;

export const Modality = z.enum(['observed', 'heard', 'inferred', 'claimed']);
export type Modality = z.infer<typeof Modality>;

const Confidence = z.number().min(0).max(1);

/** 角色卡中的初始认知。秘密与错误信念都写成初始认知；人物说法只能来自台词。 */
export const InitialKnowledge = z.object({
  text: z.string().min(1),
  modality: z.enum(['observed', 'heard', 'inferred']).default('observed'),
  confidence: Confidence.default(1),
  /** 涉及的角色、区域、物品或机关的键。 */
  about: z.array(z.string().min(1)).default([]),
  /** 1 为一阶认知；2 为“concerning 认为我……”的推测。 */
  order: z.union([z.literal(1), z.literal(2)]).default(1),
  concerning: ActorId.optional(),
});

/** 角色卡（B23）。只进入角色本人的视图。 */
export const CharacterCard = z.object({
  goal: z.string().optional(),
  bottomLine: z.string().optional(),
  traits: z.array(z.string()).default([]),
  riskPreference: z.string().optional(),
  emotionThreshold: z.string().optional(),
  lossOfControl: z.string().optional(),
  speechStyle: z.string().optional(),
  // 首版原型每个角色最多五条初始认知（需求 I04“首版原型范围”）。
  initialKnowledge: z.array(InitialKnowledge).max(5).default([]),
});
export type CharacterCard = z.infer<typeof CharacterCard>;

export const ActorSpec = z.object({
  id: ActorId,
  name: z.string().min(1),
  zone: ZoneId,
  injury: InjuryLevel.default('none'),
  card: CharacterCard.prefault({}),
});

export const ItemSpec = z.object({
  id: ItemId,
  name: z.string().min(1),
  location: ItemLocation,
  counters: Counters.default({}),
  /** 作为武器时的距离：近战要求同区域，远程要求可见。 */
  reach: z.enum(['melee', 'ranged']).optional(),
  /** 使用时由程序直接结算的效果；未配置时 use_item 交给语义裁决。 */
  use: z.object({ loudness: Amount }).optional(),
  /** 被持有时他人看不见，例如藏在怀里的密信。 */
  concealed: z.boolean().default(false),
  /**
   * 物品上写着的内容（例如信）。持有者使用这件物品时读到，旁人只看见他在用这件物品。
   * 与作者的秘密不同，内容是角色读了就会知道的文字。
   */
  content: z.string().min(1).optional(),
});

/** 作者标记的秘密。text 只给作者与命中判断使用，永远不进入角色视图。 */
export const SecretSpec = z.object({
  id: SecretId,
  text: z.string().min(1),
  /** 涉及的对象，用于筛选与秘密相关的推测。 */
  subjects: z.array(z.string().min(1)).min(1),
  /** 合法知道该秘密的角色，其推测不需要证据链。 */
  knownBy: z.array(ActorId).default([]),
});

/** 场景标题、题材与探索问题只供作者使用，不进入角色视图（B44）。 */
export const SceneMeta = z.object({
  title: z.string().optional(),
  genre: z.string().optional(),
  questions: z.array(z.string()).default([]),
});

export const ConsumptionRule = z.object({
  item: ItemId,
  counter: CounterKey,
  kinds: z.array(ActionKind).min(1),
  amount: z.number().int().positive(),
  whenEmpty: OnUnmet,
});

export const InjuryLimit = z.object({
  /** 未填写时适用于所有角色。 */
  actor: ActorId.optional(),
  atLeast: InjuryLevel,
  forbidKinds: z.array(ActionKind).default([]),
  forbidItems: z.array(ItemId).default([]),
});

export const Requirement = z.object({
  /** 行动的 target，可以是角色、区域、物品或机关的键。 */
  target: z.string().min(1),
  /** 未填写时适用于所有行动种类。 */
  kinds: z.array(ActionKind).optional(),
  requiresHolding: ItemId,
  whenMissing: OnUnmet,
  onSuccess: z.object({ setFlag: FlagKey, value: z.boolean() }).optional(),
});

export const MechanismSpec = z.object({
  id: MechanismId,
  name: z.string().min(1),
  zone: ZoneId,
  trigger: z.literal('enter'),
  exempt: z.array(ActorId).default([]),
  /** 隐藏的机关只能由同区域的 observe 发现。 */
  hidden: z.boolean().default(true),
  effect: z.object({
    /** 伤势加重的等级数。 */
    injury: Amount.default(0),
    loudness: Amount,
  }),
});

export const LoudnessTable = z.object({
  observe: Amount.default(0),
  move: Amount.default(1),
  probe: Amount.default(1),
  attack: Amount.default(3),
  defend: Amount.default(0),
  use_item: Amount.default(1),
  take: Amount.default(1),
  drop: Amount.default(1),
  withdraw: Amount.default(1),
  other: Amount.default(1),
  failed: Amount.default(1),
  /** 其他区域的听者在声音衰减后的余量不低于此值时能听清台词；同区域总能听清。 */
  speechClarity: z.number().int().positive().default(2),
  speak: z
    .object({
      whisper: z.number().int().positive().default(1),
      normal: z.number().int().positive().default(2),
      shout: z.number().int().positive().default(4),
    })
    .prefault({}),
});
export type LoudnessTable = z.infer<typeof LoudnessTable>;

export const SceneSpec = z.object({
  meta: SceneMeta.prefault({}),
  zones: z.array(ZoneSpec).min(1),
  edges: z.array(EdgeSpec).default([]),
  actors: z.array(ActorSpec).min(1),
  items: z.array(ItemSpec).default([]),
  mechanisms: z.array(MechanismSpec).default([]),
  secrets: z.array(SecretSpec).default([]),
  flags: z.record(FlagKey, z.boolean()).default({}),
  /** 可以撤离的区域；为空时任意区域都可撤离。 */
  exits: z.array(ZoneId).default([]),
  /** 场景时钟：从第几回合起是什么时辰，按回合递增。公开信息，进入每个人的视图。 */
  clock: z.array(z.object({ fromRound: z.number().int().min(1), label: z.string().min(1) })).default([]),
  rules: z
    .object({
      consumption: z.array(ConsumptionRule).default([]),
      injuryLimits: z.array(InjuryLimit).default([]),
      requirements: z.array(Requirement).default([]),
      /** 多人同轮拾取同一物品：draw 用推演状态中的随机数抽取，ruling 交给语义裁决。 */
      contests: z.object({ take: z.enum(['draw', 'ruling']).default('ruling') }).prefault({}),
      /** 原语无法表达的规则以自然语言记录，交给语义裁决（B41）。不进入角色视图。 */
      narrativeRules: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  loudness: LoudnessTable.prefault({}),
});
export type SceneSpecInput = z.input<typeof SceneSpec>;
export type SceneSpec = z.infer<typeof SceneSpec>;

import { ActionKind, InjuryLevel, Volume } from '@fudiao/domain';
import { CHAPTER_TYPES, DIALOGUE_LEVELS, ENDING_STYLES } from '@fudiao/shared';
import { z } from 'zod';

// 模型输出的 schema。字段全部必填，可缺省的用 nullable 表示：
// 这样同一份定义可以同时用于 Anthropic 与 OpenAI 的严格结构化输出。

const Confidence = z.number().min(0).max(1);

/** 角色行动提案（B25），内心片段与推测在同一次调用中返回（B43）。 */
export const ActionProposal = z.object({
  kind: ActionKind,
  target: z.string().nullable(),
  item: z.string().nullable(),
  toZone: z.string().nullable(),
  utterance: z.object({ sentences: z.array(z.string()), volume: Volume }).nullable(),
  /** 旁人能看到的具体动作；其他、使用物品、试探、攻击等需要裁决的行动必须写清，其余可为 null。 */
  description: z.string().nullable(),
  /** 轮流对话中听到第几句后打断；0 表示对方一开口就打断，null 表示听完。 */
  interruptAfter: z.number().int().min(0).nullable(),
  intent: z.string(),
  rationale: z.string(),
  beliefRefs: z.array(z.string()),
  innerThought: z.string(),
  /** 本回合被触发的情绪阈值或失控条件；只记录，不参与裁决。 */
  triggered: z.enum(['emotion', 'loss_of_control']).nullable(),
  inferences: z.array(
    z.object({
      content: z.string(),
      about: z.array(z.string()),
      confidence: Confidence,
      concerning: z.string().nullable(),
    }),
  ),
});
export type ActionProposal = z.infer<typeof ActionProposal>;

const RulingEffect = z.discriminatedUnion('type', [
  z.object({ type: z.literal('moveActor'), actor: z.string(), to: z.string() }),
  z.object({ type: z.literal('transferItem'), item: z.string(), toActor: z.string().nullable(), toZone: z.string().nullable() }),
  z.object({ type: z.literal('adjustCounter'), item: z.string(), counter: z.string(), delta: z.number().int() }),
  z.object({ type: z.literal('setInjury'), actor: z.string(), level: InjuryLevel }),
  z.object({ type: z.literal('setActorStatus'), actor: z.string(), status: z.enum(['present', 'withdrawn']) }),
  z.object({ type: z.literal('setFlag'), flag: z.string(), value: z.boolean() }),
]);
export type RulingEffect = z.infer<typeof RulingEffect>;

/** 语义裁决：效果、发生的事及其视觉与声音描述、待核实项。 */
export const SemanticRulingOutput = z.object({
  rationale: z.string(),
  effects: z.array(RulingEffect),
  occurrences: z.array(
    z.object({
      participants: z.array(z.string()),
      zones: z.array(z.string()),
      visible: z.boolean(),
      loudness: z.number().int().min(0),
      visual: z.string().nullable(),
      sound: z.string().nullable(),
    }),
  ),
  uncertainties: z.array(z.string()),
});
export type SemanticRulingOutput = z.infer<typeof SemanticRulingOutput>;

/** 认知更新：新增推测、修改相信程度、撤回条目。 */
export const BeliefUpdateOutput = z.object({
  add: z.array(
    z.object({
      content: z.string(),
      about: z.array(z.string()),
      confidence: Confidence,
      concerning: z.string().nullable(),
    }),
  ),
  revise: z.array(z.object({ id: z.string(), confidence: Confidence })),
  retract: z.array(z.string()),
});
export type BeliefUpdateOutput = z.infer<typeof BeliefUpdateOutput>;

/** 证据链命中判断（B44）：结果只作为提示，不作为结论。 */
export const EvidenceJudgementOutput = z.object({
  judgements: z.array(
    z.object({ inference: z.string(), secret: z.string(), hit: z.boolean(), supported: z.boolean(), explanation: z.string() }),
  ),
});
export type EvidenceJudgementOutput = z.infer<typeof EvidenceJudgementOutput>;

export const BeatTreatment = z.enum(['expand', 'brief', 'omit', 'flashback', 'blank']);

/** 节拍表（B45）：每个节拍指向视角角色的一条认知。 */
export const BeatSheetOutput = z.object({
  beats: z.array(
    z.object({ ref: z.string(), treatment: BeatTreatment, note: z.string(), withhold: z.boolean() }),
  ),
});
export type BeatSheetOutput = z.infer<typeof BeatSheetOutput>;

/**
 * 场景配置草稿里的一条初始认知。模型（尤其是兼容接口上的 Gemini）常把 null 与空数组的字段省掉、把 text 写成 content，
 * 以前一律按不合格重试三次后暂停（作者反馈 2026-10-29）；现在发给模型的 schema 仍是全字段必填，本地解析时缺的按默认值补、
 * text 的常见别名也认，内容为空的条目由 sceneDraftToSpec 丢弃。
 */
const KNOWLEDGE_TEXT_ALIASES = ['content', 'fact', 'statement', 'belief', 'knowledge', 'description'] as const;
const DraftKnowledge = z
  .looseObject({
    text: z.string().default(''),
    modality: z.enum(['observed', 'heard', 'inferred']).default('observed'),
    confidence: Confidence.default(1),
    about: z.array(z.string()).default([]),
    concerning: z.string().nullable().default(null),
  })
  .transform((k) => {
    const alias = KNOWLEDGE_TEXT_ALIASES.map((key) => k[key]).find((v): v is string => typeof v === 'string' && v.trim() !== '');
    return { text: k.text.trim() !== '' ? k.text : (alias ?? ''), modality: k.modality, confidence: k.confidence, about: k.about, concerning: k.concerning };
  });

/**
 * 场景配置草稿（B39）。结构比场景配置扁平，由 sceneDraftToSpec 转换后再经 parseScene 校验。
 * 发给模型的 schema 全字段必填（modelJsonSchema 会把 default 去掉、全部列为 required）；本地解析时列表与可空的字段缺了按默认值补。
 */
export const SceneDraftOutput = z.object({
  zones: z.array(z.object({ id: z.string(), name: z.string() })),
  edges: z
    .array(
      z.object({
        a: z.string(),
        b: z.string(),
        adjacent: z.boolean().default(true),
        visible: z.boolean().default(false),
        sound: z.number().int().min(0).nullable().default(null),
        requiresFlag: z.string().nullable().default(null),
      }),
    )
    .default([]),
  flags: z.array(z.object({ key: z.string(), value: z.boolean() })).default([]),
  actors: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      zone: z.string(),
      injury: InjuryLevel.default('none'),
      goal: z.string().default(''),
      bottomLine: z.string().default(''),
      traits: z.array(z.string()).default([]),
      riskPreference: z.string().default(''),
      emotionThreshold: z.string().default(''),
      lossOfControl: z.string().default(''),
      speechStyle: z.string().default(''),
      knowledge: z.array(DraftKnowledge).default([]),
    }),
  ),
  items: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        holder: z.string().nullable().default(null),
        zone: z.string().nullable().default(null),
        counters: z.array(z.object({ name: z.string(), value: z.number().int().min(0) })).default([]),
        reach: z.enum(['melee', 'ranged']).nullable().default(null),
        noise: z.number().int().min(0).nullable().default(null),
        concealed: z.boolean().default(false),
      }),
    )
    .default([]),
  mechanisms: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        zone: z.string(),
        exempt: z.array(z.string()).default([]),
        injury: z.number().int().min(0).default(0),
        loudness: z.number().int().min(0).default(0),
        hidden: z.boolean().default(true),
      }),
    )
    .default([]),
  secrets: z
    .array(z.object({ id: z.string(), text: z.string(), subjects: z.array(z.string()).default([]), knownBy: z.array(z.string()).default([]) }))
    .default([]),
  exits: z.array(z.string()).default([]),
  consumption: z
    .array(
      z.object({
        item: z.string(),
        counter: z.string(),
        kinds: z.array(ActionKind).default([]),
        amount: z.number().int().min(1).default(1),
        whenEmpty: z.enum(['reject', 'fail']).default('reject'),
      }),
    )
    .default([]),
  injuryLimits: z
    .array(
      z.object({
        actor: z.string().nullable().default(null),
        atLeast: InjuryLevel,
        forbidKinds: z.array(ActionKind).default([]),
        forbidItems: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  requirements: z
    .array(
      z.object({
        target: z.string(),
        kinds: z.array(ActionKind).default([]),
        requiresHolding: z.string(),
        whenMissing: z.enum(['reject', 'fail']).default('reject'),
        setsFlag: z.string().nullable().default(null),
      }),
    )
    .default([]),
  contest: z.enum(['draw', 'ruling']).default('ruling'),
  narrativeRules: z.array(z.string()).default([]),
});
export type SceneDraftOutput = z.infer<typeof SceneDraftOutput>;

/**
 * 章节计划草稿（B65）：由作品大纲拆出，作者修改确认后才写入章节计划与伏笔账本。人物与伏笔用名字指代。
 * 分卷（B68）：每章的 volume 是所在卷的卷名（不分卷时为空），volumes 按顺序列出各卷的卷名与梗概。
 */
export const PlanDraftOutput = z.object({
  volumes: z.array(z.object({ title: z.string(), summary: z.string() })).default([]),
  chapters: z.array(
    z.object({
      volume: z.string().default(''),
      title: z.string(),
      goal: z.string(),
      cast: z.array(z.string()),
      beats: z.array(z.string()),
      plant: z.array(z.string()),
      payoff: z.array(z.string()),
      treatment: z.string(),
      targetWords: z.number().int().positive().nullable(),
      /** 节奏目标（B87）：章节类型、对话多少与章尾收法。较早的输出没有这一项。 */
      rhythm: z.object({ type: z.enum(CHAPTER_TYPES), dialogue: z.enum(DIALOGUE_LEVELS), ending: z.enum(ENDING_STYLES) }).nullable().default(null),
    }),
  ),
  foreshadows: z.array(z.object({ title: z.string(), content: z.string(), reveal: z.string() })),
});
export type PlanDraftOutput = z.infer<typeof PlanDraftOutput>;
/** 校验前的形状：分卷字段可以省略（不分卷的草稿、以前的录制样本）。 */
export type PlanDraftData = z.input<typeof PlanDraftOutput>;

/** 作品骨架（B67 快速成书）：由一句话的想法展开的作品名、类型、简介、大纲与主要人物；作者修改确认后才写入作品。 */
export const BookSeedOutput = z.object({
  title: z.string(),
  genre: z.string(),
  synopsis: z.string(),
  outline: z.string(),
  characters: z.array(z.object({ name: z.string(), description: z.string() })),
  /** 主要人物之间的关系（B73）：读作“from 是 to 的 label”，mutual 时双方相同。较早的输出没有这一项。 */
  relationships: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        category: z.enum(['family', 'romance', 'mentor', 'ally', 'rival', 'enemy', 'affiliation', 'other']),
        label: z.string(),
        mutual: z.boolean(),
        secret: z.boolean(),
        description: z.string(),
      }),
    )
    .default([]),
});
export type BookSeedOutput = z.infer<typeof BookSeedOutput>;
/** 作者编辑中的骨架：关系可以省略。 */
export type BookSeedData = z.input<typeof BookSeedOutput>;

/** 长篇记忆（B66）：一章的梗概、出场人物在章末的状态、有进展的伏笔。人物与伏笔用名字指代。 */
export const ChapterMemoryOutput = z.object({
  summary: z.string(),
  cast: z.array(z.object({ name: z.string(), state: z.string() })),
  foreshadows: z.array(z.object({ title: z.string(), progress: z.string() })),
  /** 章尾留给后面的事（B74）。较早的输出没有这一项。 */
  openThreads: z.array(z.string()).default([]),
});
export type ChapterMemoryOutput = z.infer<typeof ChapterMemoryOutput>;

/** 审核（B64）：问题列表。段落与依据用提示词中的标签指代，由 packages/writing 的 resolveModelIssues 换回标识并校验。 */
export const ChapterReviewOutput = z.object({
  issues: z.array(
    z.object({
      paragraph: z.string(),
      quote: z.string(),
      kind: z.enum(['setting_conflict', 'timeline', 'pov_leak', 'foreshadow', 'character', 'off_plan', 'pacing', 'ai_tone']),
      severity: z.enum(['high', 'medium', 'low']),
      evidence: z.array(z.string()),
      description: z.string(),
      suggestion: z.string(),
    }),
  ),
});
export type ChapterReviewOutput = z.infer<typeof ChapterReviewOutput>;

/** 全书体检（B80）：从各章要点里找出的跨章疑点。章节用提示词中的标签（C1、C2……）指代，之后逐条读两章原文确认。 */
export const BookAuditOutput = z.object({
  suspects: z.array(
    z.object({
      earlier: z.string(),
      later: z.string(),
      kind: z.enum(['character', 'timeline', 'setting_conflict']),
      about: z.string(),
      severity: z.enum(['high', 'medium', 'low']),
    }),
  ),
});
export type BookAuditOutput = z.infer<typeof BookAuditOutput>;

/** 续写一卷的卷纲（B82）：卷名、梗概、主线、卷末转折、新人物、要回收的已有伏笔（名字）与新伏笔。 */
export const VolumeOutlineOutput = z.object({
  title: z.string(),
  summary: z.string(),
  mainline: z.array(z.string()),
  climax: z.string(),
  newCharacters: z.array(z.object({ name: z.string(), description: z.string() })),
  payoffs: z.array(z.string()),
  newForeshadows: z.array(z.object({ title: z.string(), content: z.string(), reveal: z.string() })),
});
export type VolumeOutlineOutput = z.infer<typeof VolumeOutlineOutput>;

/** 全书卷纲（B67、B78 的长篇规划）：按作者定的卷数，每卷一份卷纲（字段同续写一卷的卷纲）。 */
export const BookVolumesOutput = z.object({ volumes: z.array(VolumeOutlineOutput) });
export type BookVolumesOutput = z.infer<typeof BookVolumesOutput>;

/** 人物小传与关系网补全（B83）：要补的人物（小传）与关系。章节用提示词中的标签（C1……）指代，由应用层换回标识。 */
export const CastCompletionOutput = z.object({
  characters: z.array(
    z.object({
      name: z.string(),
      isNew: z.boolean(),
      identity: z.string(),
      look: z.string(),
      personality: z.string(),
      motive: z.string(),
      voice: z.string(),
      firstChapter: z.string(),
      basis: z.array(z.string()),
    }),
  ),
  relationships: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      category: z.enum(['family', 'romance', 'mentor', 'ally', 'rival', 'enemy', 'affiliation', 'other']),
      label: z.string(),
      mutual: z.boolean(),
      description: z.string(),
      secret: z.boolean(),
      fromChapter: z.string(),
      basis: z.array(z.string()),
    }),
  ),
});
export type CastCompletionOutput = z.infer<typeof CastCompletionOutput>;

/**
 * 人物关系随剧情的变化（B73 补充）：这几章里关系的新增、改变与结束，人物的出场、退场与回归。
 * 章节与关系用提示词中的标签（C1……、R1……）指代，由应用层换回标识；对不上的丢弃。
 */
export const RelationChangesOutput = z.object({
  relations: z.array(
    z.object({
      chapter: z.string(),
      kind: z.enum(['add', 'change', 'end']),
      relation: z.string(),
      from: z.string(),
      to: z.string(),
      category: z.enum(['family', 'romance', 'mentor', 'ally', 'rival', 'enemy', 'affiliation', 'other']),
      label: z.string(),
      mutual: z.boolean(),
      description: z.string(),
      secret: z.boolean(),
      reason: z.string(),
    }),
  ),
  cast: z.array(
    z.object({
      chapter: z.string(),
      kind: z.enum(['enter', 'exit', 'return']),
      name: z.string(),
      description: z.string(),
      reason: z.string(),
    }),
  ),
});
export type RelationChangesOutput = z.infer<typeof RelationChangesOutput>;

/** 推演整书（B86）：推演写成的正文已经写出了本章计划里的哪些情节点（序号从 1 起），写手从其余的接着写。 */
export const SceneCoverageOutput = z.object({ covered: z.array(z.number().int().min(1)) });
export type SceneCoverageOutput = z.infer<typeof SceneCoverageOutput>;

/** 扫榜拆书（B79）：一本对标作品的拆解，只有结构与技法；引文由应用层做复述检查。 */
export const BenchmarkBookOutput = z.object({
  genre: z.string(),
  sellingPoints: z.array(z.string()),
  hook: z.string(),
  pacing: z.array(z.object({ chapter: z.string(), role: z.string(), beats: z.string() })),
  cast: z.array(z.object({ role: z.string(), description: z.string() })),
  conflict: z.string(),
  chapterHooks: z.string(),
  techniques: z.array(z.string()),
  quotes: z.array(z.object({ text: z.string(), why: z.string() })),
});
export type BenchmarkBookOutput = z.infer<typeof BenchmarkBookOutput>;

/** 扫榜拆书（B79）：几本对标作品的横向对比与开书方向；skill 是给规划用的指令。 */
export const BenchmarkCompareOutput = z.object({
  common: z.array(z.string()),
  gaps: z.array(z.string()),
  borrow: z.array(z.string()),
  directions: z.array(z.object({ idea: z.string(), why: z.string() })),
  skill: z.string(),
});
export type BenchmarkCompareOutput = z.infer<typeof BenchmarkCompareOutput>;

/** 事件梗概：按发生顺序的若干条，每条一两句。 */
export const SynopsisOutput = z.object({ synopsis: z.array(z.string()) });
export type SynopsisOutput = z.infer<typeof SynopsisOutput>;

/** 单次提示词对照组：同时给出事件梗概与正文，用于分层比较（M0 评估）。 */
export const BaselineOutput = z.object({ synopsis: z.array(z.string()), text: z.string() });
export type BaselineOutput = z.infer<typeof BaselineOutput>;

/** 僵局判断（M0-07）：程序判断不了的两类僵局。 */
export const StalemateJudgementOutput = z.object({
  type: z.enum(['circling', 'polite_resolution', 'goal_unreachable', 'none']),
  explanation: z.string(),
});
export type StalemateJudgementOutput = z.infer<typeof StalemateJudgementOutput>;

/** 导演提议（B47 简化形式）：只改变局面，不改变角色的决策与认知。 */
export const DirectorProposalOutput = z.object({
  propose: z.boolean(),
  rationale: z.string(),
  event: z
    .object({
      zone: z.string(),
      visible: z.boolean(),
      loudness: z.number().int().min(0),
      visual: z.string().nullable(),
      sound: z.string().nullable(),
      setFlags: z.array(z.object({ flag: z.string(), value: z.boolean() })),
    })
    .nullable(),
});
export type DirectorProposalOutput = z.infer<typeof DirectorProposalOutput>;

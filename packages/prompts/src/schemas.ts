import { ActionKind, InjuryLevel, Volume } from '@fudiao/domain';
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
  /** 轮流对话中听到第几句后打断；0 表示对方一开口就打断，null 表示听完。 */
  interruptAfter: z.number().int().min(0).nullable(),
  intent: z.string(),
  rationale: z.string(),
  beliefRefs: z.array(z.string()),
  innerThought: z.string(),
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
    z.object({ inference: z.string(), hit: z.boolean(), supported: z.boolean(), explanation: z.string() }),
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

/** 场景配置草稿（B39）。结构比场景配置扁平，由 sceneDraftToSpec 转换后再经 parseScene 校验。 */
export const SceneDraftOutput = z.object({
  zones: z.array(z.object({ id: z.string(), name: z.string() })),
  edges: z.array(
    z.object({
      a: z.string(),
      b: z.string(),
      adjacent: z.boolean(),
      visible: z.boolean(),
      sound: z.number().int().min(0).nullable(),
      requiresFlag: z.string().nullable(),
    }),
  ),
  flags: z.array(z.object({ key: z.string(), value: z.boolean() })),
  actors: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      zone: z.string(),
      injury: InjuryLevel,
      goal: z.string(),
      bottomLine: z.string(),
      traits: z.array(z.string()),
      riskPreference: z.string(),
      emotionThreshold: z.string(),
      lossOfControl: z.string(),
      speechStyle: z.string(),
      knowledge: z.array(
        z.object({
          text: z.string(),
          modality: z.enum(['observed', 'heard', 'inferred']),
          confidence: Confidence,
          about: z.array(z.string()),
          concerning: z.string().nullable(),
        }),
      ),
    }),
  ),
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      holder: z.string().nullable(),
      zone: z.string().nullable(),
      counters: z.array(z.object({ name: z.string(), value: z.number().int().min(0) })),
      reach: z.enum(['melee', 'ranged']).nullable(),
      noise: z.number().int().min(0).nullable(),
      concealed: z.boolean(),
    }),
  ),
  mechanisms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      zone: z.string(),
      exempt: z.array(z.string()),
      injury: z.number().int().min(0),
      loudness: z.number().int().min(0),
      hidden: z.boolean(),
    }),
  ),
  secrets: z.array(
    z.object({ id: z.string(), text: z.string(), subjects: z.array(z.string()), knownBy: z.array(z.string()) }),
  ),
  exits: z.array(z.string()),
  consumption: z.array(
    z.object({
      item: z.string(),
      counter: z.string(),
      kinds: z.array(ActionKind),
      amount: z.number().int().min(1),
      whenEmpty: z.enum(['reject', 'fail']),
    }),
  ),
  injuryLimits: z.array(
    z.object({
      actor: z.string().nullable(),
      atLeast: InjuryLevel,
      forbidKinds: z.array(ActionKind),
      forbidItems: z.array(z.string()),
    }),
  ),
  requirements: z.array(
    z.object({
      target: z.string(),
      kinds: z.array(ActionKind),
      requiresHolding: z.string(),
      whenMissing: z.enum(['reject', 'fail']),
      setsFlag: z.string().nullable(),
    }),
  ),
  contest: z.enum(['draw', 'ruling']),
  narrativeRules: z.array(z.string()),
});
export type SceneDraftOutput = z.infer<typeof SceneDraftOutput>;

/** 事件梗概：按发生顺序的若干条，每条一两句。 */
export const SynopsisOutput = z.object({ synopsis: z.array(z.string()) });
export type SynopsisOutput = z.infer<typeof SynopsisOutput>;

/** 单次提示词对照组：同时给出事件梗概与正文，用于分层比较（M0 评估）。 */
export const BaselineOutput = z.object({ synopsis: z.array(z.string()), text: z.string() });
export type BaselineOutput = z.infer<typeof BaselineOutput>;

/** 僵局判断（M0-07）：程序判断不了的两类僵局。 */
export const StalemateJudgementOutput = z.object({
  type: z.enum(['polite_resolution', 'goal_unreachable', 'none']),
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

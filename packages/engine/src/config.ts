import { ActorId } from '@fudiao/domain';
import type { ModelProfile } from '@fudiao/llm';
import { z } from 'zod';

const Capabilities = z.object({
  structuredOutput: z.enum(['native', 'json_object', 'prompt', 'none']),
  promptCaching: z.boolean(),
  reasoningControl: z.enum(['effort', 'none']),
  refusalFallback: z.enum(['server_default', 'none']),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  selfTestPassed: z.boolean(),
});

export const ModelProfileSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  capabilities: Capabilities,
  prices: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative().optional(),
      cacheWrite: z.number().nonnegative().optional(),
    })
    .optional(),
}) satisfies z.ZodType<ModelProfile>;

/** 一类任务使用的模型与参数。模型选择全部来自配置（硬性规则 13）。 */
export const TaskModel = z.object({
  profile: ModelProfileSchema,
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxOutputTokens: z.number().int().positive(),
});
export type TaskModel = z.infer<typeof TaskModel>;

export const RunConfig = z.object({
  /** 回合协议（B40）：同时行动或轮流对话。 */
  protocol: z.enum(['simultaneous', 'turn_based']),
  /** 交互模式等待作者确认待核实裁决；自动模式自动接受并标记待复核。 */
  mode: z.enum(['interactive', 'auto']).default('auto'),
  maxRounds: z.number().int().positive(),
  seed: z.number().int().min(0).max(0xffffffff).default(1),
  /** 轮流对话中第一个持有发言权的人；未填写时取场景中的第一个角色。 */
  firstSpeaker: ActorId.optional(),
  /** 提案被规则拒绝后最多再问几次，超过则暂停。 */
  maxProposalAttempts: z.number().int().positive().default(2),
  /** 结构化输出的修正次数上限（B35）。 */
  maxRepairs: z.number().int().nonnegative().default(2),
  /** 僵局分类（M0-07）：程序判定观望与重复，配置了模型时再判断礼貌化解与目标无法达成。 */
  stalemate: z
    .object({
      enabled: z.boolean().default(true),
      /** 观察最近几回合。 */
      window: z.number().int().min(2).default(3),
    })
    .prefault({}),
  /** 导演提议（B47 简化形式）：stalemate 只在僵局后提议，curve 按张力曲线在回合边界主动提议。 */
  director: z
    .object({
      enabled: z.boolean().default(false),
      trigger: z.enum(['stalemate', 'curve']).default('curve'),
      tensionCurve: z.string().default(''),
      maxProposals: z.number().int().positive().default(3),
    })
    .prefault({}),
  models: z.object({
    character_action: TaskModel,
    semantic_ruling: TaskModel,
    belief_update: TaskModel,
    judgement: TaskModel,
    /** 未配置时只做程序判定的两类僵局。 */
    stalemate: TaskModel.optional(),
    director: TaskModel.optional(),
  }),
}).refine((c) => !c.director.enabled || c.models.director !== undefined, {
  message: '开启导演时必须配置 models.director',
  path: ['models', 'director'],
});
export type RunConfig = z.infer<typeof RunConfig>;
export type RunConfigInput = z.input<typeof RunConfig>;

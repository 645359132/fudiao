import { ModelProfileSchema, type RunConfig, type TaskModel } from '@fudiao/engine';
import { AnthropicAdapter, COMPATIBLE_DIALECT, OPENAI_DIALECT, OpenAIChatAdapter, routeByProvider, type ChatDialect, type LlmPort } from '@fudiao/llm';
import { err, ok, type Result } from '@fudiao/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { RunConfig as SceneRun } from './scene-file';

/** OpenAI 兼容接口各家的细节差异；未填时用兼容接口的默认值（见 COMPATIBLE_DIALECT）。 */
const Dialect = {
  maxTokensField: z.enum(['max_completion_tokens', 'max_tokens']).optional(),
  streamUsage: z.boolean().optional(),
  stripThinkTags: z.boolean().optional(),
};

const Provider = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('anthropic'), apiKeyEnv: z.string().min(1), baseURL: z.string().url().optional() }),
  /** OpenAI 官方接口。 */
  z.object({ kind: z.literal('openai'), apiKeyEnv: z.string().min(1), baseURL: z.string().url().default('https://api.openai.com/v1') }),
  /** 使用 OpenAI Chat Completions 写法的其他服务（DeepSeek、通义千问、Kimi、智谱、OpenRouter 等）。 */
  z.object({ kind: z.literal('openai_compatible'), apiKeyEnv: z.string().min(1), baseURL: z.string().url(), ...Dialect }),
  /** 本地端点（Ollama、LM Studio、vLLM 等），可免密钥，只允许回环地址。 */
  z.object({ kind: z.literal('local'), baseURL: z.string().url(), ...Dialect }),
]);

const dialectOf = (p: { maxTokensField?: ChatDialect['maxTokensField']; streamUsage?: boolean; stripThinkTags?: boolean }): ChatDialect => ({
  maxTokensField: p.maxTokensField ?? COMPATIBLE_DIALECT.maxTokensField,
  streamUsage: p.streamUsage ?? COMPATIBLE_DIALECT.streamUsage,
  stripThinkTags: p.stripThinkTags ?? COMPATIBLE_DIALECT.stripThinkTags,
});

const Task = z.object({
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxOutputTokens: z.number().int().positive(),
});

/** 实验配置：模型服务、模型、各任务使用的模型与参数、预算。模型名称只出现在配置中（硬性规则 13）。 */
export const Experiment = z.object({
  providers: z.record(z.string(), Provider),
  models: z.record(z.string(), ModelProfileSchema.omit({ provider: true }).extend({ provider: z.string().min(1) })),
  tasks: z.object({
    character_action: Task,
    semantic_ruling: Task,
    belief_update: Task,
    judgement: Task,
    beat_sheet: Task,
    candidate_text: Task,
    baseline: Task,
    /** 僵局判断；未配置时只做程序判定的两类僵局。 */
    stalemate: Task.optional(),
    /** 导演提议；开启导演时必须配置。 */
    director: Task.optional(),
  }),
  run: z
    .object({
      mode: z.enum(['interactive', 'auto']).default('auto'),
      runs: z.number().int().positive().default(1),
      maxProposalAttempts: z.number().int().positive().default(2),
      maxRepairs: z.number().int().nonnegative().default(2),
      stalemate: z.object({ enabled: z.boolean().default(true), window: z.number().int().min(2).default(3) }).prefault({}),
      director: z
        .object({
          mode: z.enum(['off', 'stalemate', 'curve']).default('off'),
          tensionCurve: z.string().default(''),
          maxProposals: z.number().int().positive().default(3),
        })
        .prefault({}),
    })
    .prefault({}),
  budget: z.object({ limitUsdPerRun: z.number().positive() }),
});
export type Experiment = z.infer<typeof Experiment>;
export type ExperimentTask = keyof Experiment['tasks'];

export function loadExperiment(text: string): Result<Experiment, string> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
  const parsed = Experiment.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(`${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}`);
  }
  if (parsed.data.run.director.mode !== 'off' && parsed.data.tasks.director === undefined) {
    return err('tasks.director: 开启导演时必须配置导演使用的模型');
  }
  for (const [task, t] of Object.entries(parsed.data.tasks)) {
    if (t === undefined) continue;
    const model = parsed.data.models[t.model];
    if (model === undefined) return err(`tasks.${task}.model: 未定义的模型 ${t.model}`);
    if (parsed.data.providers[model.provider] === undefined) return err(`models.${t.model}.provider: 未定义的服务 ${model.provider}`);
  }
  return ok(parsed.data);
}

export function taskModel(experiment: Experiment, task: ExperimentTask): TaskModel {
  const t = experiment.tasks[task];
  if (t === undefined) throw new Error(`任务 ${task} 没有配置模型`);
  const profile = experiment.models[t.model];
  if (profile === undefined) throw new Error(`未定义的模型 ${t.model}`);
  return { profile, maxOutputTokens: t.maxOutputTokens, ...(t.effort !== undefined && { effort: t.effort }) };
}

export function runConfig(
  experiment: Experiment,
  sceneRun: SceneRun,
  overrides: {
    readonly seed: number;
    readonly mode?: 'interactive' | 'auto';
    /** 命令行的 --director 与 --curve 覆盖实验配置。 */
    readonly director?: 'off' | 'stalemate' | 'curve';
    readonly tensionCurve?: string;
  },
): RunConfig {
  const director = overrides.director ?? experiment.run.director.mode;
  return {
    protocol: sceneRun.protocol,
    mode: overrides.mode ?? experiment.run.mode,
    maxRounds: sceneRun.maxRounds,
    seed: overrides.seed,
    ...(sceneRun.firstSpeaker !== undefined && { firstSpeaker: sceneRun.firstSpeaker }),
    maxProposalAttempts: experiment.run.maxProposalAttempts,
    maxRepairs: experiment.run.maxRepairs,
    stalemate: experiment.run.stalemate,
    director: {
      enabled: director !== 'off',
      trigger: director === 'stalemate' ? 'stalemate' : 'curve',
      tensionCurve: overrides.tensionCurve ?? experiment.run.director.tensionCurve,
      maxProposals: experiment.run.director.maxProposals,
    },
    models: {
      character_action: taskModel(experiment, 'character_action'),
      semantic_ruling: taskModel(experiment, 'semantic_ruling'),
      belief_update: taskModel(experiment, 'belief_update'),
      judgement: taskModel(experiment, 'judgement'),
      ...(experiment.tasks.stalemate !== undefined && { stalemate: taskModel(experiment, 'stalemate') }),
      ...(experiment.tasks.director !== undefined && { director: taskModel(experiment, 'director') }),
    },
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 按配置创建各服务的适配器。API Key 只从环境变量读取，不写入任何记录。 */
export function buildPort(experiment: Experiment, env: Readonly<Record<string, string | undefined>>): Result<LlmPort, string> {
  const adapters: Record<string, LlmPort> = {};
  for (const [id, provider] of Object.entries(experiment.providers)) {
    if (provider.kind === 'local') {
      if (!LOOPBACK.has(new URL(provider.baseURL).hostname)) return err(`${id}：本地端点只允许回环地址`);
      adapters[id] = new OpenAIChatAdapter({ baseURL: provider.baseURL, dialect: dialectOf(provider) });
      continue;
    }
    const apiKey = env[provider.apiKeyEnv];
    if (apiKey === undefined || apiKey === '') return err(`${id}：环境变量 ${provider.apiKeyEnv} 未设置`);
    adapters[id] =
      provider.kind === 'anthropic'
        ? new AnthropicAdapter({ apiKey, ...(provider.baseURL !== undefined && { baseURL: provider.baseURL }) })
        : provider.kind === 'openai'
          ? new OpenAIChatAdapter({ apiKey, baseURL: provider.baseURL, dialect: OPENAI_DIALECT })
          : new OpenAIChatAdapter({ apiKey, baseURL: provider.baseURL, dialect: dialectOf(provider) });
  }
  return ok(routeByProvider(adapters));
}

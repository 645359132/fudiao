import type { JsonValue, Result } from '@fudiao/shared';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 需要模型的任务种类（施工文档第六章“任务分配”）。 */
export type TaskKind =
  | 'character_action'
  | 'semantic_ruling'
  | 'belief_update'
  | 'judgement'
  | 'scene_draft'
  | 'beat_sheet'
  | 'candidate_text'
  | 'selection_edit'
  | 'director'
  | 'reader'
  | 'motive_check'
  | 'self_test'
  | 'connection_test'
  /** 模型自带的联网搜索（B84，M7-02）：只搜不写 JSON 的一次调用。 */
  | 'web_search'
  /** 写手与审核（M3）。 */
  | 'plan_draft'
  /** AI 助手（M5）。 */
  | 'assistant'
  | 'writer'
  | 'review'
  | 'memory'
  /** 人物关系随剧情的变化（B73 补充）：从长篇记忆找出关系与人物的变化。 */
  | 'relation_changes';

/**
 * 模型能力描述（B56）。来源依次为服务返回的信息、内置能力表与用户覆盖；
 * 没有记录的模型按保守能力处理。适配器只按能力描述决定传哪些参数（硬性规则 13）。
 */
export type ModelCapabilities = {
  /**
   * native：服务按 JSON Schema 约束输出；json_object：服务只保证输出合法 JSON（OpenAI 兼容接口的
   * `response_format: json_object`），字段由提示词约束；prompt：只靠提示词；none：不用于结构化任务。
   * 后三者的结果都经结构化输出管线校验，不合格时请求修正。
   */
  readonly structuredOutput: 'native' | 'json_object' | 'prompt' | 'none';
  readonly promptCaching: boolean;
  readonly reasoningControl: 'effort' | 'none';
  /** 拒答时由服务端改用其他模型重试。 */
  readonly refusalFallback: 'server_default' | 'none';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly selfTestPassed: boolean;
  /**
   * 模型自带的联网搜索（服务端工具）：Anthropic Messages API 的 web_search 与 OpenAI Responses API 的 web_search。
   * 为真时适配器才声明搜索工具；Chat Completions 写法的服务不支持。
   */
  readonly webSearch: boolean;
};

export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = {
  structuredOutput: 'prompt',
  promptCaching: false,
  reasoningControl: 'none',
  refusalFallback: 'none',
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  selfTestPassed: false,
  webSearch: false,
};

/** 每百万 Token 的美元价格；webSearch 为模型自带联网搜索每千次的美元价（在 Token 费用之外另计）。 */
export type Prices = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly webSearch?: number;
};

export type ModelProfile = {
  /** 已配置服务的标识，例如 `anthropic`、`deepseek`。 */
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  /** 未配置时费用记为未知（B19）。 */
  readonly prices?: Prices;
};

/** 系统提示的一段。cache 为真时在这一段之后设置缓存断点。 */
export type PromptBlock = { readonly text: string; readonly cache?: boolean };

export type LlmMessage = { readonly role: 'user' | 'assistant'; readonly content: string };

/** 结构化输出所需的 JSON Schema，由 packages/prompts 从 Zod 定义生成。 */
export type OutputSchema = { readonly name: string; readonly schema: { readonly [key: string]: JsonValue } };

/**
 * 请求里声明的服务端工具（由模型服务在服务端执行，不经本机）。目前只有联网搜索一种；
 * maxUses 为这次请求里最多搜几次（没写时为 1）。
 */
export type ServerTool = { readonly type: 'web_search'; readonly maxUses?: number };

/** 模型自带联网搜索搜到的一条结果：标题可能为空，摘要来自引用或模型的转述，没有时为空串。 */
export type WebSearchHit = { readonly url: string; readonly title: string; readonly snippet: string };

/**
 * 一次调用里模型自带联网搜索的结果：requests 为实际搜了几次（计费按它），results 为程序从结果块与引用里整理出的条目，
 * error 为搜索工具报的错误码（例如限流、不可用）；没有声明搜索工具的调用没有这一项。
 */
export type WebSearchOutcome = { readonly requests: number; readonly results: readonly WebSearchHit[]; readonly error?: string };

export type LlmRequest = {
  readonly task: TaskKind;
  readonly model: ModelProfile;
  readonly template: { readonly id: string; readonly version: string };
  readonly system: readonly PromptBlock[];
  readonly messages: readonly LlmMessage[];
  readonly output?: OutputSchema;
  /** 服务端工具；与 output 不同时使用（M7-02：搜索是只搜不写 JSON 的单独一次调用）。 */
  readonly tools?: readonly ServerTool[];
  readonly maxOutputTokens: number;
  readonly effort?: Effort;
  /** 确定的步骤键；有完成记录时直接复用，不再调用（硬性规则 10）。 */
  readonly stepKey?: string;
  /** 修正请求：上一次输出未通过校验的原因。只写入调用记录，便于统计；不计入请求哈希（原因已在修正消息中）。 */
  readonly repairOf?: readonly string[];
};

export type LlmUsage = {
  /** 未命中缓存的输入。 */
  readonly inputTokens: number;
  /** 输出，含思考产生的部分。 */
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export type LlmOutcome = 'completed' | 'truncated' | 'refused' | 'cancelled';

export type LlmResult = {
  readonly outcome: LlmOutcome;
  /** 已收到的文本；取消时为部分结果。 */
  readonly text: string;
  /** 服务未返回用量时为 null，费用记为未知。 */
  readonly usage: LlmUsage | null;
  readonly provider: string;
  /** 实际提供服务的模型；发生拒答回退时与请求的模型不同。 */
  readonly servedModel: string;
  readonly stopReason: string | null;
  readonly refusal?: { readonly category: string | null; readonly explanation: string | null };
  readonly fallbackUsed: boolean;
  readonly requestHash: string;
  /** 请求声明了联网搜索时，这次调用的搜索结果。 */
  readonly webSearch?: WebSearchOutcome;
};

export type LlmErrorCode =
  | 'rate_limited'
  | 'auth'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'replay_missing'
  | 'budget_exceeded'
  | 'step_conflict'
  | 'unknown';

export type LlmError = {
  readonly code: LlmErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  /**
   * 服务已经开始回复后才出的错（读到一半连接断了、流没有结束标记就关闭）：这次可能已经计费。
   * usage 是出错前已知的部分用量（Anthropic 在流开始时给出输入用量，OpenAI 写法在结束时才给），不知道时为 null。
   */
  readonly partial?: { readonly usage: LlmUsage | null };
};

export type LlmStreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'usage'; readonly usage: LlmUsage }
  /** 网络中断后整次重新请求（见 withRetry）：之前收到的文字作废。attempt 从 1 起。 */
  | { readonly type: 'retry'; readonly attempt: number; readonly reason: string };

export type CallOptions = {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: LlmStreamEvent) => void;
  /**
   * 每次调用开始前问一声：返回原因则不发出请求，这次调用以这个原因失败（例如写作工作流的预算已用完）。
   * 与取消信号不同：已经在进行的调用照常做完、结果照常记下，只是不再开始下一次。
   */
  readonly beforeCall?: () => string | null;
};

/**
 * 模型端口。引擎与应用服务只依赖它；各服务的差异只在适配器内部处理。
 * 取消通过 AbortSignal：已收到的文本与已知用量照常返回，结果为 cancelled。
 */
export interface LlmPort {
  complete(request: LlmRequest, options?: CallOptions): Promise<Result<LlmResult, LlmError>>;
}

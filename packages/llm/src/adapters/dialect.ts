// OpenAI 兼容接口的写法差异。单独成文件、不引用 SDK：界面在启动时就要用到这些默认值，SDK 等到第一次调用模型时才载入。

/**
 * 各家 OpenAI 兼容接口在细节上的差异，按服务配置（不按模型），由服务配置给出。
 */
export type ChatDialect = {
  /** 输出上限的参数名：OpenAI 官方的推理模型只接受 max_completion_tokens，多数兼容接口只认 max_tokens。 */
  readonly maxTokensField: 'max_completion_tokens' | 'max_tokens';
  /** 是否发送 stream_options.include_usage；个别接口不认识该参数而报错，关闭后用量记为未知。 */
  readonly streamUsage: boolean;
  /** 去掉正文开头的 <think>…</think>（见 ThinkFilter）。 */
  readonly stripThinkTags: boolean;
};

/** OpenAI 官方接口。 */
export const OPENAI_DIALECT: ChatDialect = { maxTokensField: 'max_completion_tokens', streamUsage: true, stripThinkTags: false };

/** 其他 OpenAI 兼容接口与本地端点的默认值。 */
export const COMPATIBLE_DIALECT: ChatDialect = { maxTokensField: 'max_tokens', streamUsage: true, stripThinkTags: true };

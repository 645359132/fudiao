// 测试辅助：不联网的 fetch，按顺序返回预设响应，并记录发出的请求。仅供测试使用。

export type FakeResponse = {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** 普通响应体（JSON 字符串）。 */
  readonly body?: string;
  /** 服务器推送事件的数据块，逐个发出。 */
  readonly chunks?: readonly string[];
  /** 发完 chunks 后不结束，直到请求被取消。 */
  readonly hang?: boolean;
  /** 模拟网络故障。 */
  readonly networkError?: boolean;
};

export type RecordedRequest = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
};

export function fakeFetch(responses: readonly FakeResponse[]) {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url, headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });

    const spec = responses[Math.min(index, responses.length - 1)];
    index++;
    if (spec === undefined) return Promise.reject(new Error('没有预设的响应'));
    if (spec.networkError) return Promise.reject(new TypeError('fetch failed'));

    const signal = init?.signal;
    const encoder = new TextEncoder();
    const body =
      spec.chunks === undefined
        ? (spec.body ?? '')
        : new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of spec.chunks ?? []) controller.enqueue(encoder.encode(chunk));
              if (!spec.hang) {
                controller.close();
                return;
              }
              const abort = () => controller.error(new DOMException('The operation was aborted.', 'AbortError'));
              if (signal?.aborted) abort();
              else signal?.addEventListener('abort', abort, { once: true });
            },
          });

    return Promise.resolve(new Response(body, {
      status: spec.status ?? 200,
      headers: {
        'content-type': spec.chunks === undefined ? 'application/json' : 'text/event-stream',
        ...spec.headers,
      },
    }));
  };

  return { fetch: fetchImpl, requests };
}

/** 一种逻辑场景，由各服务的夹具构造函数翻译为各自的线上格式。 */
export type Scenario = {
  readonly text: readonly string[];
  readonly end: 'stop' | 'length' | 'refusal';
  readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number };
  readonly refusalCategory?: string;
  readonly servedModel?: string;
};

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Anthropic Messages API 的流式事件。 */
export function anthropicChunks(model: string, s: Scenario, opts: { stopAfterText?: boolean } = {}): string[] {
  const usage = s.usage ?? { input: 0, output: 0, cacheRead: 0 };
  const chunks = [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: s.servedModel ?? model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: usage.input,
          output_tokens: 1,
          cache_read_input_tokens: usage.cacheRead,
          cache_creation_input_tokens: 0,
        },
      },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...s.text.map((t) =>
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }),
    ),
  ];
  if (opts.stopAfterText) return chunks;
  const stopReason = s.end === 'stop' ? 'end_turn' : s.end === 'length' ? 'max_tokens' : 'refusal';
  return [
    ...chunks,
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
        stop_details:
          s.end === 'refusal'
            ? { type: 'refusal', category: s.refusalCategory ?? null, explanation: '拒答说明' }
            : null,
      },
      usage: {
        output_tokens: usage.output,
        ...(s.servedModel !== undefined && {
          iterations: [
            { type: 'message', input_tokens: usage.input, output_tokens: 0 },
            { type: 'fallback_message', model: s.servedModel, input_tokens: usage.input, output_tokens: usage.output },
          ],
        }),
      },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ];
}

const data = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** OpenAI 兼容接口（Chat Completions）的流式数据块。 */
export function openaiChunks(
  model: string,
  s: Scenario,
  opts: { stopAfterText?: boolean; omitUsage?: boolean } = {},
): string[] {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    data({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: s.servedModel ?? model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    });
  const chunks = [
    chunk({ role: 'assistant', content: '' }, null),
    ...(s.end === 'refusal'
      ? [chunk({ refusal: s.text.join('') }, null)]
      : s.text.map((t) => chunk({ content: t }, null))),
  ];
  if (opts.stopAfterText) return chunks;
  const finish = s.end === 'stop' ? 'stop' : s.end === 'length' ? 'length' : 'stop';
  const usage = s.usage ?? { input: 0, output: 0, cacheRead: 0 };
  return [
    ...chunks,
    chunk({}, finish),
    ...(opts.omitUsage
      ? []
      : [
          data({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: s.servedModel ?? model,
            choices: [],
            usage: {
              prompt_tokens: usage.input + usage.cacheRead,
              completion_tokens: usage.output,
              total_tokens: usage.input + usage.cacheRead + usage.output,
              prompt_tokens_details: { cached_tokens: usage.cacheRead },
            },
          }),
        ]),
    'data: [DONE]\n\n',
  ];
}

/** 两家服务的错误响应体。 */
export const errorBody = (status: number) =>
  JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message: `错误 ${status}` } });

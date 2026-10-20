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
  /** 发完 chunks 后连接断开（读回复读到一半出错，如凭据代理的“error decoding response body”）。 */
  readonly breakAfterChunks?: boolean;
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
              // 断开放在 pull 里：在 start 里报错会丢掉还没读走的数据块。
              if (spec.breakAfterChunks === true) return;
              if (!spec.hang) {
                controller.close();
                return;
              }
              const abort = () => controller.error(new DOMException('The operation was aborted.', 'AbortError'));
              if (signal?.aborted) abort();
              else signal?.addEventListener('abort', abort, { once: true });
            },
            // 数据块都读走后才调用（队列空了才要更多）。
            pull(controller) {
              if (spec.breakAfterChunks === true) controller.error(new TypeError('网络请求失败：error decoding response body'));
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

/**
 * 模型自带的联网搜索（M7-02）在一个场景里的表现：搜了几次、搜到哪些网页（摘要是被引用的原文片段），
 * 或者搜索工具报了错误码。Anthropic 翻译成 server_tool_use、web_search_tool_result 与带引用的正文块，
 * OpenAI Responses 翻译成 web_search_call 与带 url_citation 注释的正文。
 */
export type SearchScenario = {
  readonly query: string;
  readonly results: readonly { readonly url: string; readonly title: string; readonly snippet?: string }[];
  readonly requests?: number;
  /** 工具报错：Anthropic 的 error_code，OpenAI 为调用状态 failed。 */
  readonly error?: string;
};

/** 一种逻辑场景，由各服务的夹具构造函数翻译为各自的线上格式。 */
export type Scenario = {
  readonly text: readonly string[];
  readonly end: 'stop' | 'length' | 'refusal';
  readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number };
  readonly refusalCategory?: string;
  readonly servedModel?: string;
  readonly search?: SearchScenario;
};

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Anthropic Messages API 的流式事件。 */
export function anthropicChunks(model: string, s: Scenario, opts: { stopAfterText?: boolean } = {}): string[] {
  const usage = s.usage ?? { input: 0, output: 0, cacheRead: 0 };
  // 搜索块排在正文块前面（SDK 按 index 对应到达顺序）：有搜索时正文块是第三块。
  const textIndex = s.search === undefined ? 0 : 2;
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
    ...anthropicSearchBlocks(s.search),
    sse('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }),
    ...s.text.map((t) =>
      sse('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: t } }),
    ),
    // 引用随正文块的 citations_delta 到达：被引用网页的原文片段。
    ...(s.search?.results ?? [])
      .filter((r) => r.snippet !== undefined)
      .map((r) =>
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: r.url, title: r.title, encrypted_index: 'enc-index', cited_text: r.snippet } },
        }),
      ),
  ];
  if (opts.stopAfterText) return chunks;
  const stopReason = s.end === 'stop' ? 'end_turn' : s.end === 'length' ? 'max_tokens' : 'refusal';
  return [
    ...chunks,
    sse('content_block_stop', { type: 'content_block_stop', index: textIndex }),
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
        ...(s.search !== undefined && { server_tool_use: { web_search_requests: s.search.requests ?? 1, web_fetch_requests: 0 } }),
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

/**
 * Anthropic 的搜索块（文档里的流式写法）：server_tool_use 带查询词的 input_json_delta，web_search_tool_result 的内容是结果列表
 * （只有网址、标题与加密正文），或者一个错误对象。放在正文块之前，占 index 0 与 1。
 */
function anthropicSearchBlocks(search: SearchScenario | undefined): string[] {
  if (search === undefined) return [];
  const content =
    search.error !== undefined
      ? { type: 'web_search_tool_result_error', error_code: search.error }
      : search.results.map((r) => ({ type: 'web_search_result', url: r.url, title: r.title, encrypted_content: 'enc-content', page_age: null }));
  return [
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_test', name: 'web_search', input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: search.query }) } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_test', content } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
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

const event = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

/**
 * OpenAI Responses 结束事件里的输出项：web_search_call（来源列表只在 include 了 web_search_call.action.sources 时出现）
 * 与带 url_citation 注释的正文。注释的位置按摘要在正文里的位置算；摘要不在正文里的，注释指向空区间（摘要为空）。
 */
function responsesOutput(text: string, search: SearchScenario | undefined): unknown[] {
  if (search === undefined) return [{ id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
  const annotations = search.results.map((r) => {
    const at = r.snippet === undefined ? -1 : text.indexOf(r.snippet);
    return { type: 'url_citation', url: r.url, title: r.title, start_index: Math.max(0, at), end_index: at < 0 ? 0 : at + (r.snippet?.length ?? 0) };
  });
  const call = (n: number) => ({
    id: `ws_${n}`,
    type: 'web_search_call',
    status: search.error !== undefined ? 'failed' : 'completed',
    action: { type: 'search', query: search.query, sources: search.results.map((r) => ({ type: 'url', url: r.url })) },
  });
  return [
    ...Array.from({ length: search.requests ?? 1 }, (_, i) => call(i + 1)),
    { id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations }] },
  ];
}

/** OpenAI Responses API 的流式事件。用量只在结束时给出。 */
export function responsesChunks(model: string, s: Scenario, opts: { stopAfterText?: boolean } = {}): string[] {
  const served = s.servedModel ?? model;
  const response = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'resp_test', object: 'response', model: served, status, output: responsesOutput(s.text.join(''), s.search), ...extra });
  const chunks = [
    event('response.created', { response: response('in_progress') }),
    ...(s.end === 'refusal'
      ? [event('response.refusal.delta', { delta: s.text.join(''), item_id: 'msg', output_index: 0, content_index: 0 })]
      : s.text.map((t) => event('response.output_text.delta', { delta: t, item_id: 'msg', output_index: 0, content_index: 0 }))),
  ];
  if (opts.stopAfterText) return chunks;
  const u = s.usage ?? { input: 0, output: 0, cacheRead: 0 };
  const usage = {
    input_tokens: u.input + u.cacheRead,
    input_tokens_details: { cached_tokens: u.cacheRead },
    output_tokens: u.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: u.input + u.cacheRead + u.output,
  };
  return [
    ...chunks,
    s.end === 'length'
      ? event('response.incomplete', { response: response('incomplete', { incomplete_details: { reason: 'max_output_tokens' }, usage }) })
      : event('response.completed', { response: response('completed', { usage }) }),
  ];
}

/** 两家服务的错误响应体。 */
export const errorBody = (status: number) =>
  JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message: `错误 ${status}` } });

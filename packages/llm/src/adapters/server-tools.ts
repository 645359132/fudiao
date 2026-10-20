// 服务端工具（M7-02 模型自带的联网搜索）在三个适配器之间共用的部分：能力检查与结果整理。
// 各服务返回搜索结果的形式不同（Anthropic 给结果块与引用，OpenAI 给引用注释与来源列表），
// 这里统一成标题、网址、摘要，顺序按服务给出的先后，同一网址只留一条。
import type { LlmError, LlmRequest, WebSearchHit } from '../types';

/** 请求里是否声明了联网搜索；声明了的话最多搜几次。 */
export function webSearchTool(request: LlmRequest): { readonly maxUses: number } | null {
  const tool = request.tools?.find((t) => t.type === 'web_search');
  return tool === undefined ? null : { maxUses: Math.max(1, Math.floor(tool.maxUses ?? 1)) };
}

/**
 * 请求声明了服务端工具、而模型的能力描述里没有登记时的错误（硬性规则 13：参数按能力描述传递，不猜）。
 * 由适配器在发出请求前检查，不会产生调用费用。
 */
export function unsupportedTools(request: LlmRequest, reason: string | null = null): LlmError | null {
  if (webSearchTool(request) === null) return null;
  if (reason !== null) return { code: 'bad_request', message: reason };
  if (request.model.capabilities.webSearch) return null;
  return { code: 'bad_request', message: `模型 ${request.model.model} 没有登记“模型自带的联网搜索”能力：请在“模型服务”的“能力与价格”里勾选，或换一个支持的模型` };
}

/** 收集结果时的中间形态：网址对应的标题与已找到的摘要片段。 */
export class HitCollector {
  private readonly order: string[] = [];
  private readonly hits = new Map<string, { title: string; snippets: string[] }>();

  /** 记下一个网址；标题为空时保留先前的，摘要片段去重后追加。 */
  add(url: string, title: string | null, snippet: string | null): void {
    const key = url.trim();
    if (key === '') return;
    let hit = this.hits.get(key);
    if (hit === undefined) {
      hit = { title: '', snippets: [] };
      this.hits.set(key, hit);
      this.order.push(key);
    }
    const t = (title ?? '').trim();
    if (hit.title === '' && t !== '') hit.title = t;
    const s = plain(snippet ?? '');
    if (s !== '' && !hit.snippets.includes(s)) hit.snippets.push(s);
  }

  list(): WebSearchHit[] {
    return this.order.map((url) => {
      const hit = this.hits.get(url) ?? { title: '', snippets: [] };
      return { url, title: hit.title, snippet: hit.snippets.join('…') };
    });
  }
}

/** 摘要只留一行：引用的原文可能带换行与多余空白。 */
const plain = (text: string) => text.replace(/\s+/g, ' ').trim();

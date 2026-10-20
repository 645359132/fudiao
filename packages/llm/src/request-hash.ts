import { canonicalJson, sha256 } from '@fudiao/shared';
import type { LlmRequest } from './types';

/**
 * 请求哈希：决定模型响应的全部内容。不含步骤键（与运行无关）、价格（不影响响应）与修正原因
 * （已包含在修正消息中），因此同一请求在不同运行中得到同一哈希，录制回放样本可以复用。
 * 能力里的 webSearch 只在请求声明了服务端工具时才影响发出的参数：没有声明工具的请求不把它算进哈希，
 * 这样增加这项能力（M7-02）之前记下的调用记录与录制样本照旧对得上。
 */
export function requestHash(request: LlmRequest): string {
  const { stepKey, repairOf, model, ...rest } = request;
  const { prices, capabilities, ...modelPart } = model;
  const { webSearch, ...plainCapabilities } = capabilities;
  return sha256(canonicalJson({ ...rest, model: { ...modelPart, capabilities: request.tools === undefined ? plainCapabilities : capabilities } }));
}

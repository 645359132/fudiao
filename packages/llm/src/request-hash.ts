import { canonicalJson, sha256 } from '@fudiao/shared';
import type { LlmRequest } from './types';

/**
 * 请求哈希：决定模型响应的全部内容。不含步骤键（与运行无关）与价格（不影响响应），
 * 因此同一请求在不同运行中得到同一哈希，录制回放样本可以复用。
 */
export function requestHash(request: LlmRequest): string {
  const { stepKey, model, ...rest } = request;
  const { prices, ...modelPart } = model;
  return sha256(canonicalJson({ ...rest, model: modelPart }));
}

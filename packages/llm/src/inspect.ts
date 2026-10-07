import type { CallOptions, LlmPort, LlmRequest } from './types';

/**
 * 在请求发出前检查它，用于金丝雀泄露测试：检查函数发现无权限的标记时抛出异常，测试即失败。
 */
export function inspectRequests(port: LlmPort, inspect: (request: LlmRequest) => void): LlmPort {
  return {
    // 异步函数，检查失败时调用方得到被拒绝的 Promise，而不是同步异常。
    async complete(request: LlmRequest, options?: CallOptions) {
      inspect(request);
      return await port.complete(request, options);
    },
  };
}

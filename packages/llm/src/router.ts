import { err } from '@fudiao/shared';
import type { CallOptions, LlmPort, LlmRequest } from './types';

/** 按请求中的服务标识把调用交给对应的适配器。未配置的服务返回错误，不会改用其他服务。 */
export function routeByProvider(adapters: Readonly<Record<string, LlmPort>>): LlmPort {
  return {
    complete(request: LlmRequest, options?: CallOptions) {
      const adapter = adapters[request.model.provider];
      if (adapter === undefined) {
        return Promise.resolve(err({ code: 'bad_request', message: `未配置的模型服务：${request.model.provider}` }));
      }
      return adapter.complete(request, options);
    },
  };
}

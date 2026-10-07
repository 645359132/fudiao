// 测试辅助：按脚本返回结果的模型端口，并记录收到的请求。仅供测试使用。
import { ok, type Result } from '@novel-writer/shared';
import { requestHash } from '../request-hash';
import {
  CONSERVATIVE_CAPABILITIES,
  type CallOptions,
  type LlmError,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
} from '../types';

export type Reply = { readonly text: string; readonly outcome?: LlmResult['outcome']; readonly usage?: LlmUsage | null };

export const usage = (input: number, output: number): LlmUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function scriptedPort(script: readonly (Reply | LlmError)[]) {
  const requests: LlmRequest[] = [];
  const port: LlmPort = {
    complete(request: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
      const step = script[Math.min(requests.length, script.length - 1)];
      requests.push(request);
      if (step === undefined) throw new Error('脚本为空');
      if ('code' in step) return Promise.resolve({ ok: false, error: step });
      options.onEvent?.({ type: 'text', delta: step.text });
      return Promise.resolve(
        ok({
          outcome: step.outcome ?? 'completed',
          text: step.text,
          usage: step.usage === undefined ? usage(100, 50) : step.usage,
          provider: request.model.provider,
          servedModel: request.model.model,
          stopReason: 'end_turn',
          fallbackUsed: false,
          requestHash: requestHash(request),
        }),
      );
    },
  };
  return { port, requests };
}

export const baseRequest = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  task: 'character_action',
  model: {
    provider: 'anthropic',
    model: 'm',
    capabilities: CONSERVATIVE_CAPABILITIES,
    prices: { input: 4, output: 20, cacheRead: 0.2 },
  },
  template: { id: 'character_action', version: '1' },
  system: [{ text: '规则' }],
  messages: [{ role: 'user', content: '行动？' }],
  maxOutputTokens: 1_000,
  ...overrides,
});

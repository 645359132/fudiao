import { err, ok, type Result } from '@fudiao/shared';
import type { z } from 'zod';
import type { CallOptions, LlmError, LlmPort, LlmRequest, LlmResult } from './types';

export type StructuredOptions = CallOptions & {
  /** 修正次数上限；超过后暂停任务并说明原因（B35）。 */
  readonly maxRepairs: number;
  /**
   * 生成修正请求的用户消息。文字属于提示词，由 packages/prompts 的模板提供（硬性规则 12）。
   */
  readonly repairMessage: (issues: readonly string[]) => string;
};

export type StructuredSuccess<T> = {
  readonly value: T;
  /** 每次调用的结果，修正调用也计入用量。 */
  readonly attempts: readonly LlmResult[];
};

export type StructuredError =
  | { readonly code: 'call_failed'; readonly error: LlmError; readonly attempts: readonly LlmResult[] }
  | {
      readonly code: 'refused' | 'truncated' | 'cancelled';
      readonly result: LlmResult;
      readonly attempts: readonly LlmResult[];
    }
  | { readonly code: 'invalid_output'; readonly issues: readonly string[]; readonly attempts: readonly LlmResult[] };

/**
 * 结构化输出管线：解析 → 修复常见格式错误 → Zod 校验；失败时带错误信息请求修正。
 * 这是模型输出唯一的解析位置（硬性规则 11），管线之外拿到的一定是通过校验的数据。
 */
export async function structured<T>(
  port: LlmPort,
  schema: z.ZodType<T>,
  request: LlmRequest,
  options: StructuredOptions,
): Promise<Result<StructuredSuccess<T>, StructuredError>> {
  const attempts: LlmResult[] = [];
  let current = request;

  for (let attempt = 0; ; attempt++) {
    const called = await port.complete(current, options);
    if (!called.ok) return err({ code: 'call_failed', error: called.error, attempts });
    const result = called.value;
    attempts.push(result);
    if (result.outcome !== 'completed') {
      return err({ code: result.outcome, result, attempts });
    }

    const issues = validate(schema, result.text);
    if (issues.ok) return ok({ value: issues.value, attempts });
    if (attempt >= options.maxRepairs) return err({ code: 'invalid_output', issues: issues.error, attempts });

    current = {
      ...current,
      ...(request.stepKey !== undefined && { stepKey: `${request.stepKey}#repair${attempt + 1}` }),
      repairOf: issues.error,
      messages: [
        ...current.messages,
        { role: 'assistant', content: result.text },
        { role: 'user', content: options.repairMessage(issues.error) },
      ],
    };
  }
}

function validate<T>(schema: z.ZodType<T>, text: string): Result<T, string[]> {
  const parsed = parseModelJson(text);
  if (!parsed.ok) return err([parsed.error]);
  const checked = schema.safeParse(parsed.value);
  if (checked.success) return ok(checked.data);
  return err(checked.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`));
}

/** 解析模型输出的 JSON，并修复常见格式错误：代码块包裹、前后的说明文字、多余的逗号。 */
export function parseModelJson(text: string): Result<unknown, string> {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    for (const variant of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        return ok(JSON.parse(variant) as unknown);
      } catch {
        // 继续尝试下一种修复。
      }
    }
  }
  return err('输出不是有效的 JSON');
}

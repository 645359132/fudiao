import type { JsonValue } from '@fudiao/shared';
import { z } from 'zod';

// 结构化输出不支持的约束：从发给服务的 schema 中去掉，由结构化输出管线在本地用 Zod 校验。
const UNSUPPORTED = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

type JsonObject = { readonly [key: string]: JsonValue };

const isObject = (v: JsonValue): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);

function clean(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(clean);
  if (!isObject(node)) return node;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED.has(key)) continue;
    // 可辨识联合（各分支以常量区分，互不重叠）生成 oneOf；OpenAI 严格模式只接受 anyOf，两者在这里含义相同。
    out[key === 'oneOf' ? 'anyOf' : key] = clean(value);
  }
  if (out['type'] === 'object' && isObject(out['properties'] ?? null)) {
    out['additionalProperties'] = false;
    out['required'] = Object.keys(out['properties'] as JsonObject);
  }
  return out;
}

/** 由 Zod 定义生成模型结构化输出所需的 JSON Schema（Anthropic 与 OpenAI 严格模式均可接受）。 */
export function modelJsonSchema(schema: z.ZodType): { readonly [key: string]: JsonValue } {
  const generated = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as JsonValue;
  const cleaned = clean(generated);
  if (!isObject(cleaned)) throw new Error('输出 schema 必须是对象');
  return cleaned;
}

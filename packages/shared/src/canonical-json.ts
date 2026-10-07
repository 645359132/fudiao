export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/**
 * 稳定序列化：对象键按码位排序，省略 undefined。
 * 相同的值总得到相同的字符串，用于状态哈希与请求哈希。
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`无法序列化非有限数：${value}`);
    return JSON.stringify(value);
  }
  if (isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(',')}}`;
}

// Array.isArray 不能把 readonly 数组从联合类型中收窄出来。
const isArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

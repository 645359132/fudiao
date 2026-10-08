/**
 * 分数索引排序键（DESIGN_PATTERNS“分数索引排序”）：在任意两个键之间总能生成新键，插入与移动只改一行。
 *
 * 键 = 整数部分 + 小数部分，字符取 base62（0-9A-Za-z，ASCII 递增，SQLite 按字节比较时顺序一致）。
 * 整数部分的首字符表示长度：a 至 z 为非负数（长度 2 至 27），A 至 Z 为负数（Z 长度 2，A 长度 27）。
 * 连续追加或前插只让整数部分递增或递减，键长按对数增长；只有反复在同一处插入时小数部分才会变长。
 * 小数部分不以 0 结尾，保证其下方总有空间。
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LAST_DIGIT = 'z';
const SMALLEST_INTEGER = `A${'0'.repeat(26)}`;

const digit = (c: string | undefined): number => (c === undefined ? -1 : DIGITS.indexOf(c));
const at = (i: number): string => DIGITS.charAt(i);

function integerLength(head: string | undefined): number {
  if (head !== undefined && head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head !== undefined && head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error(`无效的排序键开头：${head ?? ''}`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0]);
  if (length > key.length) throw new Error(`排序键的整数部分不完整：${key}`);
  return key.slice(0, length);
}

function validate(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error('排序键不能是最小整数');
  const integer = integerPart(key);
  if (key.slice(integer.length).endsWith('0')) throw new Error(`排序键的小数部分不能以 0 结尾：${key}`);
  for (const c of key.slice(1)) if (digit(c) < 0) throw new Error(`排序键含无效字符：${key}`);
}

export function isOrderKey(key: string): boolean {
  try {
    validate(key);
    return true;
  } catch {
    return false;
  }
}

/** 两个小数部分之间的中点；b 为 null 表示无上界。 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a === '' ? 0 : digit(a[0]);
  const db = b === null ? DIGITS.length : digit(b[0]);
  if (db - da > 1) return at(Math.round((da + db) / 2));
  // 首位相邻：b 更长时取 b 的首位即可；否则沿用 a 的首位，继续向下一位找空间。
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return at(da) + midpoint(a.slice(1), null);
}

function incrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digit(digits[i]) + 1;
    if (d < DIGITS.length) {
      digits[i] = at(d);
      return head + digits.join('');
    }
    digits[i] = '0';
  }
  if (head === 'Z') return 'a0';
  if (head === 'z') return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digits.push('0');
  else digits.pop();
  return next + digits.join('');
}

function decrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digit(digits[i]) - 1;
    if (d >= 0) {
      digits[i] = at(d);
      return head + digits.join('');
    }
    digits[i] = LAST_DIGIT;
  }
  if (head === 'a') return `Z${LAST_DIGIT}`;
  if (head === 'A') return null;
  const previous = String.fromCharCode(head.charCodeAt(0) - 1);
  if (previous < 'Z') digits.push(LAST_DIGIT);
  else digits.pop();
  return previous + digits.join('');
}

/** 生成严格介于 a 与 b 之间的键；null 表示该方向没有边界。 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) throw new Error(`排序键顺序不对：${a} 不小于 ${b}`);

  if (a === null) {
    if (b === null) return 'a0';
    const ib = integerPart(b);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', b.slice(ib.length));
    if (ib < b) return ib;
    const lower = decrementInteger(ib);
    if (lower === null) throw new Error('排序键已到下限');
    return lower;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  if (b === null) return incrementInteger(ia) ?? ia + midpoint(fa, null);

  const ib = integerPart(b);
  if (ia === ib) return ia + midpoint(fa, b.slice(ib.length));
  const next = incrementInteger(ia);
  if (next === null) throw new Error('排序键已到上限');
  return next < b ? next : ia + midpoint(fa, null);
}

/** 生成 n 个严格介于 a 与 b 之间、依次递增的键。两端有界时二分生成，避免键长线性增长。 */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    const keys = [keyBetween(a, null)];
    for (let i = 1; i < n; i++) keys.push(keyBetween(keys[i - 1] ?? null, null));
    return keys;
  }
  if (a === null) {
    const keys = [keyBetween(null, b)];
    for (let i = 1; i < n; i++) keys.push(keyBetween(null, keys[i - 1] ?? null));
    return keys.reverse();
  }
  const half = Math.floor(n / 2);
  const middle = keyBetween(a, b);
  return [...keysBetween(a, middle, half), middle, ...keysBetween(middle, b, n - half - 1)];
}

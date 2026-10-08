// 逐字比较两段文字（候选稿的差异预览，需求 B17）。前后相同的部分直接跳过，中间按最长公共子序列对齐；
// 中间部分过长时不再逐字对齐，整体显示为删除与新增。

export type DiffPart = { readonly kind: 'same' | 'removed' | 'added'; readonly text: string };

/** 中间部分逐字对齐的上限（两段长度之积）。 */
const ALIGN_LIMIT = 4_000_000;

function push(parts: DiffPart[], kind: DiffPart['kind'], text: string): void {
  if (text === '') return;
  const last = parts.at(-1);
  if (last?.kind === kind) parts[parts.length - 1] = { kind, text: last.text + text };
  else parts.push({ kind, text });
}

export function textDiff(before: string, after: string): DiffPart[] {
  const a = [...before];
  const b = [...after];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const parts: DiffPart[] = [];
  push(parts, 'same', a.slice(0, prefix).join(''));
  if (midA.length * midB.length > ALIGN_LIMIT || midA.length === 0 || midB.length === 0) {
    push(parts, 'removed', midA.join(''));
    push(parts, 'added', midB.join(''));
  } else {
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const lcs = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        push(parts, 'same', midA[i++] ?? '');
        j++;
      } else if (i < n && (j === m || (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
        // 同样长时先删后增，与常见的差异显示一致。
        push(parts, 'removed', midA[i++] ?? '');
      } else {
        push(parts, 'added', midB[j++] ?? '');
      }
    }
  }
  push(parts, 'same', a.slice(a.length - suffix).join(''));
  return parts;
}

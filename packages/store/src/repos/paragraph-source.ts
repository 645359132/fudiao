// 段落来源（需求 B33、施工文档第四章）：按字符区间记录哪些文字来自 AI，保存时随编辑更新，并据此判定段落来源。
// 纯函数。区间位置是 JavaScript 字符串下标，与编辑器一致。
import { countWords } from '@fudiao/shared';

/** 段落来源：手写、AI 生成、AI 生成后修改、混合（需求术语表）。 */
export type SourceKind = 'handwritten' | 'ai_generated' | 'ai_modified' | 'mixed';

/** 来自 AI 的文字所在的区间 [start, end)，有序且不重叠。其余文字由作者写成。 */
export type AiSpan = { readonly start: number; readonly end: number };

/** 判定来源所需的信息。 */
export type Provenance = {
  readonly text: string;
  /**
   * 生成原文：接受候选稿时的文字，用来衡量作者改了多少。
   * 合并了不同来源、或从修改过的段落拆出时不再有可比的原文，为 null。
   */
  readonly aiOriginText: string | null;
  readonly spans: readonly AiSpan[];
};

/** “AI 生成后修改”的门槛：与生成原文的编辑距离超过原文字数的这一比例。 */
export const MODIFIED_RATIO = 0.1;

/** 编辑距离，超过上界 k 时返回 null（只算对角线附近的带，代价约为 O(k·长度)）。 */
export function editDistanceWithin(a: string, b: string, k: number): number | null {
  if (Math.abs(a.length - b.length) > k) return null;
  const INF = k + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => (j <= k ? j : INF));
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(INF);
    const from = Math.max(1, i - k);
    const to = Math.min(b.length, i + k);
    if (i <= k) cur[0] = i;
    let best = cur[0] ?? INF;
    for (let j = from; j <= to; j++) {
      const sub = (prev[j - 1] ?? INF) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const v = Math.min(sub, (prev[j] ?? INF) + 1, (cur[j - 1] ?? INF) + 1, INF);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > k) return null;
    prev = cur;
  }
  const d = prev[b.length] ?? INF;
  return d <= k ? d : null;
}

function normalize(spans: readonly AiSpan[]): AiSpan[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((x, y) => x.start - y.start);
  const out: AiSpan[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last !== undefined && s.start <= last.end) out[out.length - 1] = { start: last.start, end: Math.max(last.end, s.end) };
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** 中间部分做逐字对齐的上限（两段长度之积）；超过时把中间部分整体视为改写。 */
const ALIGN_LIMIT = 1_000_000;
/** 对齐后保留的最短连续相同文字；更短的巧合（单个“的”“了”“，”）算作者改写。 */
const MIN_RUN = 2;

/**
 * 文字从 oldText 改为 newText 后更新 AI 区间：公共前缀、公共后缀与中间按最长公共子序列对齐的文字中，
 * 连续两字以上相同的保留原来的来源，其余新写入的文字属于作者。
 * 一次保存可能包含几处编辑（防抖期间），只比较前后缀会把两处之间的 AI 文字误算为作者所写。
 */
export function updateSpans(oldText: string, spans: readonly AiSpan[], newText: string): AiSpan[] {
  if (oldText === newText) return normalize(spans);
  const wasAi = new Uint8Array(oldText.length);
  for (const s of spans) wasAi.fill(1, Math.max(0, s.start), Math.min(oldText.length, s.end));
  const isAi = new Uint8Array(newText.length);

  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldText.length - prefix && suffix < newText.length - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
  // 前后缀同样要求连续两字以上（整段旧文字除外），交给中间的对齐处理。
  if (prefix < MIN_RUN && prefix < oldText.length) prefix = 0;
  if (suffix < MIN_RUN && suffix < oldText.length) suffix = 0;
  for (let i = 0; i < prefix; i++) isAi[i] = wasAi[i] ?? 0;
  for (let k = 1; k <= suffix; k++) isAi[newText.length - k] = wasAi[oldText.length - k] ?? 0;
  for (const [i, j] of alignRuns(oldText.slice(prefix, oldText.length - suffix), newText.slice(prefix, newText.length - suffix))) {
    isAi[prefix + j] = wasAi[prefix + i] ?? 0;
  }

  const out: AiSpan[] = [];
  let start = -1;
  for (let j = 0; j <= newText.length; j++) {
    const ai = j < newText.length && isAi[j] === 1;
    if (ai && start < 0) start = j;
    if (!ai && start >= 0) {
      out.push({ start, end: j });
      start = -1;
    }
  }
  return out;
}

/** 最长公共子序列对齐，只返回连续 MIN_RUN 字以上的对应位置 [旧下标, 新下标]。 */
function alignRuns(a: string, b: string): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > ALIGN_LIMIT) return [];
  const w = m + 1;
  // lcs[i][j]：a[i..] 与 b[j..] 的最长公共子序列长度。
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) i++;
    else j++;
  }
  const kept: Array<[number, number]> = [];
  for (let k = 0; k < pairs.length; ) {
    let end = k + 1;
    while (end < pairs.length && pairs[end]![0] === pairs[end - 1]![0] + 1 && pairs[end]![1] === pairs[end - 1]![1] + 1) end++;
    if (end - k >= MIN_RUN) kept.push(...pairs.slice(k, end));
    k = end;
  }
  return kept;
}

const unionSpans = (a: readonly AiSpan[], b: readonly AiSpan[]): AiSpan[] => normalize([...a, ...b]);

/** 两段合并：后一段的区间平移到前一段之后。 */
export function joinSpans(first: string, firstSpans: readonly AiSpan[], _second: string, secondSpans: readonly AiSpan[]): AiSpan[] {
  return normalize([...firstSpans, ...secondSpans.map((s) => ({ start: s.start + first.length, end: s.end + first.length }))]);
}

/** 在 at 处把一段拆成两段。 */
export function splitSpans(spans: readonly AiSpan[], at: number): [AiSpan[], AiSpan[]] {
  const left = normalize(spans.map((s) => ({ start: s.start, end: Math.min(s.end, at) })));
  const right = normalize(spans.map((s) => ({ start: Math.max(s.start, at) - at, end: s.end - at })));
  return [left, right];
}

/**
 * 判定段落来源：没有 AI 文字为手写；有生成原文时，与原文的编辑距离超过原文字数的 10% 为“AI 生成后修改”，否则为“AI 生成”；
 * 没有生成原文时，整段都是 AI 文字为“AI 生成后修改”，部分是为“混合”。
 */
export function classify(p: Provenance): SourceKind {
  if (p.spans.length === 0) return 'handwritten';
  if (p.aiOriginText !== null) {
    const limit = Math.floor(p.aiOriginText.length * MODIFIED_RATIO);
    return editDistanceWithin(p.text, p.aiOriginText, limit) === null ? 'ai_modified' : 'ai_generated';
  }
  return coversAll(p.text, p.spans) ? 'ai_modified' : 'mixed';
}

const coversAll = (text: string, spans: readonly AiSpan[]) => spans.length === 1 && spans[0]?.start === 0 && spans[0]?.end === text.length;

/** AI 参与的字数：AI 区间内的文字按“字数”的规则计数。 */
export function aiCharacters(text: string, spans: readonly AiSpan[]): number {
  return spans.reduce((n, s) => n + countWords(text.slice(s.start, s.end)), 0);
}

/** 推导所需的已保存段落信息。 */
export type SavedProvenance = Provenance & { readonly id: string; readonly source: SourceKind };
export type DerivedProvenance = { readonly source: SourceKind; readonly spans: readonly AiSpan[]; readonly aiOriginText: string | null };
type CurrentSource = { readonly id: string; readonly text: string; readonly source: SourceKind };
type Edits = {
  readonly splits: readonly { readonly id: string; readonly from: string }[];
  readonly merges: readonly { readonly removed: string; readonly into: string }[];
};

/**
 * 推导本次保存后每个段落的来源。已有段落的来源只由保存的区间与文字变化推导，不采信编辑器里的标记，
 * 以免作者的改写被旧标记掩盖；没有来历的新段落（接受的候选稿、粘贴）才采用编辑器标记。
 * 拆分与合并按“来历组”处理：由拆分与合并关系连在一起的段落，把组内旧文字与新文字分别按顺序拼接后比较，再按新段落切开。
 */
export function deriveProvenance(saved: readonly SavedProvenance[], current: readonly CurrentSource[], edits: Edits): Map<string, DerivedProvenance> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const s of edits.splits) union(s.id, s.from);
  for (const m of edits.merges) union(m.removed, m.into);

  const groups = new Map<string, { old: SavedProvenance[]; now: CurrentSource[] }>();
  const group = (id: string) => {
    const root = find(id);
    let g = groups.get(root);
    if (g === undefined) {
      g = { old: [], now: [] };
      groups.set(root, g);
    }
    return g;
  };
  for (const p of saved) group(p.id).old.push(p);
  for (const p of current) group(p.id).now.push(p);

  const out = new Map<string, DerivedProvenance>();
  const derived = (text: string, spans: readonly AiSpan[], aiOriginText: string | null): DerivedProvenance => {
    const origin = spans.length === 0 ? null : aiOriginText;
    return { source: classify({ text, spans, aiOriginText: origin }), spans, aiOriginText: origin };
  };
  for (const { old, now } of groups.values()) {
    if (now.length === 0) continue;
    if (old.length === 0) {
      for (const p of now) {
        const ai = p.source !== 'handwritten' && p.text !== '';
        out.set(p.id, derived(p.text, ai ? [{ start: 0, end: p.text.length }] : [], p.source === 'ai_generated' ? p.text : null));
      }
      continue;
    }
    const only = old[0];
    const next = now[0];
    if (old.length === 1 && now.length === 1 && only !== undefined && next !== undefined && only.id === next.id) {
      let spans = updateSpans(only.text, only.spans, next.text);
      // 与生成原文对得上的文字仍算 AI 文字：作者删掉一句、保存后又撤销时，找回的那句不算作者所写。
      if (only.aiOriginText !== null && only.text !== next.text) {
        spans = unionSpans(spans, updateSpans(only.aiOriginText, [{ start: 0, end: only.aiOriginText.length }], next.text));
      }
      out.set(next.id, derived(next.text, spans, only.aiOriginText));
      continue;
    }
    let oldText = '';
    let oldSpans: AiSpan[] = [];
    for (const p of old) {
      oldSpans = joinSpans(oldText, oldSpans, p.text, p.spans);
      oldText += p.text;
    }
    let rest = updateSpans(oldText, oldSpans, now.map((p) => p.text).join(''));
    // 组内带 AI 文字的旧段落都未经修改时，整段仍是 AI 文字的新段落以自身为生成原文；否则没有可比的原文。
    const pristine = old.every((p) => p.spans.length === 0 || p.source === 'ai_generated');
    for (const p of now) {
      const [mine, after] = splitSpans(rest, p.text.length);
      rest = after;
      out.set(p.id, derived(p.text, mine, pristine && coversAll(p.text, mine) ? p.text : null));
    }
  }
  return out;
}

// 章节正文的保存计划：比较上次保存的段落与编辑器当前段落，得出最少的写入。纯函数，不访问数据库。
import { keysBetween } from '@fudiao/shared';

export type SourceKind = 'handwritten' | 'ai_generated' | 'ai_modified' | 'mixed';

export type SavedParagraph = {
  readonly id: string;
  readonly orderKey: string;
  readonly text: string;
  readonly version: number;
  readonly source: SourceKind;
};

export type CurrentParagraph = { readonly id: string; readonly text: string; readonly source: SourceKind };

/** 编辑器记录的结构变化（自上次保存以来）：拆分出的新段落及其来源段落、被合并的段落及并入的段落。 */
export type StructuralEdits = {
  readonly splits: readonly { readonly id: string; readonly from: string }[];
  readonly merges: readonly { readonly removed: string; readonly into: string }[];
};

export type ParagraphSavePlan = {
  readonly inserts: readonly { id: string; orderKey: string; text: string; source: SourceKind; splitFrom: string | null }[];
  /** 只列出变化的字段。排序键变化不提升版本（锚点只关心文本），但仍以版本作为并发守卫。 */
  readonly updates: readonly { id: string; expectedVersion: number; text?: string; source?: SourceKind; orderKey?: string }[];
  readonly deletes: readonly { id: string; expectedVersion: number }[];
  /** 事件关联的复制：拆分时从来源段落复制到新段落，合并时从被合并的段落复制到保留的段落。 */
  readonly linkCopies: readonly { from: string; to: string }[];
};

/** 最长递增子序列（按排序键），返回其中元素的下标。 */
function longestIncreasing(keys: readonly string[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(keys.length).fill(-1);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] ?? '';
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((keys[tails[mid] ?? 0] ?? '') < key) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] ?? -1;
    tails[lo] = i;
  }
  const kept = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i] ?? -1) kept.add(i);
  return kept;
}

export function planParagraphSave(saved: readonly SavedParagraph[], current: readonly CurrentParagraph[], edits: StructuralEdits): ParagraphSavePlan {
  const savedById = new Map(saved.map((p) => [p.id, p]));
  const currentIds = new Set<string>();
  for (const p of current) {
    if (currentIds.has(p.id)) throw new Error(`段落标识重复：${p.id}`);
    currentIds.add(p.id);
  }

  // 顺序未变的已有段落保留排序键；其余段落在相邻的保留键之间取新键。
  const existing = current.map((p, i) => ({ i, saved: savedById.get(p.id) })).filter((e) => e.saved !== undefined);
  const lis = longestIncreasing(existing.map((e) => e.saved?.orderKey ?? ''));
  const anchors = new Map<number, string>();
  existing.forEach((e, k) => {
    if (lis.has(k) && e.saved) anchors.set(e.i, e.saved.orderKey);
  });
  const keys: string[] = [];
  for (let i = 0; i < current.length; ) {
    const anchor = anchors.get(i);
    if (anchor !== undefined) {
      keys.push(anchor);
      i++;
      continue;
    }
    let end = i;
    while (end < current.length && !anchors.has(end)) end++;
    const fresh = keysBetween(keys.at(-1) ?? null, anchors.get(end) ?? null, end - i);
    keys.push(...fresh);
    i = end;
  }

  const inserts: ParagraphSavePlan['inserts'][number][] = [];
  const updates: ParagraphSavePlan['updates'][number][] = [];
  const splitFrom = new Map(edits.splits.map((s) => [s.id, s.from]));
  current.forEach((p, i) => {
    const key = keys[i] ?? '';
    const before = savedById.get(p.id);
    if (before === undefined) {
      inserts.push({ id: p.id, orderKey: key, text: p.text, source: p.source, splitFrom: splitFrom.get(p.id) ?? null });
      return;
    }
    const update = {
      id: p.id,
      expectedVersion: before.version,
      ...(p.text !== before.text && { text: p.text }),
      ...(p.source !== before.source && { source: p.source }),
      ...(key !== before.orderKey && { orderKey: key }),
    };
    if (Object.keys(update).length > 2) updates.push(update);
  });

  const linkCopies: { from: string; to: string }[] = [];
  // 拆分：沿来源链追溯到已保存的段落。
  for (const p of inserts) {
    let from = p.splitFrom;
    const seen = new Set<string>();
    while (from !== null && !savedById.has(from) && !seen.has(from)) {
      seen.add(from);
      from = splitFrom.get(from) ?? null;
    }
    if (from !== null && savedById.has(from)) linkCopies.push({ from, to: p.id });
  }
  // 合并：沿并入链找到最终保留的段落；被合并的段落须已保存且已不在文档中（撤销合并后仍存在的不算）。
  const into = new Map(edits.merges.map((m) => [m.removed, m.into]));
  for (const p of saved) {
    if (currentIds.has(p.id) || !into.has(p.id)) continue;
    let target = into.get(p.id);
    const seen = new Set<string>([p.id]);
    while (target !== undefined && !currentIds.has(target) && !seen.has(target)) {
      seen.add(target);
      target = into.get(target);
    }
    if (target !== undefined && currentIds.has(target)) linkCopies.push({ from: p.id, to: target });
  }

  const deletes = saved.filter((p) => !currentIds.has(p.id)).map((p) => ({ id: p.id, expectedVersion: p.version }));
  return { inserts, updates, deletes, linkCopies };
}

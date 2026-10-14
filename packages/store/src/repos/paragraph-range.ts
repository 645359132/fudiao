// 按范围替换正文（接受候选稿，需求 B17、B33）：把段落标识加段内下标定出的范围换成新文字，并写入来源区间。
// 首段保留标识；范围跨过的其余段落并入首段（事件关联取并集）；新文字多出的行成为新段落（事件关联随拆分复制）。
// 插入的文字记为 AI 区间；整段都是未经修改的生成文字时以自身为生成原文（AI 生成），否则按区间判定。
import { err, keysBetween, ok, type Result } from '@fudiao/shared';
import type { SqlPort, SqlValue, Statement } from '../sql';
import type { RepoError, WriteContext } from './common';
import type { SavedParagraph } from './paragraph-plan';
import { classify, joinSpans, splitSpans, type AiSpan, type SourceKind } from './paragraph-source';

export type TextPosition = { readonly paragraphId: string; readonly offset: number };
export type TextRange = { readonly from: TextPosition; readonly to: TextPosition };

export type RangeInsert = {
  /** 新文字，以换行分段。 */
  readonly text: string;
  /** 新文字中来自 AI 的区间（相对于 text）。 */
  readonly ai: readonly AiSpan[];
  /** 新文字未经作者修改：整段都是新文字的段落以自身为生成原文。 */
  readonly unedited: boolean;
};

type Out = { readonly text: string; readonly spans: readonly AiSpan[]; readonly aiOriginText: string | null; readonly source: SourceKind };

export type RangePlan = {
  readonly update: Out & { readonly id: string; readonly expectedVersion: number };
  readonly inserts: readonly (Out & { readonly id: string; readonly orderKey: string })[];
  readonly deletes: readonly { readonly id: string; readonly expectedVersion: number }[];
  /** 并入首段的段落（事件关联取并集）与新段落（复制首段的关联）。 */
  readonly linkCopies: readonly { readonly from: string; readonly to: string }[];
};

/** 范围中的原文（段落之间以换行连接）；位置无效时为 null。 */
export function textInRange(paragraphs: readonly SavedParagraph[], range: TextRange): string | null {
  const i = paragraphs.findIndex((p) => p.id === range.from.paragraphId);
  const j = paragraphs.findIndex((p) => p.id === range.to.paragraphId);
  if (i < 0 || j < i) return null;
  const first = paragraphs[i];
  const last = paragraphs[j];
  if (first === undefined || last === undefined) return null;
  if (range.from.offset > first.text.length || range.to.offset > last.text.length || (i === j && range.to.offset < range.from.offset)) return null;
  if (i === j) return first.text.slice(range.from.offset, range.to.offset);
  return [first.text.slice(range.from.offset), ...paragraphs.slice(i + 1, j).map((p) => p.text), last.text.slice(0, range.to.offset)].join('\n');
}

/** 一段新文字的 AI 区间（相对于这一段）。 */
function lineSpans(ai: readonly AiSpan[], start: number, end: number): AiSpan[] {
  return ai.filter((s) => s.end > start && s.start < end).map((s) => ({ start: Math.max(s.start, start) - start, end: Math.min(s.end, end) - start }));
}

function finish(text: string, spans: readonly AiSpan[], insertedWhole: boolean, unedited: boolean): Out {
  const covers = spans.length === 1 && spans[0]?.start === 0 && spans[0]?.end === text.length && text !== '';
  const aiOriginText = covers && insertedWhole && unedited ? text : null;
  return { text, spans, aiOriginText, source: classify({ text, spans, aiOriginText }) };
}

export function planRangeReplace(paragraphs: readonly SavedParagraph[], range: TextRange, insert: RangeInsert, newId: () => string): Result<RangePlan, string> {
  const i = paragraphs.findIndex((p) => p.id === range.from.paragraphId);
  const j = paragraphs.findIndex((p) => p.id === range.to.paragraphId);
  const first = paragraphs[i];
  const last = paragraphs[j];
  if (first === undefined || last === undefined || j < i || textInRange(paragraphs, range) === null) return err('原文位置无效');

  const prefix = first.text.slice(0, range.from.offset);
  const suffix = last.text.slice(range.to.offset);
  const [prefixSpans] = splitSpans(first.spans, range.from.offset);
  const [, suffixSpans] = splitSpans(last.spans, range.to.offset);
  const lines = insert.text.replace(/\r\n?/g, '\n').split('\n');
  let offset = 0;
  const pieces = lines.map((line) => {
    const piece = { text: line, spans: lineSpans(insert.ai, offset, offset + line.length) };
    offset += line.length + 1;
    return piece;
  });

  const outs: Out[] = pieces.map((piece, k) => {
    const head = k === 0 ? { text: prefix, spans: prefixSpans } : { text: '', spans: [] as AiSpan[] };
    const tail = k === pieces.length - 1 ? { text: suffix, spans: suffixSpans } : { text: '', spans: [] as AiSpan[] };
    const text = head.text + piece.text + tail.text;
    const spans = joinSpans(head.text + piece.text, joinSpans(head.text, head.spans, piece.text, piece.spans), tail.text, tail.spans);
    return finish(text, spans, head.text === '' && tail.text === '', insert.unedited);
  });

  const [head, ...rest] = outs;
  if (head === undefined) return err('没有要写入的文字');
  const nextKey = paragraphs[j + 1]?.orderKey ?? null;
  const keys = keysBetween(first.orderKey, nextKey, rest.length);
  const inserts = rest.map((o, k) => ({ ...o, id: newId(), orderKey: keys[k] ?? '' }));
  const merged = paragraphs.slice(i + 1, j + 1);
  return ok({
    update: { ...head, id: first.id, expectedVersion: first.version },
    inserts,
    deletes: merged.map((p) => ({ id: p.id, expectedVersion: p.version })),
    linkCopies: [...merged.map((p) => ({ from: p.id, to: first.id })), ...inserts.map((p) => ({ from: first.id, to: p.id }))],
  });
}

/**
 * 在一个事务中执行替换：每个涉及的段落以版本为守卫（生成之后段落被改过时整体回滚，返回冲突）。
 * 先复制事件关联，再删除并入的段落，最后插入新段落（新排序键落在被删段落的位置上，须在删除之后）。
 */
export async function applyRangeReplace(port: SqlPort, chapterId: string, plan: RangePlan, ctx: WriteContext): Promise<Result<void, RepoError>> {
  const done = await port.transaction(rangeReplaceStatements(chapterId, plan, ctx));
  if (done.ok) return ok(undefined);
  return err(done.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: done.error });
}

/** 替换的全部语句（带版本守卫）；采纳推演草案时与事件、事实一起放进同一个事务。 */
export function rangeReplaceStatements(chapterId: string, plan: RangePlan, ctx: WriteContext): Statement[] {
  const statements: Statement[] = [];
  const guarded = (sql: string, params: SqlValue[]): Statement => ({ sql, params, expectChanges: 1 });
  const u = plan.update;
  statements.push(
    guarded(
      `UPDATE paragraph SET text = ?, source_kind = ?, source_spans = ?, ai_origin_text = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND chapter_id = ? AND version = ?`,
      [u.text, u.source, JSON.stringify(u.spans), u.aiOriginText, ctx.now, u.id, chapterId, u.expectedVersion],
    ),
  );
  for (const d of plan.deletes) {
    statements.push(guarded('UPDATE paragraph SET updated_at = updated_at WHERE id = ? AND chapter_id = ? AND version = ?', [d.id, chapterId, d.expectedVersion]));
  }
  for (const c of plan.linkCopies.filter((c) => plan.deletes.some((d) => d.id === c.from))) {
    statements.push({
      sql: 'INSERT OR IGNORE INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) SELECT event_id, ?, mode, ? FROM event_paragraph_link WHERE paragraph_id = ?',
      params: [c.to, ctx.now, c.from],
    });
  }
  for (const d of plan.deletes) statements.push(guarded('DELETE FROM paragraph WHERE id = ? AND chapter_id = ?', [d.id, chapterId]));
  for (const p of plan.inserts) {
    statements.push({
      sql: `INSERT INTO paragraph (id, chapter_id, order_key, text, source_kind, source_spans, ai_origin_text, split_from, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [p.id, chapterId, p.orderKey, p.text, p.source, JSON.stringify(p.spans), p.aiOriginText, u.id, ctx.now, ctx.now],
    });
  }
  for (const c of plan.linkCopies.filter((c) => c.from === u.id)) {
    statements.push({
      sql: 'INSERT OR IGNORE INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) SELECT event_id, ?, mode, ? FROM event_paragraph_link WHERE paragraph_id = ?',
      params: [c.to, ctx.now, c.from],
    });
  }
  statements.push({ sql: 'UPDATE chapter SET updated_at = ? WHERE id = ?', params: [ctx.now, chapterId] });
  return statements;
}

import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, SqlValue, Statement } from '../sql';
import { queryAll, type RepoError, type WriteContext } from './common';
import { planParagraphSave, type CurrentParagraph, type SavedParagraph, type StructuralEdits } from './paragraph-plan';

/** source_spans 列：AI 文字区间的 JSON 数组。 */
export const SourceSpansColumn = z
  .string()
  .transform((text, ctx): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: '来源区间不是有效的 JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).refine((s) => s.end > s.start)));

export const SourceKindColumn = z.enum(['handwritten', 'ai_generated', 'ai_modified', 'mixed']);

const ParagraphRow = z
  .object({
    id: z.string(),
    order_key: z.string(),
    text: z.string(),
    version: z.number().int(),
    source_kind: SourceKindColumn,
    source_spans: SourceSpansColumn,
    ai_origin_text: z.string().nullable(),
  })
  .transform(
    (r): SavedParagraph => ({
      id: r.id,
      orderKey: r.order_key,
      text: r.text,
      version: r.version,
      source: r.source_kind,
      aiOriginText: r.ai_origin_text,
      spans: r.source_spans,
    }),
  );

export function listParagraphs(port: SqlPort, chapterId: string): Promise<Result<SavedParagraph[], RepoError>> {
  return queryAll(
    port,
    ParagraphRow,
    'SELECT id, order_key, text, version, source_kind, source_spans, ai_origin_text FROM paragraph WHERE chapter_id = ? ORDER BY order_key',
    [chapterId],
  );
}

/** 排序键调整期间的临时键：`~` 排在 base62 字符之后，加上标识保证章内唯一。 */
const temporaryKey = (id: string) => `~${id}`;

/**
 * 保存一章正文：在一个事务中执行保存计划（施工文档第七章“自动保存”）。
 * 每条更新与删除都以版本为守卫；任一守卫不满足时整体回滚，返回冲突。
 */
export async function saveChapterParagraphs(
  port: SqlPort,
  chapterId: string,
  saved: readonly SavedParagraph[],
  current: readonly CurrentParagraph[],
  edits: StructuralEdits,
  ctx: WriteContext,
): Promise<Result<SavedParagraph[], RepoError>> {
  const plan = planParagraphSave(saved, current, edits);
  const statements: Statement[] = [];
  const guarded = (sql: string, params: SqlValue[]): Statement => ({ sql, params, expectChanges: 1 });

  // 1. 要改排序键或要删除的段落先挪到临时键，新键写入时不会撞上章内唯一约束。
  for (const id of [...plan.updates.filter((u) => u.orderKey !== undefined).map((u) => u.id), ...plan.deletes.map((d) => d.id)]) {
    const version = plan.updates.find((u) => u.id === id)?.expectedVersion ?? plan.deletes.find((d) => d.id === id)?.expectedVersion ?? 0;
    statements.push(guarded('UPDATE paragraph SET order_key = ? WHERE id = ? AND chapter_id = ? AND version = ?', [temporaryKey(id), id, chapterId, version]));
  }
  // 2. 新增段落。
  for (const p of plan.inserts) {
    statements.push({
      sql: 'INSERT INTO paragraph (id, chapter_id, order_key, text, source_kind, source_spans, ai_origin_text, split_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [p.id, chapterId, p.orderKey, p.text, p.source, JSON.stringify(p.spans), p.aiOriginText, p.splitFrom, ctx.now, ctx.now],
    });
  }
  // 3. 修改：文本或来源变化时版本加一（锚点据此判断原文是否变化），只改排序键时不加。
  for (const u of plan.updates) {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (u.text !== undefined) {
      sets.push('text = ?');
      params.push(u.text);
    }
    if (u.source !== undefined) {
      sets.push('source_kind = ?');
      params.push(u.source);
    }
    if (u.spans !== undefined) {
      sets.push('source_spans = ?');
      params.push(JSON.stringify(u.spans));
    }
    if (u.aiOriginText !== undefined) {
      sets.push('ai_origin_text = ?');
      params.push(u.aiOriginText);
    }
    if (u.orderKey !== undefined) {
      sets.push('order_key = ?');
      params.push(u.orderKey);
    }
    const bump = u.text !== undefined || u.source !== undefined ? 1 : 0;
    statements.push(
      guarded(`UPDATE paragraph SET ${sets.join(', ')}, version = version + ${bump}, updated_at = ? WHERE id = ? AND chapter_id = ? AND version = ?`, [
        ...params,
        ctx.now,
        u.id,
        chapterId,
        u.expectedVersion,
      ]),
    );
  }
  // 4. 事件关联：拆分复制到新段落，合并并入保留的段落（B55）。须在删除之前，否则级联删除会先带走关联。
  for (const c of plan.linkCopies) {
    statements.push({
      sql: 'INSERT OR IGNORE INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) SELECT event_id, ?, mode, ? FROM event_paragraph_link WHERE paragraph_id = ?',
      params: [c.to, ctx.now, c.from],
    });
  }
  // 5. 删除（第 1 步已核对版本）。
  for (const d of plan.deletes) statements.push(guarded('DELETE FROM paragraph WHERE id = ? AND chapter_id = ?', [d.id, chapterId]));

  if (statements.length === 0) return ok([...saved]);
  statements.push({ sql: 'UPDATE chapter SET updated_at = ? WHERE id = ?', params: [ctx.now, chapterId] });
  const done = await port.transaction(statements);
  if (!done.ok) return err(done.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: done.error });
  return listParagraphs(port, chapterId);
}

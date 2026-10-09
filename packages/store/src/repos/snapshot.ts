// 章节快照（需求 B06）：保存一章正文在某一时刻的全部段落，可以预览与恢复。
// 快照保存段落标识、文字、来源标记与事件关联：恢复后锚点仍指向原段落，来源与关联不丢失。
import { err, keysBetween, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, Statement } from '../sql';
import { insertReturning, queryAll, queryOne, type RepoError, type WriteContext } from './common';
import { listParagraphs } from './paragraph';
import type { SavedParagraph } from './paragraph-plan';

export type SnapshotReason = 'manual' | 'before_restore' | 'accept_candidate' | 'import' | 'writer';

const SnapshotParagraph = z.object({
  id: z.string(),
  text: z.string(),
  source: z.enum(['handwritten', 'ai_generated', 'ai_modified', 'mixed']),
  sourceSpans: z.unknown(),
  aiOriginText: z.string().nullable(),
  links: z.array(z.object({ eventId: z.string(), mode: z.enum(['direct', 'flashback', 'retold', 'implied']) })),
});
export type SnapshotParagraph = z.infer<typeof SnapshotParagraph>;

const SnapshotSummaryRow = z
  .object({ id: z.string(), chapter_id: z.string(), reason: z.enum(['manual', 'before_restore', 'accept_candidate', 'import', 'writer']), title: z.string(), created_at: z.string(), count: z.number().int() })
  .transform((r) => ({ id: r.id, chapterId: r.chapter_id, reason: r.reason, title: r.title, createdAt: r.created_at, paragraphCount: r.count }));
export type SnapshotSummary = z.output<typeof SnapshotSummaryRow>;

const SnapshotRow = z
  .object({ id: z.string(), chapter_id: z.string(), reason: z.enum(['manual', 'before_restore', 'accept_candidate', 'import', 'writer']), title: z.string(), created_at: z.string(), paragraphs: z.string() })
  .transform((r, ctx) => {
    let paragraphs: SnapshotParagraph[] = [];
    try {
      const parsed = z.array(SnapshotParagraph).safeParse(JSON.parse(r.paragraphs));
      if (parsed.success) paragraphs = parsed.data;
      else ctx.addIssue({ code: 'custom', message: '快照内容格式无效' });
    } catch {
      ctx.addIssue({ code: 'custom', message: '快照内容不是有效的 JSON' });
    }
    return { id: r.id, chapterId: r.chapter_id, reason: r.reason, title: r.title, createdAt: r.created_at, paragraphs };
  });
export type Snapshot = z.output<typeof SnapshotRow>;

const CurrentRow = z.object({
  id: z.string(),
  text: z.string(),
  source_kind: z.enum(['handwritten', 'ai_generated', 'ai_modified', 'mixed']),
  source_spans: z.string(),
  ai_origin_text: z.string().nullable(),
  links: z.string(),
});

/** 一章当前保存的段落，连同来源标记与事件关联。 */
async function currentParagraphs(port: SqlPort, chapterId: string): Promise<Result<SnapshotParagraph[], RepoError>> {
  const rows = await queryAll(
    port,
    CurrentRow,
    `SELECT p.id, p.text, p.source_kind, p.source_spans, p.ai_origin_text,
       (SELECT json_group_array(json_object('eventId', l.event_id, 'mode', l.mode))
          FROM (SELECT event_id, mode FROM event_paragraph_link WHERE paragraph_id = p.id ORDER BY event_id) AS l) AS links
     FROM paragraph p WHERE p.chapter_id = ? ORDER BY p.order_key`,
    [chapterId],
  );
  if (!rows.ok) return rows;
  return ok(
    rows.value.map((r) => ({
      id: r.id,
      text: r.text,
      source: r.source_kind,
      sourceSpans: JSON.parse(r.source_spans) as unknown,
      aiOriginText: r.ai_origin_text,
      links: JSON.parse(r.links) as SnapshotParagraph['links'],
    })),
  );
}

const TitleRow = z.object({ title: z.string() });

function snapshotStatement(id: string, chapterId: string, reason: SnapshotReason, title: string, paragraphs: readonly SnapshotParagraph[], ctx: WriteContext): Statement {
  return {
    sql: 'INSERT INTO chapter_snapshot (id, chapter_id, reason, title, paragraphs, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, chapter_id, reason, title, created_at, json_array_length(paragraphs) AS count',
    params: [id, chapterId, reason, title, JSON.stringify(paragraphs), ctx.now],
  };
}

/** 为一章当前已保存的正文建立快照。调用前应先保存编辑器中的内容。 */
export async function createSnapshot(
  port: SqlPort,
  input: { readonly id: string; readonly chapterId: string; readonly reason: SnapshotReason },
  ctx: WriteContext,
): Promise<Result<SnapshotSummary, RepoError>> {
  const chapter = await queryOne(port, TitleRow, 'SELECT title FROM chapter WHERE id = ?', [input.chapterId]);
  if (!chapter.ok) return chapter;
  if (chapter.value === null) return err({ code: 'not_found' });
  const paragraphs = await currentParagraphs(port, input.chapterId);
  if (!paragraphs.ok) return paragraphs;
  return insertReturning(port, SnapshotSummaryRow, snapshotStatement(input.id, input.chapterId, input.reason, chapter.value.title, paragraphs.value, ctx));
}

/** 一章的快照，最近的在前。 */
export function listSnapshots(port: SqlPort, chapterId: string): Promise<Result<SnapshotSummary[], RepoError>> {
  return queryAll(
    port,
    SnapshotSummaryRow,
    'SELECT id, chapter_id, reason, title, created_at, json_array_length(paragraphs) AS count FROM chapter_snapshot WHERE chapter_id = ? ORDER BY created_at DESC, id DESC',
    [chapterId],
  );
}

export async function getSnapshot(port: SqlPort, id: string): Promise<Result<Snapshot, RepoError>> {
  const row = await queryOne(port, SnapshotRow, 'SELECT id, chapter_id, reason, title, created_at, paragraphs FROM chapter_snapshot WHERE id = ?', [id]);
  if (!row.ok) return row;
  return row.value === null ? err({ code: 'not_found' }) : ok(row.value);
}

/**
 * 把一章恢复到快照：先把现稿存为“恢复前”快照（作者可以再次回退），再在一个事务中
 * 换回快照中的段落。段落沿用原标识；快照之后新增的段落删除；事件关联取快照中的关联（事件仍存在时）
 * 与现存段落当前关联的并集。文字或来源变化的段落版本加一，锚点据此判断原文是否变化。
 */
export async function restoreSnapshot(
  port: SqlPort,
  input: { readonly snapshotId: string; readonly backupId: string },
  ctx: WriteContext,
): Promise<Result<{ readonly paragraphs: SavedParagraph[]; readonly backup: SnapshotSummary }, RepoError>> {
  const snapshot = await getSnapshot(port, input.snapshotId);
  if (!snapshot.ok) return snapshot;
  const chapterId = snapshot.value.chapterId;
  const chapter = await queryOne(port, TitleRow, 'SELECT title FROM chapter WHERE id = ?', [chapterId]);
  if (!chapter.ok) return chapter;
  if (chapter.value === null) return err({ code: 'not_found' });
  const current = await currentParagraphs(port, chapterId);
  if (!current.ok) return current;

  const restored = snapshot.value.paragraphs;
  const keep = new Set(restored.map((p) => p.id));
  const existing = new Set(current.value.map((p) => p.id));
  const keys = keysBetween(null, null, restored.length);
  const statements: Statement[] = [snapshotStatement(input.backupId, chapterId, 'before_restore', chapter.value.title, current.value, ctx)];
  // 先把本章所有段落挪到临时键，新顺序写入时不会撞上章内唯一约束。
  statements.push({ sql: "UPDATE paragraph SET order_key = '~' || id WHERE chapter_id = ?", params: [chapterId] });
  for (const p of current.value) {
    if (!keep.has(p.id)) statements.push({ sql: 'DELETE FROM paragraph WHERE id = ? AND chapter_id = ?', params: [p.id, chapterId] });
  }
  restored.forEach((p, i) => {
    const spans = JSON.stringify(p.sourceSpans ?? []);
    if (existing.has(p.id)) {
      statements.push({
        sql: `UPDATE paragraph SET version = version + (text IS NOT ? OR source_kind IS NOT ? OR source_spans IS NOT ? OR ai_origin_text IS NOT ?),
                text = ?, source_kind = ?, source_spans = ?, ai_origin_text = ?, order_key = ?, updated_at = ?
              WHERE id = ? AND chapter_id = ?`,
        params: [p.text, p.source, spans, p.aiOriginText, p.text, p.source, spans, p.aiOriginText, keys[i] ?? '', ctx.now, p.id, chapterId],
      });
    } else {
      statements.push({
        sql: 'INSERT INTO paragraph (id, chapter_id, order_key, text, source_kind, source_spans, ai_origin_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [p.id, chapterId, keys[i] ?? '', p.text, p.source, spans, p.aiOriginText, ctx.now, ctx.now],
      });
    }
    for (const link of p.links) {
      statements.push({
        sql: 'INSERT OR IGNORE INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM story_event WHERE id = ?)',
        params: [link.eventId, p.id, link.mode, ctx.now, link.eventId],
      });
    }
  });
  statements.push({ sql: 'UPDATE chapter SET updated_at = ? WHERE id = ?', params: [ctx.now, chapterId] });

  const done = await port.transaction(statements);
  if (!done.ok) return err({ code: 'sql', error: done.error });
  const backupRow = SnapshotSummaryRow.safeParse(done.value[0]?.rows[0]);
  if (!backupRow.success) return err({ code: 'invalid', detail: '恢复前快照没有写入' });
  const paragraphs = await listParagraphs(port, chapterId);
  return paragraphs.ok ? ok({ paragraphs: paragraphs.value, backup: backupRow.data }) : paragraphs;
}

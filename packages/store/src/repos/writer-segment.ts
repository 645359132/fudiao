// 写手写入正文（需求 B59、B60）：每写完一段，把这一段接在章末，并在同一个事务中更新章节计划里的进度，
// 中途崩溃不会出现“段落写了、进度没记”。段落记为 AI 生成并以自身为生成原文；写手不改动已有的段落。
// 守卫：写手读取之后这一章被别处改过（段落数量或版本之和变了），或计划被改过，整个事务回滚并返回冲突。
import { err, keysBetween, ok, type Result } from '@fudiao/shared';
import type { SqlPort, Statement } from '../sql';
import { PLAN_COLUMNS, PlanRow, type ChapterPlan, type WriterProgress } from './chapter-plan';
import { guardedUpdate, type RepoError, type WriteContext } from './common';
import { listParagraphs } from './paragraph';
import type { SavedParagraph } from './paragraph-plan';

/** 开始一次写作：记下分段与写入前的快照，状态改为写作中。 */
export function startWriterRun(port: SqlPort, plan: ChapterPlan, progress: WriterProgress, ctx: WriteContext): Promise<Result<ChapterPlan, RepoError>> {
  return guardedUpdate(
    port,
    PlanRow,
    'chapter_plan',
    plan.chapterId,
    {
      sql: `UPDATE chapter_plan SET status = 'writing', progress = ?, version = version + 1, updated_at = ? WHERE chapter_id = ? AND version = ? RETURNING ${PLAN_COLUMNS}`,
      params: [JSON.stringify({ ...progress, done: 0 }), ctx.now, plan.chapterId, plan.version],
    },
    'chapter_id',
  );
}

/** 回退到写入前之后：清除进度，状态回到待写。 */
export function resetWriterRun(port: SqlPort, plan: ChapterPlan, ctx: WriteContext): Promise<Result<ChapterPlan, RepoError>> {
  return guardedUpdate(
    port,
    PlanRow,
    'chapter_plan',
    plan.chapterId,
    {
      sql: `UPDATE chapter_plan SET status = 'todo', progress = NULL, version = version + 1, updated_at = ? WHERE chapter_id = ? AND version = ? RETURNING ${PLAN_COLUMNS}`,
      params: [ctx.now, plan.chapterId, plan.version],
    },
    'chapter_id',
  );
}

export type SegmentWrite = {
  /** 写手手里的计划（含进度）；版本不符即冲突。 */
  readonly plan: ChapterPlan;
  /** 写手生成这一段之前读到的本章段落。 */
  readonly paragraphs: readonly SavedParagraph[];
  /** 这一段的段落文字（不含空段）。 */
  readonly texts: readonly string[];
  readonly newId: () => string;
};

export async function appendWrittenSegment(
  port: SqlPort,
  input: SegmentWrite,
  ctx: WriteContext,
): Promise<Result<{ plan: ChapterPlan; paragraphs: SavedParagraph[] }, RepoError>> {
  const { plan, paragraphs, texts } = input;
  const progress = plan.progress;
  if (progress === null) return err({ code: 'invalid', detail: '这一章没有进行中的写作' });
  if (texts.length === 0) return err({ code: 'invalid', detail: '没有要写入的文字' });
  const done = progress.done + 1;
  const keys = keysBetween(paragraphs.at(-1)?.orderKey ?? null, null, texts.length);
  const statements: Statement[] = [
    {
      sql: `UPDATE chapter SET updated_at = ? WHERE id = ?
              AND (SELECT count(*) FROM paragraph WHERE chapter_id = ?) = ?
              AND (SELECT coalesce(sum(version), 0) FROM paragraph WHERE chapter_id = ?) = ?`,
      params: [ctx.now, plan.chapterId, plan.chapterId, paragraphs.length, plan.chapterId, paragraphs.reduce((n, p) => n + p.version, 0)],
      expectChanges: 1,
    },
    ...texts.map(
      (text, i): Statement => ({
        sql: `INSERT INTO paragraph (id, chapter_id, order_key, text, source_kind, source_spans, ai_origin_text, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'ai_generated', ?, ?, ?, ?)`,
        params: [input.newId(), plan.chapterId, keys[i] ?? '', text, JSON.stringify([{ start: 0, end: text.length }]), text, ctx.now, ctx.now],
      }),
    ),
    {
      sql: `UPDATE chapter_plan SET progress = ?, status = ?, version = version + 1, updated_at = ? WHERE chapter_id = ? AND version = ?`,
      params: [JSON.stringify({ ...progress, done }), done >= progress.segments.length ? 'written' : 'writing', ctx.now, plan.chapterId, plan.version],
      expectChanges: 1,
    },
  ];
  const result = await port.transaction(statements);
  if (!result.ok) return err(result.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: result.error });
  const [updated, saved] = await Promise.all([port.query(`SELECT ${PLAN_COLUMNS} FROM chapter_plan WHERE chapter_id = ?`, [plan.chapterId]), listParagraphs(port, plan.chapterId)]);
  if (!updated.ok) return err({ code: 'sql', error: updated.error });
  if (!saved.ok) return saved;
  const row = PlanRow.safeParse(updated.value[0]);
  return row.success ? ok({ plan: row.data, paragraphs: saved.value }) : err({ code: 'invalid', detail: '写入后读不到章节计划' });
}

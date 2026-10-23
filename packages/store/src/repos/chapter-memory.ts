// 长篇记忆（需求 B66）：已写章节的摘要、人物状态与伏笔进展，供写手与审核作为前文。
// 它是派生结论（硬性规则 21），记录依据的段落版本；正文修改后由 reviewStaleMemories 标为待复核。
import type { Result } from '@fudiao/shared';
import { err, ok } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { jsonColumn, queryAll, queryOne, type RepoError, type WriteContext } from './common';

const memoryFields = {
  chapter_id: z.string(),
  summary: z.string(),
  cast_state: jsonColumn(z.record(z.string(), z.string())),
  foreshadow_progress: jsonColumn(z.record(z.string(), z.string())),
  status: z.enum(['valid', 'stale']),
  llm_call_id: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  open_threads: jsonColumn(z.array(z.string())),
};
const summaryOf = (r: z.output<z.ZodObject<typeof memoryFields>>) => ({
  chapterId: r.chapter_id,
  summary: r.summary,
  /** 人物设定标识 → 本章结束时的状态。 */
  castState: r.cast_state,
  /** 伏笔标识 → 本章中的进展。 */
  foreshadowProgress: r.foreshadow_progress,
  /** 章尾留给后面的事：悬而未决的问题、承诺或约定、没有完成的动作（迁移 0013）。 */
  openThreads: r.open_threads,
  status: r.status,
  llmCallId: r.llm_call_id,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const SummaryRow = z.object(memoryFields).transform(summaryOf);
const MemoryRow = z
  .object({ ...memoryFields, based_on: jsonColumn(z.record(z.string(), z.number().int())) })
  /** basedOn：生成时依据的段落，段落标识 → 版本。 */
  .transform((r) => ({ ...summaryOf(r), basedOn: r.based_on }));
export type ChapterMemory = z.output<typeof MemoryRow>;
/** 列出全书的记忆时不带依据的段落版本（每章几百段，几百章时有上百万字节，用的地方只有判断待复核）。 */
export type ChapterMemorySummary = z.output<typeof SummaryRow>;

const COLUMNS = 'chapter_id, summary, cast_state, foreshadow_progress, based_on, status, llm_call_id, version, created_at, updated_at, open_threads';
const SUMMARY_COLUMNS = COLUMNS.split(', ').filter((c) => c !== 'based_on');

export type MemoryInput = {
  readonly chapterId: string;
  readonly summary: string;
  readonly castState: Readonly<Record<string, string>>;
  readonly foreshadowProgress: Readonly<Record<string, string>>;
  readonly openThreads?: readonly string[];
  readonly basedOn: Readonly<Record<string, number>>;
  readonly llmCallId: string | null;
};

export function getChapterMemory(port: SqlPort, chapterId: string): Promise<Result<ChapterMemory | null, RepoError>> {
  return queryOne(port, MemoryRow, `SELECT ${COLUMNS} FROM chapter_memory WHERE chapter_id = ?`, [chapterId]);
}

/** 回收站以外的章节的记忆，按章节顺序；不带依据的段落版本（要它时用 getChapterMemory）。 */
export function listChapterMemories(port: SqlPort): Promise<Result<ChapterMemorySummary[], RepoError>> {
  return queryAll(
    port,
    SummaryRow,
    `SELECT ${SUMMARY_COLUMNS.map((c) => `m.${c}`).join(', ')} FROM chapter_memory m JOIN chapter c ON c.id = m.chapter_id
     JOIN chapter_book_order o ON o.chapter_id = c.id WHERE c.status = 'normal' ORDER BY o.position`,
  );
}

/** 有正文的章节（回收站以外）：只有它们可以生成记忆。 */
export async function listChaptersWithText(port: SqlPort): Promise<Result<string[], RepoError>> {
  const rows = await queryAll(
    port,
    z.object({ id: z.string() }),
    `SELECT DISTINCT p.chapter_id AS id FROM paragraph p JOIN chapter c ON c.id = p.chapter_id
     WHERE c.status = 'normal' AND trim(p.text) <> ''`,
  );
  return rows.ok ? ok(rows.value.map((r) => r.id)) : rows;
}

/** 写入（或重建）一章的记忆：整行替换，状态回到有效。 */
export async function saveChapterMemory(port: SqlPort, input: MemoryInput, ctx: WriteContext): Promise<Result<ChapterMemory, RepoError>> {
  const result = await port.transaction([
    {
      sql: `INSERT INTO chapter_memory (chapter_id, summary, cast_state, foreshadow_progress, based_on, status, llm_call_id, created_at, updated_at, open_threads)
            VALUES (?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?)
            ON CONFLICT (chapter_id) DO UPDATE SET summary = excluded.summary, cast_state = excluded.cast_state,
              foreshadow_progress = excluded.foreshadow_progress, based_on = excluded.based_on, status = 'valid', open_threads = excluded.open_threads,
              llm_call_id = excluded.llm_call_id, version = chapter_memory.version + 1, updated_at = excluded.updated_at
            RETURNING ${COLUMNS}`,
      params: [
        input.chapterId,
        input.summary,
        JSON.stringify(input.castState),
        JSON.stringify(input.foreshadowProgress),
        JSON.stringify(input.basedOn),
        input.llmCallId,
        ctx.now,
        ctx.now,
        JSON.stringify((input.openThreads ?? []).map((t) => t.trim()).filter((t) => t !== '')),
      ],
    },
  ]);
  if (!result.ok) return err({ code: 'sql', error: result.error });
  const row = MemoryRow.safeParse(result.value[0]?.rows[0]);
  return row.success ? ok(row.data) : err({ code: 'invalid', detail: '写入后没有返回记录' });
}

/**
 * 依据的段落改过、删掉，或本章多了新段落时，记忆标为待复核。打开作品与保存章节后调用；可随时重算。
 * 返回新标为待复核的章节。比较在一条查询里做完：以前每部记忆各查一次本章的段落，几百章的书每读一次计划视图
 * 就要来回上百次、搬近 1 MB 的段落版本，写手写着的时候界面跟着卡。
 */
export async function reviewStaleMemories(port: SqlPort, ctx: WriteContext): Promise<Result<string[], RepoError>> {
  const changed = await queryAll(
    port,
    z.object({ chapter_id: z.string() }),
    `SELECT m.chapter_id FROM chapter_memory m
     WHERE m.status = 'valid' AND (
       (SELECT count(*) FROM paragraph p WHERE p.chapter_id = m.chapter_id) <> (SELECT count(*) FROM json_each(m.based_on))
       OR EXISTS (
         SELECT 1 FROM json_each(m.based_on) j LEFT JOIN paragraph p ON p.id = j.key AND p.chapter_id = m.chapter_id
         WHERE p.id IS NULL OR p.version <> j.value
       )
     )`,
  );
  if (!changed.ok) return changed;
  const stale = changed.value.map((r) => r.chapter_id);
  if (stale.length === 0) return ok([]);
  const result = await port.transaction(
    stale.map((id) => ({ sql: "UPDATE chapter_memory SET status = 'stale', version = version + 1, updated_at = ? WHERE chapter_id = ?", params: [ctx.now, id] })),
  );
  return result.ok ? ok(stale) : err({ code: 'sql', error: result.error });
}

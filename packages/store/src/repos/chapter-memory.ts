// 长篇记忆（需求 B66）：已写章节的摘要、人物状态与伏笔进展，供写手与审核作为前文。
// 它是派生结论（硬性规则 21），记录依据的段落版本；正文修改后由 reviewStaleMemories 标为待复核。
import type { Result } from '@fudiao/shared';
import { err, ok } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { jsonColumn, queryAll, queryOne, type RepoError, type WriteContext } from './common';

const MemoryRow = z
  .object({
    chapter_id: z.string(),
    summary: z.string(),
    cast_state: jsonColumn(z.record(z.string(), z.string())),
    foreshadow_progress: jsonColumn(z.record(z.string(), z.string())),
    based_on: jsonColumn(z.record(z.string(), z.number().int())),
    status: z.enum(['valid', 'stale']),
    llm_call_id: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    chapterId: r.chapter_id,
    summary: r.summary,
    /** 人物设定标识 → 本章结束时的状态。 */
    castState: r.cast_state,
    /** 伏笔标识 → 本章中的进展。 */
    foreshadowProgress: r.foreshadow_progress,
    /** 生成时依据的段落：段落标识 → 版本。 */
    basedOn: r.based_on,
    status: r.status,
    llmCallId: r.llm_call_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type ChapterMemory = z.output<typeof MemoryRow>;

const COLUMNS = 'chapter_id, summary, cast_state, foreshadow_progress, based_on, status, llm_call_id, version, created_at, updated_at';

export type MemoryInput = {
  readonly chapterId: string;
  readonly summary: string;
  readonly castState: Readonly<Record<string, string>>;
  readonly foreshadowProgress: Readonly<Record<string, string>>;
  readonly basedOn: Readonly<Record<string, number>>;
  readonly llmCallId: string | null;
};

export function getChapterMemory(port: SqlPort, chapterId: string): Promise<Result<ChapterMemory | null, RepoError>> {
  return queryOne(port, MemoryRow, `SELECT ${COLUMNS} FROM chapter_memory WHERE chapter_id = ?`, [chapterId]);
}

/** 回收站以外的章节的记忆，按章节顺序。 */
export function listChapterMemories(port: SqlPort): Promise<Result<ChapterMemory[], RepoError>> {
  return queryAll(
    port,
    MemoryRow,
    `SELECT ${COLUMNS.split(', ').map((c) => `m.${c}`).join(', ')} FROM chapter_memory m JOIN chapter c ON c.id = m.chapter_id
     WHERE c.status = 'normal' ORDER BY c.order_key`,
  );
}

/** 写入（或重建）一章的记忆：整行替换，状态回到有效。 */
export async function saveChapterMemory(port: SqlPort, input: MemoryInput, ctx: WriteContext): Promise<Result<ChapterMemory, RepoError>> {
  const result = await port.transaction([
    {
      sql: `INSERT INTO chapter_memory (chapter_id, summary, cast_state, foreshadow_progress, based_on, status, llm_call_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'valid', ?, ?, ?)
            ON CONFLICT (chapter_id) DO UPDATE SET summary = excluded.summary, cast_state = excluded.cast_state,
              foreshadow_progress = excluded.foreshadow_progress, based_on = excluded.based_on, status = 'valid',
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
      ],
    },
  ]);
  if (!result.ok) return err({ code: 'sql', error: result.error });
  const row = MemoryRow.safeParse(result.value[0]?.rows[0]);
  return row.success ? ok(row.data) : err({ code: 'invalid', detail: '写入后没有返回记录' });
}

/**
 * 依据的段落改过、删掉，或本章多了新段落时，记忆标为待复核。打开作品与保存章节后调用；可随时重算。
 * 返回新标为待复核的章节。
 */
export async function reviewStaleMemories(port: SqlPort, ctx: WriteContext): Promise<Result<string[], RepoError>> {
  const memories = await queryAll(port, MemoryRow, `SELECT ${COLUMNS} FROM chapter_memory WHERE status = 'valid'`);
  if (!memories.ok) return memories;
  const stale: string[] = [];
  for (const m of memories.value) {
    const rows = await port.query('SELECT id, version FROM paragraph WHERE chapter_id = ?', [m.chapterId]);
    if (!rows.ok) return err({ code: 'sql', error: rows.error });
    const current = new Map(rows.value.map((r) => [String(r['id']), Number(r['version'])]));
    const changed =
      current.size !== Object.keys(m.basedOn).length || Object.entries(m.basedOn).some(([id, version]) => current.get(id) !== version);
    if (changed) stale.push(m.chapterId);
  }
  if (stale.length === 0) return ok([]);
  const result = await port.transaction(
    stale.map((id) => ({ sql: "UPDATE chapter_memory SET status = 'stale', version = version + 1, updated_at = ? WHERE chapter_id = ?", params: [ctx.now, id] })),
  );
  return result.ok ? ok(stale) : err({ code: 'sql', error: result.error });
}

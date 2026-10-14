// 候选稿（需求 B17）：AI 结果先成为候选稿，作者比较、修改后接受或放弃；接受前检查原文是否改过（过期）。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, queryAll, queryOne, type RepoError, type WriteContext } from './common';
import type { TextRange } from './paragraph-range';

/** narrate：由推演的节拍表写成的正文（B29、B62），带着它依据的节拍表。 */
export const CANDIDATE_OPERATIONS = ['continue', 'rewrite', 'expand', 'shorten', 'polish', 'narrate'] as const;
export type CandidateOperation = (typeof CANDIDATE_OPERATIONS)[number];
export type CandidateStatus = 'pending' | 'accepted' | 'discarded' | 'stale';

const Position = z.object({ paragraphId: z.string(), offset: z.number().int().nonnegative() });

const json = <T>(schema: z.ZodType<T>) =>
  z.string().transform((text, ctx): T => {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // 落到下面的错误
    }
    ctx.addIssue({ code: 'custom', message: '候选稿数据格式无效' });
    return z.NEVER;
  });

const CandidateRow = z
  .object({
    id: z.string(),
    chapter_id: z.string(),
    operation: z.enum(CANDIDATE_OPERATIONS),
    target: json(z.object({ from: Position, to: Position })),
    base_text: z.string(),
    base_versions: json(z.record(z.string(), z.number().int())),
    generated: z.string(),
    content: z.string(),
    status: z.enum(['pending', 'accepted', 'discarded', 'stale']),
    status_reason: z.string().nullable(),
    llm_call_id: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    beat_sheet_id: z.string().nullable(),
  })
  .transform((r) => ({
    id: r.id,
    chapterId: r.chapter_id,
    operation: r.operation,
    target: r.target,
    baseText: r.base_text,
    baseVersions: r.base_versions,
    generated: r.generated,
    content: r.content,
    status: r.status,
    statusReason: r.status_reason,
    llmCallId: r.llm_call_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    /** 由节拍表写成的候选稿依据的节拍表；其余为 null。 */
    beatSheetId: r.beat_sheet_id,
  }));
export type Candidate = z.output<typeof CandidateRow>;

const COLUMNS = 'id, chapter_id, operation, target, base_text, base_versions, generated, content, status, status_reason, llm_call_id, version, created_at, updated_at, beat_sheet_id';

export type CandidateInput = {
  readonly id: string;
  readonly chapterId: string;
  readonly operation: CandidateOperation;
  readonly target: TextRange;
  readonly baseText: string;
  readonly baseVersions: Readonly<Record<string, number>>;
  readonly generated: string;
  readonly llmCallId: string | null;
  readonly beatSheetId?: string;
};

export function createCandidate(port: SqlPort, input: CandidateInput, ctx: WriteContext): Promise<Result<Candidate, RepoError>> {
  return insertReturning(port, CandidateRow, {
    sql: `INSERT INTO candidate (id, chapter_id, operation, target, base_text, base_versions, generated, content, llm_call_id, beat_sheet_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [
      input.id,
      input.chapterId,
      input.operation,
      JSON.stringify(input.target),
      input.baseText,
      JSON.stringify(input.baseVersions),
      input.generated,
      input.generated,
      input.llmCallId,
      input.beatSheetId ?? null,
      ctx.now,
      ctx.now,
    ],
  });
}

/** 一章的候选稿，新的在前；默认只列待处理的。 */
export function listCandidates(port: SqlPort, chapterId: string, statuses: readonly CandidateStatus[] = ['pending']): Promise<Result<Candidate[], RepoError>> {
  return queryAll(
    port,
    CandidateRow,
    `SELECT ${COLUMNS} FROM candidate WHERE chapter_id = ? AND status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at DESC, id DESC`,
    [chapterId, ...statuses],
  );
}

export async function getCandidate(port: SqlPort, id: string): Promise<Result<Candidate, RepoError>> {
  const row = await queryOne(port, CandidateRow, `SELECT ${COLUMNS} FROM candidate WHERE id = ?`, [id]);
  if (!row.ok) return row;
  return row.value === null ? err({ code: 'not_found' }) : ok(row.value);
}

/** 作者修改候选稿的内容（接受之前）。 */
export function updateCandidateContent(port: SqlPort, candidate: Candidate, content: string, ctx: WriteContext): Promise<Result<Candidate, RepoError>> {
  return guardedUpdate(port, CandidateRow, 'candidate', candidate.id, {
    sql: `UPDATE candidate SET content = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'pending' RETURNING ${COLUMNS}`,
    params: [content, ctx.now, candidate.id, candidate.version],
  });
}

/** 改变候选稿的状态：接受、放弃或过期（附原因）。只有待处理的候选稿可以改变。 */
export function setCandidateStatus(
  port: SqlPort,
  candidate: Candidate,
  status: Exclude<CandidateStatus, 'pending'>,
  reason: string | null,
  ctx: WriteContext,
): Promise<Result<Candidate, RepoError>> {
  return guardedUpdate(port, CandidateRow, 'candidate', candidate.id, {
    sql: `UPDATE candidate SET status = ?, status_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'pending' RETURNING ${COLUMNS}`,
    params: [status, reason, ctx.now, candidate.id, candidate.version],
  });
}

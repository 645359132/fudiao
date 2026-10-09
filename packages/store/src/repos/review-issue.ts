// 审核问题（需求 B64）：定位到段落锚点，写明依据与修改建议。它是派生结论（硬性规则 21），记录依据的段落版本；
// 段落修改后，仍待处理的问题由 reviewStaleIssues 标为过期。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, jsonColumn, ParagraphAnchor, queryAll, type RepoError, type WriteContext } from './common';

export const ISSUE_KINDS = ['setting_conflict', 'timeline', 'pov_leak', 'foreshadow', 'character', 'off_plan', 'pacing', 'ai_tone'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export const ISSUE_STATUSES = ['pending', 'ignored', 'fixed', 'sent_to_writer', 'stale'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssueSeverity = 'high' | 'medium' | 'low';

/** 问题的依据：设定、事实、伏笔或前文段落。 */
export const IssueEvidence = z.object({ type: z.enum(['entity', 'fact', 'foreshadow', 'paragraph', 'plan']), id: z.string() });
export type IssueEvidence = z.infer<typeof IssueEvidence>;

const IssueRow = z
  .object({
    id: z.string(),
    chapter_id: z.string(),
    kind: z.enum(ISSUE_KINDS),
    severity: z.enum(['high', 'medium', 'low']),
    anchor: jsonColumn(ParagraphAnchor),
    evidence: jsonColumn(z.array(IssueEvidence)),
    description: z.string(),
    suggestion: z.string(),
    status: z.enum(ISSUE_STATUSES),
    source: z.enum(['program', 'model']),
    llm_call_id: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    chapterId: r.chapter_id,
    kind: r.kind,
    severity: r.severity,
    anchor: r.anchor,
    evidence: r.evidence,
    description: r.description,
    suggestion: r.suggestion,
    status: r.status,
    source: r.source,
    llmCallId: r.llm_call_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type ReviewIssue = z.output<typeof IssueRow>;

const COLUMNS = 'id, chapter_id, kind, severity, anchor, evidence, description, suggestion, status, source, llm_call_id, version, created_at, updated_at';

export type IssueInput = {
  readonly id: string;
  readonly chapterId: string;
  readonly kind: IssueKind;
  readonly severity: IssueSeverity;
  readonly anchor: ParagraphAnchor;
  readonly evidence: readonly IssueEvidence[];
  readonly description: string;
  readonly suggestion: string;
  /** 模型审核的问题带调用记录；程序检查的问题为 null。 */
  readonly llmCallId: string | null;
  readonly source: 'program' | 'model';
};

/** 一次审核的问题一并写入。 */
export async function addIssues(port: SqlPort, issues: readonly IssueInput[], ctx: WriteContext): Promise<Result<void, RepoError>> {
  if (issues.length === 0) return ok(undefined);
  const result = await port.transaction(
    issues.map((i) => ({
      sql: `INSERT INTO review_issue (id, chapter_id, kind, severity, anchor, evidence, description, suggestion, source, llm_call_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        i.id,
        i.chapterId,
        i.kind,
        i.severity,
        JSON.stringify(i.anchor),
        JSON.stringify(i.evidence),
        i.description,
        i.suggestion,
        i.source,
        i.llmCallId,
        ctx.now,
        ctx.now,
      ],
    })),
  );
  return result.ok ? ok(undefined) : err({ code: 'sql', error: result.error });
}

/** 一章的问题，严重的在前；默认只列待处理的。 */
export function listIssues(port: SqlPort, chapterId: string, statuses: readonly IssueStatus[] = ['pending']): Promise<Result<ReviewIssue[], RepoError>> {
  return queryAll(
    port,
    IssueRow,
    `SELECT ${COLUMNS} FROM review_issue WHERE chapter_id = ? AND status IN (${statuses.map(() => '?').join(', ')})
     ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at, id`,
    [chapterId, ...statuses],
  );
}

/** 作者处理问题：忽略、已修改或交给写手修订。只有待处理的问题可以改变。 */
export function setIssueStatus(port: SqlPort, current: ReviewIssue, status: Exclude<IssueStatus, 'pending' | 'stale'>, ctx: WriteContext): Promise<Result<ReviewIssue, RepoError>> {
  return guardedUpdate(port, IssueRow, 'review_issue', current.id, {
    sql: `UPDATE review_issue SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'pending' RETURNING ${COLUMNS}`,
    params: [status, ctx.now, current.id, current.version],
  });
}

/** 锚点所在段落改过或删掉的待处理问题标为过期。返回过期的问题标识。 */
export async function reviewStaleIssues(port: SqlPort, chapterId: string, ctx: WriteContext): Promise<Result<string[], RepoError>> {
  const pending = await listIssues(port, chapterId);
  if (!pending.ok) return pending;
  const rows = await port.query('SELECT id, version FROM paragraph WHERE chapter_id = ?', [chapterId]);
  if (!rows.ok) return err({ code: 'sql', error: rows.error });
  const current = new Map(rows.value.map((r) => [String(r['id']), Number(r['version'])]));
  const stale = pending.value.filter((i) => current.get(i.anchor.paragraphId) !== i.anchor.paragraphVersion).map((i) => i.id);
  if (stale.length === 0) return ok([]);
  const result = await port.transaction(
    stale.map((id) => ({ sql: "UPDATE review_issue SET status = 'stale', version = version + 1, updated_at = ? WHERE id = ? AND status = 'pending'", params: [ctx.now, id] })),
  );
  return result.ok ? ok(stale) : err({ code: 'sql', error: result.error });
}

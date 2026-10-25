// 审核问题（需求 B64）：定位到段落锚点，写明依据与修改建议。它是派生结论（硬性规则 21），记录依据的段落版本；
// 段落修改后，仍待处理的问题由 reviewStaleIssues 标为过期。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, Statement } from '../sql';
import { guardedUpdate, jsonColumn, ParagraphAnchor, queryAll, queryOne, type RepoError, type WriteContext } from './common';

export const ISSUE_KINDS = ['setting_conflict', 'timeline', 'pov_leak', 'foreshadow', 'character', 'off_plan', 'pacing', 'ai_tone'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export const ISSUE_STATUSES = ['pending', 'ignored', 'fixed', 'sent_to_writer', 'stale'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssueSeverity = 'high' | 'medium' | 'low';
/** 问题的来源：程序检查、模型审核（单章）、跨章连贯检查（全书体检，迁移 0020）、开篇诊断（开篇打磨，迁移 0021）。 */
export const ISSUE_SOURCES = ['program', 'model', 'continuity', 'opening'] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

/**
 * 问题的依据：设定、事实、伏笔或段落。另一章的段落（全书体检的跨章连贯检查，B80）带上所在的章节与当时的版本，
 * 那一段改过之后问题标为过期。
 */
export const IssueEvidence = z.object({
  type: z.enum(['entity', 'fact', 'foreshadow', 'paragraph', 'plan']),
  id: z.string(),
  chapterId: z.string().optional(),
  version: z.number().int().optional(),
});
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
    source: z.enum(ISSUE_SOURCES),
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
  /** 模型审核与连贯检查的问题带调用记录；程序检查的问题为 null。 */
  readonly llmCallId: string | null;
  readonly source: IssueSource;
};

const insert = (i: IssueInput, ctx: WriteContext): Statement => ({
  sql: `INSERT INTO review_issue (id, chapter_id, kind, severity, anchor, evidence, description, suggestion, source, llm_call_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  params: [i.id, i.chapterId, i.kind, i.severity, JSON.stringify(i.anchor), JSON.stringify(i.evidence), i.description, i.suggestion, i.source, i.llmCallId, ctx.now, ctx.now],
});

/** 一次审核的问题一并写入。 */
export async function addIssues(port: SqlPort, issues: readonly IssueInput[], ctx: WriteContext): Promise<Result<void, RepoError>> {
  if (issues.length === 0) return ok(undefined);
  const result = await port.transaction(issues.map((i) => insert(i, ctx)));
  return result.ok ? ok(undefined) : err({ code: 'sql', error: result.error });
}

/**
 * 重新审核：这一章同一来源（程序或模型）仍待处理的旧问题标为过期，换成这一次的问题，在同一事务中完成。
 * 作者已经处理的问题（忽略、已修改、已交写手）不动。
 */
export async function replacePendingIssues(
  port: SqlPort,
  chapterId: string,
  source: IssueInput['source'],
  issues: readonly IssueInput[],
  ctx: WriteContext,
): Promise<Result<void, RepoError>> {
  const result = await port.transaction([
    {
      sql: "UPDATE review_issue SET status = 'stale', version = version + 1, updated_at = ? WHERE chapter_id = ? AND source = ? AND status = 'pending'",
      params: [ctx.now, chapterId, source],
    },
    ...issues.map((i) => insert(i, ctx)),
  ]);
  return result.ok ? ok(undefined) : err({ code: 'sql', error: result.error });
}

export function getIssue(port: SqlPort, id: string): Promise<Result<ReviewIssue | null, RepoError>> {
  return queryOne(port, IssueRow, `SELECT ${COLUMNS} FROM review_issue WHERE id = ?`, [id]);
}

/** 各章待处理的问题数（回收站以外的章节）。 */
export async function countPendingIssues(port: SqlPort): Promise<Result<Map<string, number>, RepoError>> {
  const rows = await queryAll(
    port,
    z.object({ id: z.string(), n: z.number().int() }),
    `SELECT i.chapter_id AS id, count(*) AS n FROM review_issue i JOIN chapter c ON c.id = i.chapter_id
     WHERE i.status = 'pending' AND c.status = 'normal' GROUP BY i.chapter_id`,
  );
  return rows.ok ? ok(new Map(rows.value.map((r) => [r.id, r.n]))) : rows;
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

/**
 * 重新定位一条过期的问题（一键交给写手修订，B64 补充）：同一章里前一条修订改了这一段，问题的引文仍在现在的正文里时，
 * 锚点换成现在的段落与版本，重新标为待处理。只改过期的问题，依据不变（依据过期的问题由调用方跳过）。
 */
export function reanchorIssue(port: SqlPort, current: ReviewIssue, anchor: ParagraphAnchor, ctx: WriteContext): Promise<Result<ReviewIssue, RepoError>> {
  return guardedUpdate(port, IssueRow, 'review_issue', current.id, {
    sql: `UPDATE review_issue SET anchor = ?, status = 'pending', version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'stale' RETURNING ${COLUMNS}`,
    params: [JSON.stringify(anchor), ctx.now, current.id, current.version],
  });
}

/** 待处理的问题与它所在段落的字数（一键修订开始前估算费用用）。 */
export type PendingIssueSize = {
  readonly id: string;
  readonly chapterId: string;
  readonly severity: IssueSeverity;
  readonly source: IssueSource;
  readonly paragraphId: string;
  readonly quote: string;
  /** 锚点所在段落现在的字数。 */
  readonly length: number;
};

/**
 * 回收站以外各章待处理的问题与所在段落的字数，一条查询读完（几百章的书不逐章读段落）。
 * 锚点所在段落已改过或删掉的问题（实际已过期，只是还没标出）不列。
 */
export async function listPendingIssueSizes(port: SqlPort): Promise<Result<PendingIssueSize[], RepoError>> {
  const rows = await queryAll(
    port,
    z.object({ id: z.string(), chapter_id: z.string(), severity: z.enum(['high', 'medium', 'low']), source: z.enum(ISSUE_SOURCES), paragraph_id: z.string(), quote: z.string(), length: z.number().int() }),
    `SELECT i.id, i.chapter_id, i.severity, i.source, p.id AS paragraph_id, json_extract(i.anchor, '$.quote') AS quote, length(p.text) AS length
     FROM review_issue i
     JOIN chapter c ON c.id = i.chapter_id
     JOIN paragraph p ON p.id = json_extract(i.anchor, '$.paragraphId') AND p.version = json_extract(i.anchor, '$.paragraphVersion')
     WHERE i.status = 'pending' AND c.status = 'normal'
     ORDER BY i.chapter_id, i.id`,
  );
  return rows.ok ? ok(rows.value.map((r) => ({ id: r.id, chapterId: r.chapter_id, severity: r.severity, source: r.source, paragraphId: r.paragraph_id, quote: r.quote, length: r.length }))) : rows;
}

/**
 * 锚点所在段落改过或删掉的待处理问题标为过期；依据是另一章的段落（带版本）时，那一段改过或删掉同样过期。
 * 返回过期的问题标识。
 */
export async function reviewStaleIssues(port: SqlPort, chapterId: string, ctx: WriteContext): Promise<Result<string[], RepoError>> {
  const pending = await listIssues(port, chapterId);
  if (!pending.ok) return pending;
  const rows = await port.query('SELECT id, version FROM paragraph WHERE chapter_id = ?', [chapterId]);
  if (!rows.ok) return err({ code: 'sql', error: rows.error });
  const current = new Map(rows.value.map((r) => [String(r['id']), Number(r['version'])]));
  const elsewhere = [...new Set(pending.value.flatMap((i) => i.evidence.flatMap((e) => (e.type === 'paragraph' && e.version !== undefined ? [e.id] : []))))];
  if (elsewhere.length > 0) {
    const others = await port.query(`SELECT id, version FROM paragraph WHERE id IN (${elsewhere.map(() => '?').join(', ')})`, elsewhere);
    if (!others.ok) return err({ code: 'sql', error: others.error });
    for (const r of others.value) current.set(String(r['id']), Number(r['version']));
  }
  const moved = (i: ReviewIssue) => i.evidence.some((e) => e.type === 'paragraph' && e.version !== undefined && current.get(e.id) !== e.version);
  const stale = pending.value.filter((i) => current.get(i.anchor.paragraphId) !== i.anchor.paragraphVersion || moved(i)).map((i) => i.id);
  if (stale.length === 0) return ok([]);
  const result = await port.transaction(
    stale.map((id) => ({ sql: "UPDATE review_issue SET status = 'stale', version = version + 1, updated_at = ? WHERE id = ? AND status = 'pending'", params: [ctx.now, id] })),
  );
  return result.ok ? ok(stale) : err({ code: 'sql', error: result.error });
}

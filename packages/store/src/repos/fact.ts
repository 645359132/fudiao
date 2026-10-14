// 事实记录（需求 B11）与依赖、待复核（B12 首版：设定条目与已确认事实之间）。
import { compareStoryTime, type StoryTime } from '@fudiao/domain';
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, SqlValue, Statement } from '../sql';
import { queryAll, queryOne, type RepoError, type WriteContext } from './common';

export type FactKind = 'world' | 'belief' | 'claim';
export type FactStatus = 'candidate' | 'confirmed' | 'needs_review' | 'rejected';
export type FactModality = 'observed' | 'heard' | 'inferred' | 'claimed';
/** 事实的依据：设定条目或其他事实，记录依据当时的版本。 */
export type FactBasis = { readonly type: 'entity' | 'fact'; readonly id: string; readonly version: number };

export type FactInput = {
  readonly kind: FactKind;
  /** 人物认知与人物说法的持有者（人物设定）；世界事实为 null。 */
  readonly holderId: string | null;
  readonly subjectIds: readonly string[];
  readonly content: string;
  readonly modality: FactModality | null;
  readonly confidence: number | null;
  readonly validFromChapterId: string | null;
  readonly validToChapterId: string | null;
  readonly validFrom: StoryTime | null;
  readonly validTo: StoryTime | null;
  readonly basis: readonly { readonly type: 'entity' | 'fact'; readonly id: string }[];
};

const storyTime = (label: string | null, order: number | null): StoryTime | null => (label === null ? null : { label, order });

const FactRow = z
  .object({
    id: z.string(),
    kind: z.enum(['world', 'belief', 'claim']),
    holder_id: z.string().nullable(),
    subject_ids: z.string(),
    content: z.string(),
    modality: z.enum(['observed', 'heard', 'inferred', 'claimed']).nullable(),
    confidence: z.number().nullable(),
    valid_from_chapter_id: z.string().nullable(),
    valid_to_chapter_id: z.string().nullable(),
    valid_from_label: z.string().nullable(),
    valid_from_order: z.number().nullable(),
    valid_to_label: z.string().nullable(),
    valid_to_order: z.number().nullable(),
    status: z.enum(['candidate', 'confirmed', 'needs_review', 'rejected']),
    review_reason: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    basis: z.string(),
    events: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    kind: r.kind,
    holderId: r.holder_id,
    subjectIds: z.array(z.string()).parse(JSON.parse(r.subject_ids)),
    content: r.content,
    modality: r.modality,
    confidence: r.confidence,
    validFromChapterId: r.valid_from_chapter_id,
    validToChapterId: r.valid_to_chapter_id,
    validFrom: storyTime(r.valid_from_label, r.valid_from_order),
    validTo: storyTime(r.valid_to_label, r.valid_to_order),
    status: r.status,
    reviewReason: r.review_reason,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    basis: z
      .array(z.object({ type: z.enum(['entity', 'fact']), id: z.string(), version: z.number().int().nullable() }))
      .parse(JSON.parse(r.basis))
      .map((b): FactBasis => ({ type: b.type, id: b.id, version: b.version ?? 0 })),
    /** 采纳推演草案时记下的来源：故事事件的标识（事实来源验收：采纳的推演事实定位事件记录）。 */
    eventIds: z.array(z.string()).parse(JSON.parse(r.events)),
  }));
export type Fact = z.output<typeof FactRow>;

const SELECT = `SELECT f.id, f.kind, f.holder_id, f.subject_ids, f.content, f.modality, f.confidence,
  f.valid_from_chapter_id, f.valid_to_chapter_id, f.valid_from_label, f.valid_from_order, f.valid_to_label, f.valid_to_order,
  f.status, f.review_reason, f.version, f.created_at, f.updated_at,
  (SELECT json_group_array(json_object('type', r.to_type, 'id', r.to_id, 'version', r.to_version))
     FROM (SELECT to_type, to_id, to_version FROM source_ref WHERE from_type = 'fact' AND from_id = f.id AND to_type IN ('entity', 'fact') ORDER BY to_type, to_id) AS r) AS basis,
  (SELECT json_group_array(e.to_id)
     FROM (SELECT to_id FROM source_ref WHERE from_type = 'fact' AND from_id = f.id AND to_type = 'story_event' ORDER BY to_id) AS e) AS events
  FROM fact f`;

export function listFacts(port: SqlPort): Promise<Result<Fact[], RepoError>> {
  return queryAll(port, FactRow, `${SELECT} ORDER BY f.created_at, f.id`);
}

export async function getFact(port: SqlPort, id: string): Promise<Result<Fact, RepoError>> {
  const row = await queryOne(port, FactRow, `${SELECT} WHERE f.id = ?`, [id]);
  if (!row.ok) return row;
  return row.value === null ? err({ code: 'not_found' }) : ok(row.value);
}

const invalid = (detail: string): Result<never, RepoError> => err({ code: 'invalid', detail });

const VersionRow = z.object({ id: z.string(), version: z.number().int(), kind: z.string().nullable() });

/** 校验录入的事实，并取得依据的当前版本。 */
async function prepare(port: SqlPort, input: FactInput, selfId: string | null): Promise<Result<FactBasis[], RepoError>> {
  if (input.content.trim() === '') return invalid('事实内容不能为空');
  if (input.kind === 'world') {
    if (input.holderId !== null) return invalid('世界事实没有持有者');
  } else {
    if (input.holderId === null) return invalid('人物认知与人物说法须指定持有者');
    const holder = await queryOne(port, VersionRow, 'SELECT id, version, kind FROM entity WHERE id = ?', [input.holderId]);
    if (!holder.ok) return holder;
    if (holder.value?.kind !== 'character') return invalid('持有者须是人物');
  }
  if (input.kind === 'belief' && input.modality !== null && !['observed', 'heard', 'inferred'].includes(input.modality)) return invalid('人物认知的来源方式为观察、听闻或推测');
  if (input.kind === 'claim' && input.modality !== null && input.modality !== 'claimed') return invalid('人物说法的来源方式为说法');
  if (input.confidence !== null && (input.confidence < 0 || input.confidence > 1)) return invalid('相信程度在 0 到 1 之间');
  for (const t of [input.validFrom, input.validTo]) {
    if (t !== null && (t.label.trim() === '' || (t.order !== null && !Number.isFinite(t.order)))) return invalid('故事时间须有标签，排序值须为数字');
  }
  if (input.validFrom !== null && input.validTo !== null && (compareStoryTime(input.validFrom, input.validTo) ?? 0) > 0) return invalid('故事时间的开始晚于结束');
  if (input.validFromChapterId !== null && input.validToChapterId !== null) {
    // 比较书中的位置（分卷之后，卷的顺序在先）。
    const keys = await queryAll(port, z.object({ chapter_id: z.string(), position: z.number() }), 'SELECT chapter_id, position FROM chapter_book_order WHERE chapter_id IN (?, ?)', [
      input.validFromChapterId,
      input.validToChapterId,
    ]);
    if (!keys.ok) return keys;
    const from = keys.value.find((k) => k.chapter_id === input.validFromChapterId)?.position;
    const to = keys.value.find((k) => k.chapter_id === input.validToChapterId)?.position;
    if (from !== undefined && to !== undefined && from > to) return invalid('适用章节的开始在结束之后');
  }
  const basis: FactBasis[] = [];
  for (const b of input.basis) {
    if (b.type === 'fact' && b.id === selfId) return invalid('事实不能以自己为依据');
    if (basis.some((x) => x.type === b.type && x.id === b.id)) continue;
    const row = await queryOne(port, VersionRow, `SELECT id, version, NULL AS kind FROM ${b.type === 'entity' ? 'entity' : 'fact'} WHERE id = ?`, [b.id]);
    if (!row.ok) return row;
    if (row.value === null) return invalid('依据的设定或事实不存在');
    basis.push({ type: b.type, id: b.id, version: row.value.version });
  }
  return ok(basis);
}

/** 插入一条事实（不含依据）的语句；采纳推演草案时与正文、事件放进同一个事务。调用方负责校验（持有者须是人物等）。 */
export const factInsertStatement = (id: string, input: FactInput, status: FactStatus, ctx: WriteContext): Statement => ({
  sql: `INSERT INTO fact (id, kind, holder_id, subject_ids, content, modality, confidence, valid_from_chapter_id, valid_to_chapter_id,
          valid_from_label, valid_from_order, valid_to_label, valid_to_order, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  params: [id, ...columns(input), status, ctx.now, ctx.now],
});

const columns = (input: FactInput): SqlValue[] => [
  input.kind,
  input.holderId,
  JSON.stringify([...new Set(input.subjectIds)]),
  input.content.trim(),
  input.modality,
  input.confidence,
  input.validFromChapterId,
  input.validToChapterId,
  input.validFrom?.label.trim() ?? null,
  input.validFrom?.order ?? null,
  input.validTo?.label.trim() ?? null,
  input.validTo?.order ?? null,
];

const basisStatements = (factId: string, basis: readonly FactBasis[], ctx: WriteContext, newId: () => string): Statement[] => [
  // 只换设定与事实两类依据；采纳时记下的故事事件来源（to_type = 'story_event'）保留。
  { sql: "DELETE FROM source_ref WHERE from_type = 'fact' AND from_id = ? AND to_type IN ('entity', 'fact')", params: [factId] },
  ...basis.map((b) => ({
    sql: "INSERT INTO source_ref (id, from_type, from_id, to_type, to_id, to_version, created_at) VALUES (?, 'fact', ?, ?, ?, ?, ?)",
    params: [newId(), factId, b.type, b.id, b.version, ctx.now],
  })),
];

export async function createFact(
  port: SqlPort,
  id: string,
  input: FactInput,
  status: FactStatus,
  ctx: WriteContext,
  newId: () => string,
): Promise<Result<Fact, RepoError>> {
  const basis = await prepare(port, input, id);
  if (!basis.ok) return basis;
  const done = await port.transaction([
    {
      sql: `INSERT INTO fact (id, kind, holder_id, subject_ids, content, modality, confidence, valid_from_chapter_id, valid_to_chapter_id,
              valid_from_label, valid_from_order, valid_to_label, valid_to_order, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, ...columns(input), status, ctx.now, ctx.now],
    },
    ...basisStatements(id, basis.value, ctx, newId),
  ]);
  if (!done.ok) return err({ code: 'sql', error: done.error });
  return getFact(port, id);
}

/** 修改事实内容（版本加一，依赖它的已确认事实随后被标为待复核）。状态不变，依据的版本更新为当前版本。 */
export async function updateFact(
  port: SqlPort,
  id: string,
  expectedVersion: number,
  input: FactInput,
  ctx: WriteContext,
  newId: () => string,
): Promise<Result<Fact, RepoError>> {
  const basis = await prepare(port, input, id);
  if (!basis.ok) return basis;
  const done = await port.transaction([
    {
      sql: `UPDATE fact SET kind = ?, holder_id = ?, subject_ids = ?, content = ?, modality = ?, confidence = ?,
              valid_from_chapter_id = ?, valid_to_chapter_id = ?, valid_from_label = ?, valid_from_order = ?, valid_to_label = ?, valid_to_order = ?,
              version = version + 1, updated_at = ?
            WHERE id = ? AND version = ?`,
      params: [...columns(input), ctx.now, id, expectedVersion],
      expectChanges: 1,
    },
    ...basisStatements(id, basis.value, ctx, newId),
  ]);
  if (!done.ok) return err(done.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: done.error });
  return getFact(port, id);
}

/**
 * 改变事实的状态。确认（含复核后重新确认）时把依据的版本更新为当前版本并清除复核原因；
 * 状态变化不提升版本。依据仍待复核时，下次检查会再次标记。
 */
export async function setFactStatus(port: SqlPort, id: string, expectedVersion: number, status: FactStatus, ctx: WriteContext): Promise<Result<Fact, RepoError>> {
  const statements: Statement[] = [
    {
      sql: 'UPDATE fact SET status = ?, review_reason = NULL, updated_at = ? WHERE id = ? AND version = ?',
      params: [status, ctx.now, id, expectedVersion],
      expectChanges: 1,
    },
  ];
  if (status === 'confirmed') {
    statements.push({
      sql: `UPDATE source_ref SET to_version = coalesce(
              CASE to_type WHEN 'entity' THEN (SELECT version FROM entity WHERE id = to_id) ELSE (SELECT version FROM fact WHERE id = to_id) END,
              to_version)
            WHERE from_type = 'fact' AND from_id = ?`,
      params: [id],
    });
  }
  const done = await port.transaction(statements);
  if (!done.ok) return err(done.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: done.error });
  return getFact(port, id);
}

/** 删除事实及其依据记录。以它为依据的已确认事实随后被标为待复核。 */
export async function deleteFact(port: SqlPort, id: string, expectedVersion: number): Promise<Result<void, RepoError>> {
  const done = await port.transaction([
    { sql: 'DELETE FROM fact WHERE id = ? AND version = ?', params: [id, expectedVersion], expectChanges: 1 },
    { sql: "DELETE FROM source_ref WHERE from_type = 'fact' AND from_id = ?", params: [id] },
  ]);
  if (done.ok) return ok(undefined);
  return err(done.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: done.error });
}

const StaleRow = z.object({
  fact_id: z.string(),
  to_type: z.enum(['entity', 'fact']),
  to_id: z.string(),
  current: z.number().int().nullable(),
  recorded: z.number().int().nullable(),
  label: z.string().nullable(),
  target_status: z.string().nullable(),
});

const excerpt = (text: string) => (text.length > 20 ? `${text.slice(0, 20)}……` : text);

/**
 * 标出需要复核的事实（需求 B12 首版）。已确认的事实满足以下任一条件时改为待复核并写明原因：
 * 依据的设定或事实已修改（当前版本高于依据时的版本）、已删除，或依据的事实本身待复核（沿依赖链传递）。
 * 待复核是由依据记录推导的，可以在任何时候重新计算，因此每次修改后与打开作品时各执行一次即可。
 * 候选与已驳回的事实不标记。返回本次标为待复核的事实数。
 */
export async function reviewStaleFacts(port: SqlPort, ctx: WriteContext): Promise<Result<number, RepoError>> {
  let marked = 0;
  for (let round = 0; round < 1_000; round++) {
    const stale = await queryAll(
      port,
      StaleRow,
      `SELECT f.id AS fact_id, r.to_type, r.to_id, r.to_version AS recorded,
         CASE r.to_type WHEN 'entity' THEN e.version ELSE t.version END AS current,
         CASE r.to_type WHEN 'entity' THEN e.name ELSE t.content END AS label,
         t.status AS target_status
       FROM fact f
       JOIN source_ref r ON r.from_type = 'fact' AND r.from_id = f.id
       LEFT JOIN entity e ON r.to_type = 'entity' AND e.id = r.to_id
       LEFT JOIN fact t ON r.to_type = 'fact' AND t.id = r.to_id
       WHERE f.status = 'confirmed' AND r.to_type IN ('entity', 'fact')
         AND (CASE r.to_type WHEN 'entity' THEN e.id ELSE t.id END IS NULL
              OR coalesce(CASE r.to_type WHEN 'entity' THEN e.version ELSE t.version END, 0) > coalesce(r.to_version, 0)
              OR (r.to_type = 'fact' AND t.status = 'needs_review'))
       ORDER BY f.id, r.to_type, r.to_id`,
    );
    if (!stale.ok) return stale;
    if (stale.value.length === 0) return ok(marked);
    const reasons = new Map<string, string>();
    for (const s of stale.value) {
      if (reasons.has(s.fact_id)) continue;
      const what = s.to_type === 'entity' ? `设定“${s.label ?? ''}”` : `依据的事实“${excerpt(s.label ?? '')}”`;
      reasons.set(
        s.fact_id,
        s.current === null ? `${s.to_type === 'entity' ? '依据的设定' : '依据的事实'}已删除` : s.target_status === 'needs_review' && (s.current ?? 0) <= (s.recorded ?? 0) ? `${what}需要复核` : `${what}已修改`,
      );
    }
    const done = await port.transaction(
      [...reasons].map(([id, reason]) => ({
        sql: "UPDATE fact SET status = 'needs_review', review_reason = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'",
        params: [reason, ctx.now, id],
      })),
    );
    if (!done.ok) return err({ code: 'sql', error: done.error });
    marked += reasons.size;
  }
  return ok(marked);
}

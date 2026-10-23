// 关系与人物变化的建议（需求 B73 补充，迁移 0024）：模型从长篇记忆找出、等作者采用或忽略的派生结论（硬性规则 21）。
// 记下来源章节、依据的长篇记忆版本与调用记录；relation_scan 记每章找到了哪个版本的长篇记忆。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, Statement } from '../sql';
import { guardedUpdate, queryAll, queryOne, type RepoError, type WriteContext } from './common';
import { RELATION_CATEGORIES, type RelationCategory } from './relationship';

export const SUGGESTION_KINDS = ['relation_add', 'relation_change', 'relation_end', 'cast_enter', 'cast_exit', 'cast_return'] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];
export const SUGGESTION_STATUSES = ['pending', 'adopted', 'ignored'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

const SuggestionRow = z
  .object({
    id: z.string(),
    chapter_id: z.string(),
    kind: z.enum(SUGGESTION_KINDS),
    relationship_id: z.string().nullable(),
    from_id: z.string().nullable(),
    from_name: z.string(),
    to_id: z.string().nullable(),
    to_name: z.string(),
    category: z.enum(RELATION_CATEGORIES).nullable(),
    label: z.string(),
    old_label: z.string(),
    mutual: z.number().int(),
    secret: z.number().int(),
    description: z.string(),
    valid_to_chapter_id: z.string().nullable(),
    reason: z.string(),
    status: z.enum(SUGGESTION_STATUSES),
    memory_version: z.number().int(),
    llm_call_id: z.string().nullable(),
    result_id: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    chapterId: r.chapter_id,
    kind: r.kind,
    relationshipId: r.relationship_id,
    /** 关系的一端，或出场、退场、回归的人物；还没有人物卡片时 id 为 null。 */
    fromId: r.from_id,
    fromName: r.from_name,
    toId: r.to_id,
    toName: r.to_name,
    category: r.category,
    label: r.label,
    /** 关系改变时原来的称谓。 */
    oldLabel: r.old_label,
    mutual: r.mutual === 1,
    secret: r.secret === 1,
    /** 关系的说明；新人物的小传；退场与回归的说明。 */
    description: r.description,
    /** 新增的关系在同一批里又结束了：到这一章为止。 */
    validToChapterId: r.valid_to_chapter_id,
    reason: r.reason,
    status: r.status,
    memoryVersion: r.memory_version,
    llmCallId: r.llm_call_id,
    resultId: r.result_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type RelationSuggestion = z.output<typeof SuggestionRow>;

export type SuggestionInput = {
  readonly id: string;
  readonly chapterId: string;
  readonly kind: SuggestionKind;
  readonly relationshipId: string | null;
  readonly fromId: string | null;
  readonly fromName: string;
  readonly toId: string | null;
  readonly toName: string;
  readonly category: RelationCategory | null;
  readonly label: string;
  readonly oldLabel: string;
  readonly mutual: boolean;
  readonly secret: boolean;
  readonly description: string;
  readonly validToChapterId: string | null;
  readonly reason: string;
  readonly memoryVersion: number;
};

const COLUMNS =
  'id, chapter_id, kind, relationship_id, from_id, from_name, to_id, to_name, category, label, old_label, mutual, secret, description, valid_to_chapter_id, reason, status, memory_version, llm_call_id, result_id, version, created_at, updated_at';

/** 同一章里先列新人物出场，再列关系，最后是退场与回归（采用时也按这个顺序）。 */
const KIND_ORDER = `CASE s.kind WHEN 'cast_enter' THEN 0 WHEN 'relation_add' THEN 1 WHEN 'relation_change' THEN 2 WHEN 'relation_end' THEN 3 WHEN 'cast_exit' THEN 4 ELSE 5 END`;

/** 回收站以外的章节上的建议，按书中顺序；status 为 null 时列出全部。 */
export function listRelationSuggestions(port: SqlPort, status: SuggestionStatus | null = 'pending'): Promise<Result<RelationSuggestion[], RepoError>> {
  return queryAll(
    port,
    SuggestionRow,
    `SELECT ${COLUMNS.split(', ').map((c) => `s.${c}`).join(', ')} FROM relation_suggestion s JOIN chapter c ON c.id = s.chapter_id
     JOIN chapter_book_order o ON o.chapter_id = c.id WHERE c.status = 'normal' ${status === null ? '' : 'AND s.status = ?'}
     ORDER BY o.position, ${KIND_ORDER}, s.created_at, s.id`,
    status === null ? [] : [status],
  );
}

export function getRelationSuggestion(port: SqlPort, id: string): Promise<Result<RelationSuggestion | null, RepoError>> {
  return queryOne(port, SuggestionRow, `SELECT ${COLUMNS} FROM relation_suggestion WHERE id = ?`, [id]);
}

/** 待确认的条数（回收站以外的章节）：导航“人物关系”上显示。 */
export async function countPendingRelationSuggestions(port: SqlPort): Promise<Result<number, RepoError>> {
  const row = await queryOne(
    port,
    z.object({ n: z.number() }),
    `SELECT count(*) AS n FROM relation_suggestion s JOIN chapter c ON c.id = s.chapter_id WHERE c.status = 'normal' AND s.status = 'pending'`,
  );
  return row.ok ? ok(row.value?.n ?? 0) : row;
}

/** 每章找到了哪个版本的长篇记忆。 */
export async function listRelationScans(port: SqlPort): Promise<Result<Map<string, number>, RepoError>> {
  const rows = await queryAll(port, z.object({ chapter_id: z.string(), memory_version: z.number().int() }), 'SELECT chapter_id, memory_version FROM relation_scan');
  return rows.ok ? ok(new Map(rows.value.map((r) => [r.chapter_id, r.memory_version]))) : rows;
}

/**
 * 还要找的章节（书中顺序）：长篇记忆有效、还没按这一版记忆找过的。记忆重建后版本变了，这一章再找一次。
 * 调用前先 reviewStaleMemories，正文改过的记忆已标为待复核，不在其中。
 */
export async function listRelationScanTodo(port: SqlPort): Promise<Result<{ readonly chapterId: string; readonly memoryVersion: number }[], RepoError>> {
  const rows = await queryAll(
    port,
    z.object({ chapter_id: z.string(), version: z.number().int() }),
    `SELECT m.chapter_id, m.version FROM chapter_memory m JOIN chapter c ON c.id = m.chapter_id JOIN chapter_book_order o ON o.chapter_id = c.id
     LEFT JOIN relation_scan s ON s.chapter_id = m.chapter_id
     WHERE c.status = 'normal' AND m.status = 'valid' AND (s.chapter_id IS NULL OR s.memory_version <> m.version)
     ORDER BY o.position`,
  );
  return rows.ok ? ok(rows.value.map((r) => ({ chapterId: r.chapter_id, memoryVersion: r.version }))) : rows;
}

/** 有正文、却没有有效的长篇记忆的章节数（要先整理或重建记忆才能找）。 */
export async function countChaptersWithoutMemory(port: SqlPort): Promise<Result<number, RepoError>> {
  const row = await queryOne(
    port,
    z.object({ n: z.number() }),
    `SELECT count(DISTINCT p.chapter_id) AS n FROM paragraph p JOIN chapter c ON c.id = p.chapter_id
     WHERE c.status = 'normal' AND trim(p.text) <> ''
       AND NOT EXISTS (SELECT 1 FROM chapter_memory m WHERE m.chapter_id = p.chapter_id AND m.status = 'valid')`,
  );
  return row.ok ? ok(row.value?.n ?? 0) : row;
}

export type RelationScanInput = {
  /** 这一次找过的章节与依据的长篇记忆版本。 */
  readonly scanned: readonly { readonly chapterId: string; readonly memoryVersion: number }[];
  readonly llmCallId: string | null;
  readonly suggestions: readonly SuggestionInput[];
};

/**
 * 记下一次查找的结果（一个事务）：这些章原来待确认的建议换成这一次的（采用过、忽略过的留着），并记下每章找到的记忆版本。
 */
export async function saveRelationScan(port: SqlPort, input: RelationScanInput, ctx: WriteContext): Promise<Result<void, RepoError>> {
  const statements: Statement[] = [
    ...input.scanned.map((c) => ({ sql: "DELETE FROM relation_suggestion WHERE chapter_id = ? AND status = 'pending'", params: [c.chapterId] })),
    ...input.suggestions.map((s) => ({
      sql: `INSERT INTO relation_suggestion (id, chapter_id, kind, relationship_id, from_id, from_name, to_id, to_name, category, label, old_label, mutual, secret, description,
              valid_to_chapter_id, reason, memory_version, llm_call_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        s.id,
        s.chapterId,
        s.kind,
        s.relationshipId,
        s.fromId,
        s.fromName.trim(),
        s.toId,
        s.toName.trim(),
        s.category,
        s.label.trim(),
        s.oldLabel.trim(),
        s.mutual ? 1 : 0,
        s.secret ? 1 : 0,
        s.description.trim(),
        s.validToChapterId,
        s.reason.trim(),
        s.memoryVersion,
        input.llmCallId,
        ctx.now,
        ctx.now,
      ],
    })),
    ...input.scanned.map((c) => ({
      sql: `INSERT INTO relation_scan (chapter_id, memory_version, llm_call_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (chapter_id) DO UPDATE SET memory_version = excluded.memory_version, llm_call_id = excluded.llm_call_id, updated_at = excluded.updated_at`,
      params: [c.chapterId, c.memoryVersion, input.llmCallId, ctx.now, ctx.now],
    })),
  ];
  const done = await port.transaction(statements);
  return done.ok ? ok(undefined) : err({ code: 'sql', error: done.error });
}

/** 采用或忽略一条待确认的建议；resultId 是采用后建出或改动的记录。 */
export function settleRelationSuggestion(
  port: SqlPort,
  id: string,
  expectedVersion: number,
  status: Exclude<SuggestionStatus, 'pending'>,
  resultId: string | null,
  ctx: WriteContext,
): Promise<Result<RelationSuggestion, RepoError>> {
  return guardedUpdate(port, SuggestionRow, 'relation_suggestion', id, {
    sql: `UPDATE relation_suggestion SET status = ?, result_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'pending' RETURNING ${COLUMNS}`,
    params: [status, resultId, ctx.now, id, expectedVersion],
  });
}

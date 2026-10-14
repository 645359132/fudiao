// AI 助手的对话记录（需求 B69，迁移 0011）：每部作品一段，按 seq 只追加；内容的形状由应用层校验。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, Statement } from '../sql';
import { jsonColumn, queryAll, queryOne, type RepoError, type WriteContext } from './common';

export const ASSISTANT_ROLES = ['user', 'assistant', 'results', 'pending'] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

const Row = z
  .object({ id: z.string(), seq: z.number().int(), role: z.enum(ASSISTANT_ROLES), payload: jsonColumn(z.record(z.string(), z.unknown())), created_at: z.string() })
  .transform((r) => ({ id: r.id, seq: r.seq, role: r.role, payload: r.payload, createdAt: r.created_at }));
export type StoredAssistantMessage = z.output<typeof Row>;

export function listAssistantMessages(port: SqlPort): Promise<Result<StoredAssistantMessage[], RepoError>> {
  return queryAll(port, Row, 'SELECT id, seq, role, payload, created_at FROM assistant_message ORDER BY seq');
}

/** 依次追加几条消息；seq 接在已有的最后一条之后，同一事务写入。 */
export async function appendAssistantMessages(
  port: SqlPort,
  messages: readonly { readonly id: string; readonly role: AssistantRole; readonly payload: Readonly<Record<string, unknown>> }[],
  ctx: WriteContext,
): Promise<Result<void, RepoError>> {
  if (messages.length === 0) return ok(undefined);
  const last = await queryOne(port, z.object({ seq: z.number().int().nullable() }), 'SELECT max(seq) AS seq FROM assistant_message');
  if (!last.ok) return last;
  const start = (last.value?.seq ?? 0) + 1;
  const statements: Statement[] = messages.map((m, i) => ({
    sql: 'INSERT INTO assistant_message (id, seq, role, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    params: [m.id, start + i, m.role, JSON.stringify(m.payload), ctx.now],
  }));
  const done = await port.transaction(statements);
  return done.ok ? ok(undefined) : err({ code: 'sql', error: done.error });
}

/** 清空对话（作者“新对话”）。 */
export async function clearAssistantMessages(port: SqlPort): Promise<Result<void, RepoError>> {
  const done = await port.transaction([{ sql: 'DELETE FROM assistant_message', params: [] }]);
  return done.ok ? ok(undefined) : err({ code: 'sql', error: done.error });
}

/** 各章正文的字数（去掉空白后的字符数），供助手了解每章写了多少；没有段落的章节不列。 */
export function chapterLengths(port: SqlPort): Promise<Result<{ chapterId: string; length: number }[], RepoError>> {
  return queryAll(
    port,
    z.object({ chapter_id: z.string(), length: z.number().int() }).transform((r) => ({ chapterId: r.chapter_id, length: r.length })),
    "SELECT chapter_id, sum(length(replace(replace(replace(text, ' ', ''), char(12288), ''), char(10), ''))) AS length FROM paragraph GROUP BY chapter_id",
  );
}

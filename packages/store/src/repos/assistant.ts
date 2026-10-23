// AI 助手的对话记录（需求 B69，迁移 0011；改动与撤销两种记录见迁移 0016；分段的历史对话见迁移 0023）：
// 每部作品可以有多段对话，每段按 seq 只追加；内容的形状由应用层校验。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, Statement } from '../sql';
import { jsonColumn, queryAll, type RepoError, type WriteContext } from './common';

export const ASSISTANT_ROLES = ['user', 'assistant', 'results', 'pending', 'changes', 'undo'] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

/** 迁移 0023 之前的消息归入的那一段对话（时间戳为 0 的 ULID）。 */
export const LEGACY_CONVERSATION_ID = '00000000000000000000000000';

const Row = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    seq: z.number().int(),
    role: z.enum(ASSISTANT_ROLES),
    payload: jsonColumn(z.record(z.string(), z.unknown())),
    created_at: z.string(),
  })
  .transform((r) => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, payload: r.payload, createdAt: r.created_at }));
export type StoredAssistantMessage = z.output<typeof Row>;

const ConversationRow = z
  .object({ id: z.string(), created_at: z.string(), updated_at: z.string(), first_text: z.string().nullable(), messages: z.number().int() })
  .transform((r) => ({ id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, firstText: r.first_text ?? '', messages: r.messages }));
/** 一段对话：作者说的第一句话（界面拿它当标题）、消息条数与最近一次的时间。 */
export type StoredAssistantConversation = z.output<typeof ConversationRow>;

/** 这部作品的各段对话，最近用过的在前。 */
export function listAssistantConversations(port: SqlPort): Promise<Result<StoredAssistantConversation[], RepoError>> {
  return queryAll(
    port,
    ConversationRow,
    `SELECT c.id, c.created_at, c.updated_at,
            (SELECT json_extract(m.payload, '$.text') FROM assistant_message m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.seq LIMIT 1) AS first_text,
            (SELECT count(*) FROM assistant_message m WHERE m.conversation_id = c.id) AS messages
     FROM assistant_conversation c ORDER BY c.updated_at DESC, c.id DESC`,
  );
}

/** 一段对话的消息，按 seq 排列。 */
export function listAssistantMessages(port: SqlPort, conversationId: string): Promise<Result<StoredAssistantMessage[], RepoError>> {
  return queryAll(port, Row, 'SELECT id, conversation_id, seq, role, payload, created_at FROM assistant_message WHERE conversation_id = ? ORDER BY seq', [conversationId]);
}

/** 各段对话里某一种消息，按 seq 排列（撤销要看所有对话里重建记录的新标识）。 */
export function listAssistantMessagesByRole(port: SqlPort, role: AssistantRole): Promise<Result<StoredAssistantMessage[], RepoError>> {
  return queryAll(port, Row, 'SELECT id, conversation_id, seq, role, payload, created_at FROM assistant_message WHERE role = ? ORDER BY seq', [role]);
}

/**
 * 往一段对话里依次追加几条消息；这段对话还没有存过时一并建上（“新对话”在第一句话时才存下，不留空的对话）。
 * seq 接在整张表已有的最后一条之后，在写入的事务里取（同时追加的两批不会撞号）。
 *
 * existing：只追加到已经存下的对话（后台做完的事记回发起它的那段）——那段对话已被删掉时不追加、也不重建；
 * 也不算“用过”，不更新它的时间（打开作品时仍回到作者最近说过话的那一段）。
 */
export async function appendAssistantMessages(
  port: SqlPort,
  conversationId: string,
  messages: readonly { readonly id: string; readonly role: AssistantRole; readonly payload: Readonly<Record<string, unknown>> }[],
  ctx: WriteContext,
  options: { readonly existing?: boolean } = {},
): Promise<Result<void, RepoError>> {
  if (messages.length === 0) return ok(undefined);
  const existing = options.existing === true;
  const statements: Statement[] = [
    ...(existing ? [] : [{ sql: 'INSERT OR IGNORE INTO assistant_conversation (id, created_at, updated_at) VALUES (?, ?, ?)', params: [conversationId, ctx.now, ctx.now] }]),
    ...messages.map((m) => ({
      sql: `INSERT INTO assistant_message (id, conversation_id, seq, role, payload, created_at)
            SELECT ?, ?, n, ?, ?, ? FROM (SELECT COALESCE(max(seq), 0) + 1 AS n FROM assistant_message)
            WHERE EXISTS (SELECT 1 FROM assistant_conversation WHERE id = ?)`,
      params: [m.id, conversationId, m.role, JSON.stringify(m.payload), ctx.now, conversationId],
    })),
    ...(existing ? [] : [{ sql: 'UPDATE assistant_conversation SET updated_at = ? WHERE id = ?', params: [ctx.now, conversationId] }]),
  ];
  const done = await port.transaction(statements);
  return done.ok ? ok(undefined) : err({ code: 'sql', error: done.error });
}

/** 删除一段对话与它的消息（不改动作品：对话里记下的改动不再能从对话里撤销）。 */
export async function deleteAssistantConversation(port: SqlPort, conversationId: string): Promise<Result<void, RepoError>> {
  const done = await port.transaction([
    { sql: 'DELETE FROM assistant_message WHERE conversation_id = ?', params: [conversationId] },
    { sql: 'DELETE FROM assistant_conversation WHERE id = ?', params: [conversationId] },
  ]);
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

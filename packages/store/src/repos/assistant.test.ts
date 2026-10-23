import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { appendAssistantMessages, deleteAssistantConversation, LEGACY_CONVERSATION_ID, listAssistantConversations, listAssistantMessages, listAssistantMessagesByRole } from './assistant';

const ctx = { now: '2026-10-19T00:00:00.000Z' };
const later = { now: '2026-10-20T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-assistant-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fresh(upTo?: number, path = join(root, `p${opened.length}`)): ProjectDb {
  const all = loadMigrations();
  const r = openProjectDb(path, { migrations: upTo === undefined ? all : all.slice(0, upTo), now: ctx.now });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  opened.push(r.value.db);
  return r.value.db;
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('AI 助手的对话记录', () => {
  it('同时追加两批（例如后台的结果与作者的话）：序号在事务里取，两批都写入、不撞号、各批内部顺序不变', async () => {
    const db = fresh();
    const batch = (prefix: string) => [0, 1].map((i) => ({ id: `${prefix}${i}`, role: 'user' as const, payload: { text: `${prefix}${i}` } }));
    const results = await Promise.all([appendAssistantMessages(db, 'c1', batch('a'), ctx), appendAssistantMessages(db, 'c1', batch('b'), ctx)]);
    expect(results).toEqual([
      { ok: true, value: undefined },
      { ok: true, value: undefined },
    ]);
    const rows = value(await listAssistantMessages(db, 'c1'));
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf('a0')).toBeLessThan(ids.indexOf('a1'));
    expect(ids.indexOf('b0')).toBeLessThan(ids.indexOf('b1'));
  });

  it('多段对话：第一句话时建上这一段；列表按最近用过的在前，带第一句话与条数；各段的消息分开；删除一段连同消息', async () => {
    const db = fresh();
    value(await appendAssistantMessages(db, 'old', [{ id: 'o1', role: 'user', payload: { text: '建一卷' } }, { id: 'o2', role: 'assistant', payload: { output: {} } }], ctx));
    value(await appendAssistantMessages(db, 'new', [{ id: 'n1', role: 'user', payload: { text: '写第一章' } }], later));
    expect(value(await listAssistantConversations(db))).toEqual([
      { id: 'new', createdAt: later.now, updatedAt: later.now, firstText: '写第一章', messages: 1 },
      { id: 'old', createdAt: ctx.now, updatedAt: ctx.now, firstText: '建一卷', messages: 2 },
    ]);
    // 回到旧的那一段接着说：它排到前面。
    value(await appendAssistantMessages(db, 'old', [{ id: 'o3', role: 'user', payload: { text: '再建一卷' } }], { now: '2026-10-21T00:00:00.000Z' }));
    expect(value(await listAssistantConversations(db)).map((c) => c.id)).toEqual(['old', 'new']);
    expect(value(await listAssistantMessages(db, 'old')).map((m) => m.id)).toEqual(['o1', 'o2', 'o3']);
    expect(value(await listAssistantMessages(db, 'new')).map((m) => m.id)).toEqual(['n1']);
    value(await deleteAssistantConversation(db, 'old'));
    expect(value(await listAssistantConversations(db)).map((c) => c.id)).toEqual(['new']);
    expect(value(await listAssistantMessages(db, 'old'))).toEqual([]);
  });

  it('只追加到已有的对话（后台做完的记录）：那段对话已删掉时不追加、不重建；追加了也不更新它的时间；按种类列出各段的消息', async () => {
    const db = fresh();
    const say = (id: string, role: 'user' | 'undo' = 'user') => [{ id, role, payload: { text: id } }];
    value(await appendAssistantMessages(db, 'c1', say('a'), ctx));
    value(await appendAssistantMessages(db, 'c2', say('b'), ctx));
    value(await appendAssistantMessages(db, 'c1', say('u1', 'undo'), later, { existing: true }));
    expect(value(await listAssistantMessages(db, 'c1')).map((m) => m.id)).toEqual(['a', 'u1']);
    expect(value(await listAssistantConversations(db)).find((c) => c.id === 'c1')?.updatedAt).toBe(ctx.now);
    value(await deleteAssistantConversation(db, 'c2'));
    value(await appendAssistantMessages(db, 'c2', say('late'), later, { existing: true }));
    expect(value(await listAssistantConversations(db)).map((c) => c.id)).toEqual(['c1']);
    expect(value(await listAssistantMessages(db, 'c2'))).toEqual([]);
    value(await appendAssistantMessages(db, 'c3', say('u2', 'undo'), later));
    expect(value(await listAssistantMessagesByRole(db, 'undo')).map((m) => [m.id, m.conversationId])).toEqual([
      ['u1', 'c1'],
      ['u2', 'c3'],
    ]);
  });

  it('迁移 0023：已有的消息都归入一段对话（固定的标识），时间取最早与最晚一条；没有消息时不建对话', async () => {
    // 先只跑到 0022 写进两条旧消息，关上再按全部迁移打开（迁移执行器补上 0023）。
    const path = join(root, 'legacy');
    const before = fresh(22, path);
    value(
      await before.transaction([
        { sql: "INSERT INTO assistant_message (id, seq, role, payload, created_at) VALUES ('m1', 1, 'user', '{\"text\":\"开一本书\"}', '2026-10-15T00:00:00.000Z')", params: [] },
        { sql: "INSERT INTO assistant_message (id, seq, role, payload, created_at) VALUES ('m2', 2, 'assistant', '{\"output\":{}}', '2026-10-16T00:00:00.000Z')", params: [] },
      ]),
    );
    before.close();
    opened.splice(opened.indexOf(before), 1);
    const db = fresh(undefined, path);
    expect(value(await listAssistantConversations(db))).toEqual([
      { id: LEGACY_CONVERSATION_ID, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', firstText: '开一本书', messages: 2 },
    ]);
    expect(value(await listAssistantMessages(db, LEGACY_CONVERSATION_ID)).map((m) => m.seq)).toEqual([1, 2]);
    expect(value(await listAssistantConversations(fresh()))).toEqual([]);
  });
});

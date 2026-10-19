import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { appendAssistantMessages, listAssistantMessages } from './assistant';

const ctx = { now: '2026-10-19T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-assistant-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fresh(): ProjectDb {
  const r = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: ctx.now });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  opened.push(r.value.db);
  return r.value.db;
}

describe('AI 助手的对话记录', () => {
  it('同时追加两批（例如后台的结果与作者的话）：序号在事务里取，两批都写入、不撞号、各批内部顺序不变', async () => {
    const db = fresh();
    const batch = (prefix: string) => [0, 1].map((i) => ({ id: `${prefix}${i}`, role: 'user' as const, payload: { text: `${prefix}${i}` } }));
    const results = await Promise.all([appendAssistantMessages(db, batch('a'), ctx), appendAssistantMessages(db, batch('b'), ctx)]);
    expect(results).toEqual([
      { ok: true, value: undefined },
      { ok: true, value: undefined },
    ]);
    const rows = await listAssistantMessages(db);
    if (!rows.ok) throw new Error('list');
    expect(rows.value.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    const ids = rows.value.map((r) => r.id);
    expect(ids.indexOf('a0')).toBeLessThan(ids.indexOf('a1'));
    expect(ids.indexOf('b0')).toBeLessThan(ids.indexOf('b1'));
  });
});

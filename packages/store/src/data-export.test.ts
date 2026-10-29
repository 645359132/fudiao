// 导出与后台写入交错（审查后的修正，2026-10-29）：各张表要读自同一个快照。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportData, importData } from './data-export';
import { loadMigrations, openProjectDb, type ProjectDb } from './node/sqlite';
import { createChapter, createProject, saveChapterParagraphs } from './repos';
import type { Query, SqlPort, SqlValue, Statement } from './sql';

const ctx = { now: '2026-10-29T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-export-'));
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

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('导出与后台写入交错', () => {
  it('后台写作期间导出：各表读自同一个快照——读过章节表之后别处新建的章与段落不进导出，导回不报外键错', async () => {
    const db = fresh();
    value(await createProject(db, { id: 'P1', title: '雨夜' }, ctx));
    value(await createChapter(db, { id: 'c1', title: '第一章' }, ctx));
    value(await saveChapterParagraphs(db, 'c1', [], [{ id: 'a', text: '雨下得更紧了。', source: 'handwritten' }], { splits: [], merges: [] }, ctx));
    // 模拟写手在导出期间写入：读过章节表之后（分开读的旧写法在读章节表与段落表之间；一次批量读取则在整批之后）新建一章并写一段。
    let interleaved = false;
    const write = async () => {
      interleaved = true;
      value(await createChapter(db, { id: 'c9', title: '第九章' }, ctx));
      value(await saveChapterParagraphs(db, 'c9', [], [{ id: 'z', text: '写手写的。', source: 'ai_generated' }], { splits: [], merges: [] }, ctx));
    };
    const racing: SqlPort = {
      async query(sql: string, params?: readonly SqlValue[]) {
        const rows = await db.query(sql, params);
        if (!interleaved && /FROM chapter\b/.test(sql)) await write();
        return rows;
      },
      async read(queries: readonly Query[]) {
        const rows = await db.read(queries);
        if (!interleaved && queries.some((q) => /FROM chapter\b/.test(q.sql))) await write();
        return rows;
      },
      transaction: (statements: readonly Statement[]) => db.transaction(statements),
    };
    const data = value(await exportData(racing));
    expect(interleaved).toBe(true);
    expect(data.tables['chapter']?.map((r) => r['id'])).toEqual(['c1']);
    expect(data.tables['paragraph']?.map((r) => r['id'])).toEqual(['a']);
    // 导回成一部新作品：段落都有它的章。
    const copy = fresh();
    expect(value(await importData(copy, data))).toMatchObject({ chapter: 1, paragraph: 1 });
  });
});

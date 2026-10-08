import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter, listChapters } from './chapter';
import { importChapters } from './import';
import { listParagraphs } from './paragraph';

const ctx = { now: '2026-10-08T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-import-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fresh(): ProjectDb {
  const result = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: ctx.now });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  opened.push(result.value.db);
  return result.value.db;
}

function ids() {
  let n = 0;
  return () => `id${String(n++).padStart(5, '0')}`;
}

describe('导入章节', () => {
  it('追加到目录末尾，段落顺序与导入时一致', async () => {
    const db = fresh();
    expect((await createChapter(db, { id: 'c0', title: '已有的一章' }, ctx)).ok).toBe(true);
    const result = await importChapters(
      db,
      [
        { title: '第一章 雨夜', paragraphs: ['雨下得更紧了。', '他没有回头。'] },
        { title: '第二章 当铺', paragraphs: [] },
      ],
      ctx,
      ids(),
    );
    expect(result).toMatchObject({ ok: true, value: { paragraphs: 2 } });
    const chapters = await listChapters(db, 'normal');
    expect(chapters.ok && chapters.value.map((c) => c.title)).toEqual(['已有的一章', '第一章 雨夜', '第二章 当铺']);
    const first = result.ok ? result.value.chapterIds[0] ?? '' : '';
    const paragraphs = await listParagraphs(db, first);
    expect(paragraphs.ok && paragraphs.value.map((p) => p.text)).toEqual(['雨下得更紧了。', '他没有回头。']);
  });

  it('大量章节与段落在一个事务中写入', async () => {
    const db = fresh();
    const chapters = Array.from({ length: 300 }, (_, i) => ({ title: `第${i + 1}章`, paragraphs: Array.from({ length: 20 }, (_, j) => `第${i + 1}章第${j + 1}段。`) }));
    const result = await importChapters(db, chapters, ctx, ids());
    expect(result).toMatchObject({ ok: true, value: { paragraphs: 6_000 } });
    const list = await listChapters(db, 'normal');
    expect(list.ok && list.value.map((c) => c.title)).toEqual(chapters.map((c) => c.title));
  });

  it('章节名为空时整批不写入', async () => {
    const db = fresh();
    expect(await importChapters(db, [{ title: '甲', paragraphs: [] }, { title: ' ', paragraphs: [] }], ctx, ids())).toMatchObject({ ok: false, error: { code: 'invalid' } });
    const list = await listChapters(db, 'normal');
    expect(list.ok && list.value).toEqual([]);
  });
});

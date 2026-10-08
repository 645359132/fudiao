import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { listChapters, trashChapter } from './chapter';
import { importChapters } from './import';
import { listParagraphs, saveChapterParagraphs } from './paragraph';
import { searchParagraphs, type SearchResult } from './search';

const ctx = { now: '2026-10-08T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-search-'));
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

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function ids() {
  let n = 0;
  return () => `id${String(n++).padStart(5, '0')}`;
}

async function work(chapters: { title: string; paragraphs: string[] }[]) {
  const db = fresh();
  value(await importChapters(db, chapters, ctx, ids()));
  return db;
}

const where = (r: SearchResult) => r.hits.map((h) => [h.chapterTitle, h.start, h.end, `${h.before}[${h.match}]${h.after}`]);

describe('全文查找', () => {
  const novel = [
    { title: '第一章 雨夜', paragraphs: ['雨下得更紧了，他没有回头。', '当铺的门半掩着。'] },
    { title: '第二章 当铺', paragraphs: ['掌柜抬起头，看见门外的人。', '“当铺不收这个。”掌柜说。'] },
  ];

  it('3 字及以上走全文索引，按章节与段落顺序给出每一处的位置与上下文', async () => {
    const db = await work(novel);
    const r = value(await searchParagraphs(db, '当铺的'));
    expect(r.mode).toBe('index');
    expect(where(r)).toEqual([['第一章 雨夜', 0, 3, '[当铺的]门半掩着。']]);
  });

  it('1 至 2 字退化为扫描段落，结果与索引一致：一段中的多处都列出', async () => {
    const db = await work(novel);
    const r = value(await searchParagraphs(db, '当铺'));
    expect(r.mode).toBe('scan');
    expect(where(r)).toEqual([
      ['第一章 雨夜', 0, 2, '[当铺]的门半掩着。'],
      ['第二章 当铺', 1, 3, '“[当铺]不收这个。”掌柜说。'],
    ]);
    expect(value(await searchParagraphs(db, '雨')).hits).toHaveLength(1);
  });

  it('查询两端的空白去掉；空查询没有结果；引号、星号等按字面查找', async () => {
    const db = await work([{ title: '一', paragraphs: ['他说：“AND OR * NEAR"。'] }]);
    expect(value(await searchParagraphs(db, '  ')).hits).toEqual([]);
    expect(where(value(await searchParagraphs(db, ' OR * '))).map((w) => w[3])).toEqual(['他说：“AND [OR *] NEAR"。']);
    expect(value(await searchParagraphs(db, 'NEAR"')).hits).toHaveLength(1);
    expect(value(await searchParagraphs(db, '.*')).hits).toEqual([]);
  });

  it('拉丁字母不区分大小写', async () => {
    const db = await work([{ title: '一', paragraphs: ['Chapter One 与 chapter two'] }]);
    expect(value(await searchParagraphs(db, 'CHAPTER')).hits.map((h) => h.match)).toEqual(['Chapter', 'chapter']);
    expect(value(await searchParagraphs(db, 'On')).hits.map((h) => h.match)).toEqual(['On']);
  });

  it('不查回收站中的章节；保存后的修改立即可查', async () => {
    const db = await work(novel);
    const [first] = value(await listChapters(db, 'normal'));
    if (first === undefined) throw new Error('样本');
    const saved = value(await listParagraphs(db, first.id));
    value(
      await saveChapterParagraphs(
        db,
        first.id,
        saved,
        saved.map((p, i) => ({ id: p.id, text: i === 0 ? '雨停了，当铺的灯亮着。' : p.text, source: p.source })),
        { splits: [], merges: [] },
        ctx,
      ),
    );
    expect(value(await searchParagraphs(db, '当铺的')).hits.map((h) => h.before + h.match)).toEqual(['雨停了，当铺的', '当铺的']);
    expect(value(await searchParagraphs(db, '没有回头')).hits).toEqual([]);
    value(await trashChapter(db, first.id, first.version, ctx));
    expect(value(await searchParagraphs(db, '当铺')).hits.map((h) => h.chapterTitle)).toEqual(['第二章 当铺']);
  });

  it('超过上限时只返回前若干处并标明', async () => {
    const db = await work([{ title: '一', paragraphs: ['雨雨雨', '雨雨'] }]);
    const r = value(await searchParagraphs(db, '雨', 4));
    expect(r.hits).toHaveLength(4);
    expect(r.truncated).toBe(true);
    expect(value(await searchParagraphs(db, '雨', 5)).truncated).toBe(false);
  });

  it('任意文字与查询：索引与扫描找到的段落都与逐段查找一致', async () => {
    const alphabet = fc.constantFrom('雨', '夜', '当', '铺', '门', '，', 'a', 'A', ' ');
    const text = fc.array(alphabet, { maxLength: 12 }).map((cs) => cs.join(''));
    await fc.assert(
      fc.asyncProperty(fc.array(text, { minLength: 1, maxLength: 6 }), fc.array(alphabet, { minLength: 1, maxLength: 4 }), async (paragraphs, q) => {
        const query = q.join('').trim();
        if (query === '') return;
        const db = await work([{ title: '一', paragraphs }]);
        const stored = value(await listParagraphs(db, value(await listChapters(db, 'normal'))[0]?.id ?? ''));
        const expected = stored.filter((p) => p.text.toLowerCase().includes(query.toLowerCase())).map((p) => p.id);
        const found = [...new Set(value(await searchParagraphs(db, query)).hits.map((h) => h.paragraphId))];
        expect(found).toEqual(expected);
      }),
      { numRuns: 60 },
    );
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter, listChapters, moveChapter, restoreChapter, trashChapter } from './chapter';
import { listChapterPlans, saveChapterPlan } from './chapter-plan';
import { importChapters } from './import';
import { searchParagraphs } from './search';
import { createVolume, deleteVolume, listVolumes, moveVolume, updateVolume } from './volume';

const ctx = { now: '2026-10-14T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-volumes-'));
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

const titles = async (db: ProjectDb) => value(await listChapters(db, 'normal')).map((c) => c.title);
const version = async (db: ProjectDb, id: string) => value(await listChapters(db, 'normal')).find((c) => c.id === id)?.version ?? 0;

/** 楔子（未分卷）；第一卷：一、二；第二卷：三。 */
async function book(db: ProjectDb) {
  value(await createChapter(db, { id: 'c0', title: '楔子' }, ctx));
  const v1 = value(await createVolume(db, { id: 'v1', title: '第一卷' }, ctx));
  const v2 = value(await createVolume(db, { id: 'v2', title: '第二卷' }, ctx));
  value(await createChapter(db, { id: 'c1', title: '一', volumeId: 'v1' }, ctx));
  value(await createChapter(db, { id: 'c3', title: '三' }, ctx));
  value(await createChapter(db, { id: 'c2', title: '二', after: 'c1' }, ctx));
  return { v1, v2 };
}

describe('分卷（B68）', () => {
  it('书中顺序：未分卷的在前，再按卷的顺序、卷内顺序；不指定位置的新章节接在最后一卷末尾，指定前一章的跟在它后面', async () => {
    const db = fresh();
    await book(db);
    expect(await titles(db)).toEqual(['楔子', '一', '二', '三']);
    expect(value(await listChapters(db, 'normal')).map((c) => c.volumeId)).toEqual([null, 'v1', 'v1', 'v2']);
    expect(value(await listVolumes(db)).map((v) => v.title)).toEqual(['第一卷', '第二卷']);
  });

  it('调整卷的顺序时，卷里的章节跟着一起移动；改卷名与简介', async () => {
    const db = fresh();
    const { v2 } = await book(db);
    value(await moveVolume(db, 'v2', v2.version, null, ctx));
    expect(await titles(db)).toEqual(['楔子', '三', '一', '二']);
    expect(value(await updateVolume(db, 'v2', v2.version + 1, { title: ' 第零卷 ', summary: '前传' }, ctx))).toMatchObject({ title: '第零卷', summary: '前传' });
    expect(await updateVolume(db, 'v2', 1, { title: 'x', summary: '' }, ctx)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await updateVolume(db, 'v2', 3, { title: ' ', summary: '' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('章节可以移到别的卷（卷首或某章之后）、移出到未分卷；前一章须在目标卷里', async () => {
    const db = fresh();
    await book(db);
    value(await moveChapter(db, 'c3', await version(db, 'c3'), { volumeId: 'v1', after: 'c1' }, ctx));
    expect(await titles(db)).toEqual(['楔子', '一', '三', '二']);
    value(await moveChapter(db, 'c2', await version(db, 'c2'), { volumeId: 'v2', after: null }, ctx));
    expect(await titles(db)).toEqual(['楔子', '一', '三', '二']);
    expect(value(await listChapters(db, 'normal')).find((c) => c.id === 'c2')?.volumeId).toBe('v2');
    value(await moveChapter(db, 'c1', await version(db, 'c1'), { volumeId: null, after: 'c0' }, ctx));
    expect(await titles(db)).toEqual(['楔子', '一', '三', '二']);
    expect(value(await listChapters(db, 'normal')).find((c) => c.id === 'c1')?.volumeId).toBeNull();
    expect(await moveChapter(db, 'c0', await version(db, 'c0'), { volumeId: 'v1', after: 'c2' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await moveChapter(db, 'c0', await version(db, 'c0'), { volumeId: 'none', after: null }, ctx)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('卷里还有章节时不能删除；回收站里的章节随卷删除变为未分卷，恢复后接在未分卷末尾', async () => {
    const db = fresh();
    const { v2 } = await book(db);
    expect(await deleteVolume(db, 'v2', v2.version)).toEqual({ ok: false, error: { code: 'in_use' } });
    value(await trashChapter(db, 'c3', await version(db, 'c3'), ctx));
    expect(await deleteVolume(db, 'v2', 99)).toEqual({ ok: false, error: { code: 'conflict' } });
    value(await deleteVolume(db, 'v2', v2.version));
    const trashed = value(await listChapters(db, 'trashed'))[0]!;
    expect(trashed.volumeId).toBeNull();
    value(await restoreChapter(db, 'c3', trashed.version, ctx));
    expect(await titles(db)).toEqual(['楔子', '三', '一', '二']);
  });

  it('恢复的章节回到原来那一卷的末尾', async () => {
    const db = fresh();
    await book(db);
    value(await trashChapter(db, 'c1', await version(db, 'c1'), ctx));
    const trashed = value(await listChapters(db, 'trashed'))[0]!;
    value(await restoreChapter(db, 'c1', trashed.version, ctx));
    expect(await titles(db)).toEqual(['楔子', '二', '一', '三']);
  });

  it('导入带卷名的章节：已有的同名卷接在卷末，没有的在最后新建；不带卷名的接在全书末尾', async () => {
    const db = fresh();
    await book(db);
    value(
      await importChapters(
        db,
        [
          { title: '一续', paragraphs: ['甲'], volume: '第一卷' },
          { title: '四', paragraphs: ['乙'], volume: '第三卷' },
          { title: '五', paragraphs: ['丙'], volume: '第三卷' },
          { title: '尾声', paragraphs: ['丁'] },
        ],
        ctx,
        (() => {
          let n = 0;
          return () => `i${++n}`;
        })(),
      ),
    );
    expect(value(await listVolumes(db)).map((v) => v.title)).toEqual(['第一卷', '第二卷', '第三卷']);
    expect(await titles(db)).toEqual(['楔子', '一', '二', '一续', '三', '尾声', '四', '五']);
  });

  it('其他按书中顺序列出的地方同样以卷为先：查找结果与章节计划', async () => {
    const db = fresh();
    const { v2 } = await book(db);
    value(await moveVolume(db, 'v2', v2.version, null, ctx));
    for (const id of ['c1', 'c3']) value(await saveChapterPlan(db, id, null, { goal: id, castIds: [], beats: [], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: null }, ctx));
    expect(value(await listChapterPlans(db)).map((p) => p.chapterId)).toEqual(['c3', 'c1']);
    expect(value(await searchParagraphs(db, '无此')).hits).toEqual([]);
  });
});

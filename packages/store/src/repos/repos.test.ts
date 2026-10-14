import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportData, importData } from '../data-export';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter, listChapters, moveChapter, renameChapter, restoreChapter, trashChapter, updateChapterNotes, type Chapter } from './chapter';
import { createProject, getProject, updateProject } from './project';

const ctx = { now: '2026-10-07T00:00:00.000Z' };
const later = { now: '2026-10-07T01:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-repos-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function fresh(): ProjectDb {
  const result = openProjectDb(join(root, `p${n++}`), { migrations: loadMigrations(), now: ctx.now });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  opened.push(result.value.db);
  return result.value.db;
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function titles(db: ProjectDb, status: 'normal' | 'trashed' = 'normal') {
  return value(await listChapters(db, status)).map((c) => c.title);
}

describe('作品信息', () => {
  it('新建、读取与更新；默认写作目标', async () => {
    const db = fresh();
    expect(value(await getProject(db))).toBeNull();
    const created = value(await createProject(db, { id: '01P', title: '雨夜' }, ctx));
    expect(created).toMatchObject({ title: '雨夜', genre: '', goals: { totalWords: null, note: '' }, version: 1 });
    const updated = value(await updateProject(db, '01P', 1, { title: '  雨夜行 ', genre: '武侠', goals: { totalWords: 300_000, note: '年底完稿' } }, later));
    expect(updated).toMatchObject({ title: '雨夜行', genre: '武侠', goals: { totalWords: 300_000 }, version: 2, updatedAt: later.now });
    expect(value(await getProject(db))).toEqual(updated);
    // 规避词表：null 为默认词表；作者的词表去掉空白项，清空后为空数组（不检查）。
    expect(created.avoidPhrases).toBeNull();
    const avoid = value(await updateProject(db, '01P', 2, { avoidPhrases: [' 不禁 ', '', '仿佛'] }, later));
    expect(avoid.avoidPhrases).toEqual(['不禁', '仿佛']);
    expect(value(await updateProject(db, '01P', 3, { avoidPhrases: [] }, later)).avoidPhrases).toEqual([]);
    expect(value(await updateProject(db, '01P', 4, { avoidPhrases: null }, later)).avoidPhrases).toBeNull();
  });

  it('版本不符时返回冲突，标题不能为空', async () => {
    const db = fresh();
    value(await createProject(db, { id: '01P', title: '雨夜' }, ctx));
    expect(await updateProject(db, '01P', 9, { genre: '武侠' }, later)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(await updateProject(db, '01P', 1, { title: ' ' }, later)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await updateProject(db, 'nope', 1, { genre: '武侠' }, later)).toEqual({ ok: false, error: { code: 'not_found' } });
  });
});

describe('章节目录', () => {
  async function three(db: ProjectDb): Promise<Chapter[]> {
    for (const [id, title] of [
      ['c1', '第一章'],
      ['c2', '第二章'],
      ['c3', '第三章'],
    ] as const) {
      value(await createChapter(db, { id, title }, ctx));
    }
    return value(await listChapters(db, 'normal'));
  }

  it('新建时默认追加到末尾，也可插在某章之后', async () => {
    const db = fresh();
    await three(db);
    value(await createChapter(db, { id: 'c15', title: '插曲', after: 'c1' }, ctx));
    expect(await titles(db)).toEqual(['第一章', '插曲', '第二章', '第三章']);
    expect(await createChapter(db, { id: 'x', title: '  ' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await createChapter(db, { id: 'x', title: '孤章', after: 'missing' }, ctx)).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('重命名与梗概备注；版本不符时冲突', async () => {
    const db = fresh();
    const [c1] = await three(db);
    if (!c1) throw new Error();
    const renamed = value(await renameChapter(db, 'c1', c1.version, '序章', later));
    expect(renamed).toMatchObject({ title: '序章', version: 2 });
    expect(await renameChapter(db, 'c1', c1.version, '又改', later)).toEqual({ ok: false, error: { code: 'conflict' } });
    const noted = value(await updateChapterNotes(db, 'c1', 2, { summary: '两人重逢', notes: '节奏放慢' }, later));
    expect(noted).toMatchObject({ summary: '两人重逢', notes: '节奏放慢', version: 3 });
  });

  it('排序：移到最前、移到某章之后、移到末尾，其余章节不动', async () => {
    const db = fresh();
    const before = await three(db);
    const v = (id: string) => before.find((c) => c.id === id)?.version ?? 0;
    value(await moveChapter(db, 'c3', v('c3'), { volumeId: null, after: null }, later));
    expect(await titles(db)).toEqual(['第三章', '第一章', '第二章']);
    value(await moveChapter(db, 'c1', v('c1'), { volumeId: null, after: 'c2' }, later));
    expect(await titles(db)).toEqual(['第三章', '第二章', '第一章']);
    const after = value(await listChapters(db, 'normal'));
    // 只改了被移动的章节。
    expect(after.find((c) => c.id === 'c2')?.version).toBe(1);
    expect(await moveChapter(db, 'c2', 1, { volumeId: null, after: 'c2' }, later)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('移到原来的位置时顺序不变', async () => {
    const db = fresh();
    const before = await three(db);
    value(await moveChapter(db, 'c2', before[1]?.version ?? 0, { volumeId: null, after: 'c1' }, later));
    expect(await titles(db)).toEqual(['第一章', '第二章', '第三章']);
  });

  it('回收站：移入后不在目录中，恢复后放到末尾', async () => {
    const db = fresh();
    await three(db);
    value(await trashChapter(db, 'c1', 1, later));
    expect(await titles(db)).toEqual(['第二章', '第三章']);
    expect(await titles(db, 'trashed')).toEqual(['第一章']);
    // 已在回收站的章节不能再移入。
    expect(await trashChapter(db, 'c1', 2, later)).toEqual({ ok: false, error: { code: 'conflict' } });
    const restored = value(await restoreChapter(db, 'c1', 2, later));
    expect(restored).toMatchObject({ status: 'normal', trashedAt: null });
    expect(await titles(db)).toEqual(['第二章', '第三章', '第一章']);
    expect(await titles(db, 'trashed')).toEqual([]);
  });

  it('大量追加与插入后导出导入，顺序一致', async () => {
    const db = fresh();
    value(await createProject(db, { id: '01P', title: '长篇' }, ctx));
    for (let i = 0; i < 120; i++) value(await createChapter(db, { id: `a${String(i).padStart(3, '0')}`, title: `第${i + 1}章` }, ctx));
    for (let i = 0; i < 30; i++) value(await createChapter(db, { id: `b${String(i).padStart(3, '0')}`, title: `插入${i}`, after: 'a000' }, ctx));
    const order = await titles(db);
    const data = value(await exportData(db));
    const copy = fresh();
    value(await importData(copy, data));
    expect(await titles(copy)).toEqual(order);
    expect(order[1]).toBe('插入29');
  });
});

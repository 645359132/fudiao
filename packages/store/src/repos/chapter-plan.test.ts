import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter } from './chapter';
import { getChapterPlan, listChapterPlans, saveChapterPlan } from './chapter-plan';

const ctx = { now: '2026-10-28T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-chapter-plan-'));
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

const fields = { goal: '林舟当玉', castIds: [], beats: ['叩门', '压价'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 };

describe('章节计划的节奏目标（B87，迁移 0025）', () => {
  it('保存、读回与清空；没填的为 null', async () => {
    const db = fresh();
    const chapter = value(await createChapter(db, { id: 'c1', title: '雪夜' }, ctx));
    const saved = value(await saveChapterPlan(db, chapter.id, null, fields, ctx));
    expect(saved.rhythm).toBeNull();
    const rhythm = { type: 'confrontation', dialogue: 'high', ending: 'dialogue' } as const;
    const withRhythm = value(await saveChapterPlan(db, chapter.id, saved, { ...fields, rhythm }, ctx));
    expect(withRhythm.rhythm).toEqual(rhythm);
    expect(value(await getChapterPlan(db, chapter.id))?.rhythm).toEqual(rhythm);
    expect(value(await listChapterPlans(db)).map((p) => p.rhythm)).toEqual([rhythm]);
    const cleared = value(await saveChapterPlan(db, chapter.id, withRhythm, { ...fields, rhythm: null }, ctx));
    expect(cleared.rhythm).toBeNull();
  });

  it('取值不认得的节奏整份当作没有', async () => {
    const db = fresh();
    const chapter = value(await createChapter(db, { id: 'c1', title: '雪夜' }, ctx));
    value(await saveChapterPlan(db, chapter.id, null, fields, ctx));
    value(await db.transaction([{ sql: `UPDATE chapter_plan SET rhythm = '{"type":"opera","dialogue":"mid","ending":"quiet"}' WHERE chapter_id = 'c1'`, params: [] }]));
    expect(value(await getChapterPlan(db, chapter.id))?.rhythm).toBeNull();
  });
});

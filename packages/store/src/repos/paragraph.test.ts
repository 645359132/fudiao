import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter } from './chapter';
import { listParagraphs, saveChapterParagraphs } from './paragraph';
import type { CurrentParagraph, SavedParagraph, StructuralEdits } from './paragraph-plan';

const ctx = { now: '2026-10-08T00:00:00.000Z' };
const NONE: StructuralEdits = { splits: [], merges: [] };
const root = mkdtempSync(join(tmpdir(), 'fudiao-paragraphs-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function fresh(): Promise<ProjectDb> {
  const result = openProjectDb(join(root, `p${n++}`), { migrations: loadMigrations(), now: ctx.now });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  opened.push(result.value.db);
  const chapter = await createChapter(result.value.db, { id: 'c1', title: '第一章' }, ctx);
  if (!chapter.ok) throw new Error('无法建章');
  return result.value.db;
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const cur = (id: string, text: string): CurrentParagraph => ({ id, text, source: 'handwritten' });
const texts = (ps: readonly SavedParagraph[]) => ps.map((p) => p.text);

async function links(db: ProjectDb) {
  const rows = await db.query('SELECT event_id, paragraph_id FROM event_paragraph_link ORDER BY event_id, paragraph_id');
  return rows.ok ? rows.value.map((r) => `${String(r['event_id'])}:${String(r['paragraph_id'])}`) : [];
}

describe('段落保存', () => {
  it('首次保存、修改、移动与删除；只改文本时版本加一', async () => {
    const db = await fresh();
    let saved = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '雨下得更紧了。'), cur('b', '他没有回头。')], NONE, ctx));
    expect(texts(saved)).toEqual(['雨下得更紧了。', '他没有回头。']);
    saved = value(await saveChapterParagraphs(db, 'c1', saved, [cur('b', '他始终没有回头。'), cur('a', '雨下得更紧了。'), cur('c', '巷子尽头有灯。')], NONE, ctx));
    expect(texts(saved)).toEqual(['他始终没有回头。', '雨下得更紧了。', '巷子尽头有灯。']);
    expect(saved.find((p) => p.id === 'b')?.version).toBe(2);
    expect(saved.find((p) => p.id === 'a')?.version).toBe(1);
    saved = value(await saveChapterParagraphs(db, 'c1', saved, [cur('c', '巷子尽头有灯。')], NONE, ctx));
    expect(texts(saved)).toEqual(['巷子尽头有灯。']);
    expect(value(await listParagraphs(db, 'c1'))).toEqual(saved);
  });

  it('用过期的版本保存时整体回滚，返回冲突', async () => {
    const db = await fresh();
    const first = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '甲')], NONE, ctx));
    value(await saveChapterParagraphs(db, 'c1', first, [cur('a', '甲改')], NONE, ctx));
    expect(await saveChapterParagraphs(db, 'c1', first, [cur('a', '甲又改'), cur('b', '乙')], NONE, ctx)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(texts(value(await listParagraphs(db, 'c1')))).toEqual(['甲改']);
  });

  it('拆分后两段都保留事件关联，合并后取并集', async () => {
    const db = await fresh();
    let saved = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '甲乙'), cur('b', '丙')], NONE, ctx));
    value(
      await db.transaction([
        { sql: "INSERT INTO story_event (id, summary, created_at, updated_at) VALUES ('e1', '对峙', ?, ?), ('e2', '离去', ?, ?)", params: [ctx.now, ctx.now, ctx.now, ctx.now] },
        { sql: "INSERT INTO event_paragraph_link VALUES ('e1', 'a', 'direct', ?), ('e2', 'b', 'implied', ?)", params: [ctx.now, ctx.now] },
      ]),
    );
    saved = value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '甲'), cur('n', '乙'), cur('b', '丙')], { splits: [{ id: 'n', from: 'a' }], merges: [] }, ctx));
    expect(await links(db)).toEqual(['e1:a', 'e1:n', 'e2:b']);
    const split = await db.query("SELECT split_from FROM paragraph WHERE id = 'n'");
    expect(split.ok && split.value[0]?.['split_from']).toBe('a');

    value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '甲'), cur('n', '乙丙')], { splits: [], merges: [{ removed: 'b', into: 'n' }] }, ctx));
    expect(await links(db)).toEqual(['e1:a', 'e1:n', 'e2:n']);
  });

  it('删除段落时其事件关联随之删除', async () => {
    const db = await fresh();
    const saved = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '甲'), cur('b', '乙')], NONE, ctx));
    value(
      await db.transaction([
        { sql: "INSERT INTO story_event (id, summary, created_at, updated_at) VALUES ('e1', '对峙', ?, ?)", params: [ctx.now, ctx.now] },
        { sql: "INSERT INTO event_paragraph_link VALUES ('e1', 'b', 'direct', ?)", params: [ctx.now] },
      ]),
    );
    value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '甲')], NONE, ctx));
    expect(await links(db)).toEqual([]);
  });

  it('任意的重排与增删，连续保存后库中顺序与编辑器一致（章内排序键不冲突）', async () => {
    const db = await fresh();
    let saved: SavedParagraph[] = [];
    let next = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.nat(), fc.nat(), fc.boolean()), { maxLength: 10 }), async (moves) => {
        const doc = saved.map((p) => cur(p.id, p.text));
        for (const [from, to, add] of moves) {
          if (add || doc.length === 0) doc.splice(to % (doc.length + 1), 0, cur(`x${next++}`, `段${next}`));
          else {
            const [m] = doc.splice(from % doc.length, 1);
            if (m && from % 3 !== 0) doc.splice(to % (doc.length + 1), 0, m);
          }
        }
        saved = value(await saveChapterParagraphs(db, 'c1', saved, doc, NONE, ctx));
        return JSON.stringify(saved.map((p) => p.id)) === JSON.stringify(doc.map((p) => p.id));
      }),
      { numRuns: 60 },
    );
  });
});

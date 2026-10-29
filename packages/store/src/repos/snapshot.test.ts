import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportData, importData } from '../data-export';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter } from './chapter';
import { listParagraphs, saveChapterParagraphs } from './paragraph';
import type { Query, SqlValue, Statement } from '../sql';
import type { CurrentParagraph, SavedParagraph } from './paragraph-plan';
import { createSnapshot, getSnapshot, listSnapshots, restoreSnapshot } from './snapshot';

const t0 = { now: '2026-10-08T00:00:00.000Z' };
const t1 = { now: '2026-10-08T01:00:00.000Z' };
const t2 = { now: '2026-10-08T02:00:00.000Z' };
const NONE = { splits: [], merges: [] };
const root = mkdtempSync(join(tmpdir(), 'fudiao-snapshots-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function fresh(): Promise<ProjectDb> {
  const result = openProjectDb(join(root, `p${n++}`), { migrations: loadMigrations(), now: t0.now });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  opened.push(result.value.db);
  value(await createChapter(result.value.db, { id: 'c1', title: '第一章' }, t0));
  return result.value.db;
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const cur = (id: string, text: string): CurrentParagraph => ({ id, text, source: 'handwritten' });
const texts = (ps: readonly SavedParagraph[]) => ps.map((p) => p.text);

async function links(db: ProjectDb) {
  const rows = await db.query('SELECT event_id, paragraph_id, mode FROM event_paragraph_link ORDER BY event_id, paragraph_id');
  return rows.ok ? rows.value.map((r) => `${String(r['event_id'])}:${String(r['paragraph_id'])}:${String(r['mode'])}`) : [];
}

async function event(db: ProjectDb, id: string) {
  value(await db.transaction([{ sql: 'INSERT INTO story_event (id, summary, created_at, updated_at) VALUES (?, ?, ?, ?)', params: [id, id, t0.now, t0.now] }]));
}

async function link(db: ProjectDb, eventId: string, paragraphId: string, mode = 'direct') {
  value(await db.transaction([{ sql: 'INSERT INTO event_paragraph_link VALUES (?, ?, ?, ?)', params: [eventId, paragraphId, mode, t0.now] }]));
}

describe('章节快照', () => {
  it('建立快照：保存当时的段落、来源与关联；列表最近的在前', async () => {
    const db = await fresh();
    value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '雨下得更紧了。'), { id: 'b', text: '他没有回头。', source: 'ai_modified' }], NONE, t0));
    await event(db, 'e1');
    await link(db, 'e1', 'a', 'flashback');
    const first = value(await createSnapshot(db, { id: 's1', chapterId: 'c1', reason: 'manual' }, t1));
    expect(first).toEqual({ id: 's1', chapterId: 'c1', reason: 'manual', title: '第一章', createdAt: t1.now, paragraphCount: 2 });
    value(await createSnapshot(db, { id: 's2', chapterId: 'c1', reason: 'manual' }, t2));
    expect(value(await listSnapshots(db, 'c1')).map((s) => s.id)).toEqual(['s2', 's1']);
    const full = value(await getSnapshot(db, 's1'));
    expect(full.paragraphs).toEqual([
      { id: 'a', text: '雨下得更紧了。', source: 'handwritten', sourceSpans: [], aiOriginText: null, version: 1, links: [{ eventId: 'e1', mode: 'flashback' }] },
      { id: 'b', text: '他没有回头。', source: 'ai_modified', sourceSpans: [{ start: 0, end: 6 }], aiOriginText: null, version: 1, links: [] },
    ]);
  });

  it('不存在的章节或快照', async () => {
    const db = await fresh();
    expect(await createSnapshot(db, { id: 's', chapterId: 'nope', reason: 'manual' }, t1)).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await getSnapshot(db, 'nope')).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('恢复：沿用原标识，删除快照之后新增的段落，找回快照之后删除的段落，顺序与快照一致', async () => {
    const db = await fresh();
    const saved = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '甲'), cur('b', '乙'), cur('c', '丙')], NONE, t0));
    value(await createSnapshot(db, { id: 's1', chapterId: 'c1', reason: 'manual' }, t1));
    value(await saveChapterParagraphs(db, 'c1', saved, [cur('c', '丙改'), cur('a', '甲'), cur('d', '新增')], NONE, t1));
    const result = value(await restoreSnapshot(db, { snapshotId: 's1', backupId: 'r1' }, t2));
    expect(result.paragraphs.map((p) => [p.id, p.text])).toEqual([
      ['a', '甲'],
      ['b', '乙'],
      ['c', '丙'],
    ]);
    // 文字变回去的段落版本加一，未变的不加。
    expect(result.paragraphs.find((p) => p.id === 'c')?.version).toBe(3);
    expect(result.paragraphs.find((p) => p.id === 'a')?.version).toBe(1);
    expect(value(await listParagraphs(db, 'c1'))).toEqual(result.paragraphs);
  });

  it('找回已删除的段落时版本不倒退：删除前改过的，版本比删除时大；快照之后没改过就删的，沿用快照时的版本', async () => {
    const db = await fresh();
    let saved = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '甲'), cur('b', '乙')], NONE, t0));
    saved = value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '甲'), cur('b', '乙二')], NONE, t0));
    value(await createSnapshot(db, { id: 's1', chapterId: 'c1', reason: 'manual' }, t1));
    // b 在快照之后又改了一次（版本 3），然后删掉；a 没改过就删掉。
    saved = value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '甲'), cur('b', '乙三')], NONE, t1));
    expect(saved.find((p) => p.id === 'b')?.version).toBe(3);
    value(await saveChapterParagraphs(db, 'c1', saved, [cur('c', '丙')], NONE, t1));
    const restored = value(await restoreSnapshot(db, { snapshotId: 's1', backupId: 'r1' }, t2));
    expect(restored.paragraphs.map((p) => [p.id, p.text, p.version])).toEqual([
      ['a', '甲', 1],
      ['b', '乙二', 4],
    ]);
  });

  it('编辑器撤销找回已删除的段落标识时，版本同样接着删除时的版本往上加', async () => {
    const db = await fresh();
    let saved = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '甲')], NONE, t0));
    saved = value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '甲二')], NONE, t0));
    saved = value(await saveChapterParagraphs(db, 'c1', saved, [cur('b', '乙')], NONE, t1));
    saved = value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '甲'), cur('b', '乙')], NONE, t1));
    expect(saved.find((p) => p.id === 'a')?.version).toBe(3);
  });

  it('恢复期间正文被改动（另一处保存、写手追加）：不恢复，返回冲突', async () => {
    const db = await fresh();
    const saved = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '甲'), cur('b', '乙')], NONE, t0));
    value(await createSnapshot(db, { id: 's1', chapterId: 'c1', reason: 'manual' }, t1));
    value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '甲改'), cur('b', '乙')], NONE, t1));
    const racing = (statement: string) => ({
      query: (sql: string, params?: readonly SqlValue[]) => db.query(sql, params),
      read: (queries: readonly Query[]) => db.read(queries),
      transaction: async (statements: readonly Statement[]) => {
        value(await db.transaction([{ sql: statement }]));
        return db.transaction(statements);
      },
    });
    const now = async () => value(await listParagraphs(db, 'c1')).map((p) => p.text);
    const before = await now();
    expect(await restoreSnapshot(racing("UPDATE paragraph SET text = '又改', version = version + 1 WHERE id = 'b'"), { snapshotId: 's1', backupId: 'r1' }, t2)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(await now()).toEqual(['甲改', '又改']);
    expect(before).toEqual(['甲改', '乙']);
    expect(
      await restoreSnapshot(
        racing("INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES ('z', 'c1', 'zz', '追加', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')"),
        { snapshotId: 's1', backupId: 'r2' },
        t2,
      ),
    ).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(value(await listSnapshots(db, 'c1')).map((s) => s.id)).toEqual(['s1']);
  });

  it('恢复前自动把现稿存为快照，可以再次回退', async () => {
    const db = await fresh();
    const saved = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '初稿')], NONE, t0));
    value(await createSnapshot(db, { id: 's1', chapterId: 'c1', reason: 'manual' }, t1));
    value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '二稿'), cur('b', '二稿新段')], NONE, t1));
    const restored = value(await restoreSnapshot(db, { snapshotId: 's1', backupId: 'r1' }, t2));
    expect(restored.backup).toMatchObject({ id: 'r1', reason: 'before_restore', paragraphCount: 2 });
    expect(texts(restored.paragraphs)).toEqual(['初稿']);
    const back = value(await restoreSnapshot(db, { snapshotId: 'r1', backupId: 'r2' }, t2));
    expect(texts(back.paragraphs)).toEqual(['二稿', '二稿新段']);
    expect(value(await listSnapshots(db, 'c1')).map((s) => s.reason).sort()).toEqual(['before_restore', 'before_restore', 'manual']);
  });

  it('事件关联：快照中的关联恢复（事件仍存在时），现存段落之后加的关联保留', async () => {
    const db = await fresh();
    const saved = value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '甲'), cur('b', '乙')], NONE, t0));
    await event(db, 'e1');
    await event(db, 'e2');
    await event(db, 'gone');
    await link(db, 'e1', 'b');
    await link(db, 'gone', 'a');
    value(await createSnapshot(db, { id: 's1', chapterId: 'c1', reason: 'manual' }, t1));
    // 删掉段落 b（关联随之删除），事件 gone 也被删除，段落 a 新增关联 e2。
    value(await saveChapterParagraphs(db, 'c1', saved, [cur('a', '甲')], NONE, t1));
    value(await db.transaction([{ sql: "DELETE FROM story_event WHERE id = 'gone'" }]));
    await link(db, 'e2', 'a', 'implied');
    expect(await links(db)).toEqual(['e2:a:implied']);
    value(await restoreSnapshot(db, { snapshotId: 's1', backupId: 'r1' }, t2));
    expect(await links(db)).toEqual(['e1:b:direct', 'e2:a:implied']);
  });

  it('来源标记随快照恢复', async () => {
    const db = await fresh();
    const saved = value(await saveChapterParagraphs(db, 'c1', [], [{ id: 'a', text: '生成的句子。', source: 'ai_generated' }], NONE, t0));
    value(await db.transaction([{ sql: "UPDATE paragraph SET ai_origin_text = '生成的句子。', source_spans = '[{\"start\":0,\"end\":6}]' WHERE id = 'a'" }]));
    value(await createSnapshot(db, { id: 's1', chapterId: 'c1', reason: 'manual' }, t1));
    value(await saveChapterParagraphs(db, 'c1', saved, [{ id: 'a', text: '改过的句子。', source: 'ai_modified' }], NONE, t1));
    value(await db.transaction([{ sql: "UPDATE paragraph SET ai_origin_text = NULL, source_spans = '[]' WHERE id = 'a'" }]));
    value(await restoreSnapshot(db, { snapshotId: 's1', backupId: 'r1' }, t2));
    const row = await db.query("SELECT text, source_kind, ai_origin_text, source_spans FROM paragraph WHERE id = 'a'");
    expect(row).toEqual({ ok: true, value: [{ text: '生成的句子。', source_kind: 'ai_generated', ai_origin_text: '生成的句子。', source_spans: '[{"start":0,"end":6}]' }] });
  });

  it('快照与恢复后导出导入，正文与快照一致', async () => {
    const db = await fresh();
    value(await saveChapterParagraphs(db, 'c1', [], [cur('a', '甲'), cur('b', '乙')], NONE, t0));
    value(await createSnapshot(db, { id: 's1', chapterId: 'c1', reason: 'manual' }, t1));
    value(await restoreSnapshot(db, { snapshotId: 's1', backupId: 'r1' }, t2));
    const copy = await fresh();
    value(await copy.transaction([{ sql: "DELETE FROM chapter WHERE id = 'c1'" }]));
    value(await importData(copy, value(await exportData(db))));
    expect(value(await exportData(copy))).toEqual(value(await exportData(db)));
    expect(texts(value(await listParagraphs(copy, 'c1')))).toEqual(['甲', '乙']);
  });
});

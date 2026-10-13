import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter } from './chapter';
import { getChapterPlan, saveChapterPlan, type ChapterPlan, type WriterProgress } from './chapter-plan';
import { listParagraphs } from './paragraph';
import { appendWrittenSegment, resetWriterRun, startWriterRun } from './writer-segment';

const ctx = { now: '2026-10-13T00:00:00.000Z' };
const later = { now: '2026-10-13T01:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-writer-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

let ids = 0;
const newId = () => `n${String(ids++).padStart(5, '0')}`;

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const progress: WriterProgress = { runId: 'run1', segments: [['叩门', '压价'], ['起疑']], words: [1500, 1500], done: 0, snapshotId: 's1' };

/** 一章，可带作者已写的段落；章节计划已建。 */
async function fresh(authorText: string[] = []): Promise<{ db: ProjectDb; plan: ChapterPlan }> {
  const r = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: ctx.now });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  opened.push(r.value.db);
  const db = r.value.db;
  value(await createChapter(db, { id: 'c1', title: '第一章' }, ctx));
  for (const [i, text] of authorText.entries()) {
    value(await db.transaction([{ sql: 'INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', params: [`a${i}`, 'c1', `a${i}`, text, ctx.now, ctx.now] }]));
  }
  const plan = value(
    await saveChapterPlan(db, 'c1', null, { goal: '当玉', castIds: [], beats: ['叩门', '压价', '起疑'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }, ctx),
  );
  return { db, plan };
}

describe('写手写入一段', () => {
  it('开始写作：记下分段与快照，状态为写作中', async () => {
    const { db, plan } = await fresh();
    const started = value(await startWriterRun(db, plan, progress, ctx));
    expect(started).toMatchObject({ status: 'writing', progress, version: 2 });
  });

  it('段落接在章末，记为 AI 生成并以自身为生成原文；进度与段落一同更新，写完最后一段后状态为已写', async () => {
    const { db, plan } = await fresh(['作者写的开头。']);
    const started = value(await startWriterRun(db, plan, progress, ctx));
    const first = value(await appendWrittenSegment(db, { plan: started, paragraphs: value(await listParagraphs(db, 'c1')), texts: ['林舟叩门。', '钱四压价。'], newId }, later));
    expect(first.plan).toMatchObject({ status: 'writing', progress: { done: 1 } });
    expect(first.paragraphs.map((p) => [p.text, p.source, p.aiOriginText, p.spans])).toEqual([
      ['作者写的开头。', 'handwritten', null, []],
      ['林舟叩门。', 'ai_generated', '林舟叩门。', [{ start: 0, end: 5 }]],
      ['钱四压价。', 'ai_generated', '钱四压价。', [{ start: 0, end: 5 }]],
    ]);
    const second = value(await appendWrittenSegment(db, { plan: first.plan, paragraphs: first.paragraphs, texts: ['钱四起疑。'], newId }, later));
    expect(second.plan).toMatchObject({ status: 'written', progress: { done: 2 } });
    expect(second.paragraphs.map((p) => p.text)).toEqual(['作者写的开头。', '林舟叩门。', '钱四压价。', '钱四起疑。']);
  });

  it('空章节也能写入', async () => {
    const { db, plan } = await fresh();
    const started = value(await startWriterRun(db, plan, progress, ctx));
    const done = value(await appendWrittenSegment(db, { plan: started, paragraphs: [], texts: ['林舟叩门。'], newId }, later));
    expect(done.paragraphs.map((p) => p.text)).toEqual(['林舟叩门。']);
  });

  it('写手读取之后这一章被改过（段落改动、增加或删除）：整体回滚，返回冲突', async () => {
    const { db, plan } = await fresh(['作者写的开头。']);
    const started = value(await startWriterRun(db, plan, progress, ctx));
    const read = value(await listParagraphs(db, 'c1'));
    value(await db.transaction([{ sql: "UPDATE paragraph SET text = '作者改过的开头。', version = version + 1 WHERE id = 'a0'", params: [] }]));
    expect(await appendWrittenSegment(db, { plan: started, paragraphs: read, texts: ['林舟叩门。'], newId }, later)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(value(await listParagraphs(db, 'c1')).map((p) => p.text)).toEqual(['作者改过的开头。']);
    expect(value(await getChapterPlan(db, 'c1'))).toMatchObject({ progress: { done: 0 }, version: started.version });

    const reread = value(await listParagraphs(db, 'c1'));
    value(await db.transaction([{ sql: "INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES ('a9', 'c1', 'a9', '作者又加了一段。', ?, ?)", params: [ctx.now, ctx.now] }]));
    expect(await appendWrittenSegment(db, { plan: started, paragraphs: reread, texts: ['林舟叩门。'], newId }, later)).toEqual({ ok: false, error: { code: 'conflict' } });
  });

  it('计划在别处改过（版本不符）时返回冲突，不写入段落', async () => {
    const { db, plan } = await fresh();
    const started = value(await startWriterRun(db, plan, progress, ctx));
    const stale = { ...started, version: started.version - 1 };
    expect(await appendWrittenSegment(db, { plan: stale, paragraphs: [], texts: ['林舟叩门。'], newId }, later)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(value(await listParagraphs(db, 'c1'))).toEqual([]);
    // 没有进行中的写作时拒绝写入。
    expect(await appendWrittenSegment(db, { plan, paragraphs: [], texts: ['林舟叩门。'], newId }, later)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('回退后清除进度，状态回到待写', async () => {
    const { db, plan } = await fresh();
    const started = value(await startWriterRun(db, plan, progress, ctx));
    expect(value(await resetWriterRun(db, started, later))).toMatchObject({ status: 'todo', progress: null });
  });
});

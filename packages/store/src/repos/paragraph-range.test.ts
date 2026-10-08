import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createCandidate, getCandidate, listCandidates, setCandidateStatus, updateCandidateContent } from './candidate';
import { createChapter } from './chapter';
import { listParagraphs, saveChapterParagraphs } from './paragraph';
import type { SavedParagraph } from './paragraph-plan';
import { applyRangeReplace, planRangeReplace, textInRange, type RangeInsert } from './paragraph-range';

const ctx = { now: '2026-10-08T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-range-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

async function chapterWith(texts: string[]): Promise<{ db: ProjectDb; saved: SavedParagraph[] }> {
  const result = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: ctx.now });
  if (!result.ok) throw new Error('open');
  const db = result.value.db;
  opened.push(db);
  value(await createChapter(db, { id: 'c1', title: '第一章' }, ctx));
  const saved = value(await saveChapterParagraphs(db, 'c1', [], texts.map((text, i) => ({ id: `p${i}`, text, source: 'handwritten' as const })), { splits: [], merges: [] }, ctx));
  return { db, saved };
}

const ai = (text: string, unedited = true): RangeInsert => ({ text, ai: text === '' ? [] : [{ start: 0, end: text.length }], unedited });
let n = 0;
const newId = () => `n${++n}`;

describe('按范围替换正文', () => {
  it('段内替换：前后文字保留为作者所写，插入的部分为 AI，段落为混合', async () => {
    const { db, saved } = await chapterWith(['雨下得更紧了。', '他推开门。']);
    const range = { from: { paragraphId: 'p1', offset: 1 }, to: { paragraphId: 'p1', offset: 3 } };
    expect(textInRange(saved, range)).toBe('推开');
    const plan = planRangeReplace(saved, range, ai('轻轻推开了'), newId);
    value(await applyRangeReplace(db, 'c1', value(plan), ctx));
    const after = value(await listParagraphs(db, 'c1'));
    expect(after[1]).toMatchObject({ id: 'p1', text: '他轻轻推开了门。', source: 'mixed', spans: [{ start: 1, end: 6 }], aiOriginText: null, version: 2 });
    expect(after[0]?.version).toBe(1);
  });

  it('整段替换且未经修改：AI 生成，保存生成原文；修改过的候选稿只有区间', async () => {
    const { db, saved } = await chapterWith(['他推开门。']);
    const whole = { from: { paragraphId: 'p0', offset: 0 }, to: { paragraphId: 'p0', offset: 5 } };
    value(await applyRangeReplace(db, 'c1', value(planRangeReplace(saved, whole, ai('他轻轻推开了门。'), newId)), ctx));
    expect(value(await listParagraphs(db, 'c1'))[0]).toMatchObject({ source: 'ai_generated', aiOriginText: '他轻轻推开了门。' });

    const again = value(await listParagraphs(db, 'c1'));
    const edited: RangeInsert = { text: '他推开门。', ai: [{ start: 0, end: 5 }], unedited: false };
    value(await applyRangeReplace(db, 'c1', value(planRangeReplace(again, { from: { paragraphId: 'p0', offset: 0 }, to: { paragraphId: 'p0', offset: 8 } }, edited, newId)), ctx));
    expect(value(await listParagraphs(db, 'c1'))[0]).toMatchObject({ source: 'ai_modified', aiOriginText: null });
  });

  it('多行的新文字：首段保留标识，其余成为新段落（排在原位置），复制事件关联', async () => {
    const { db, saved } = await chapterWith(['雨下得更紧了。', '他推开门。', '柜台后没有人。']);
    value(await db.transaction([
      { sql: "INSERT INTO story_event (id, summary, created_at, updated_at) VALUES ('e1', '推门', ?, ?)", params: [ctx.now, ctx.now] },
      { sql: "INSERT INTO event_paragraph_link VALUES ('e1', 'p1', 'direct', ?)", params: [ctx.now] },
    ]));
    // 在第二段末尾续写两段。
    const end = { paragraphId: 'p1', offset: 5 };
    value(await applyRangeReplace(db, 'c1', value(planRangeReplace(saved, { from: end, to: end }, ai('\n屋里很暗。\n他点亮了灯。'), newId)), ctx));
    const after = value(await listParagraphs(db, 'c1'));
    expect(after.map((p) => [p.text, p.source])).toEqual([
      ['雨下得更紧了。', 'handwritten'],
      ['他推开门。', 'handwritten'],
      ['屋里很暗。', 'ai_generated'],
      ['他点亮了灯。', 'ai_generated'],
      ['柜台后没有人。', 'handwritten'],
    ]);
    const links = await db.query('SELECT paragraph_id FROM event_paragraph_link ORDER BY paragraph_id');
    expect(links.ok && links.value.length).toBe(3);
  });

  it('跨段替换：中间的段落并入首段，事件关联取并集', async () => {
    const { db, saved } = await chapterWith(['雨下得更紧了。', '他推开门。', '柜台后没有人。']);
    value(await db.transaction([
      { sql: "INSERT INTO story_event (id, summary, created_at, updated_at) VALUES ('e2', '无人', ?, ?)", params: [ctx.now, ctx.now] },
      { sql: "INSERT INTO event_paragraph_link VALUES ('e2', 'p2', 'direct', ?)", params: [ctx.now] },
    ]));
    const range = { from: { paragraphId: 'p0', offset: 6 }, to: { paragraphId: 'p2', offset: 3 } };
    expect(textInRange(saved, range)).toBe('。\n他推开门。\n柜台后');
    value(await applyRangeReplace(db, 'c1', value(planRangeReplace(saved, range, ai('，他推门进去，柜台后'), newId)), ctx));
    const after = value(await listParagraphs(db, 'c1'));
    expect(after.map((p) => [p.id, p.text])).toEqual([['p0', '雨下得更紧了，他推门进去，柜台后没有人。']]);
    const links = await db.query("SELECT paragraph_id FROM event_paragraph_link WHERE event_id = 'e2'");
    expect(links.ok && links.value).toEqual([{ paragraph_id: 'p0' }]);
  });

  it('生成之后段落被改过：版本守卫让整个替换回滚', async () => {
    const { db, saved } = await chapterWith(['他推开门。']);
    value(await saveChapterParagraphs(db, 'c1', saved, [{ id: 'p0', text: '他关上门。', source: 'handwritten' }], { splits: [], merges: [] }, ctx));
    const plan = value(planRangeReplace(saved, { from: { paragraphId: 'p0', offset: 0 }, to: { paragraphId: 'p0', offset: 2 } }, ai('她'), newId));
    expect(await applyRangeReplace(db, 'c1', plan, ctx)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(value(await listParagraphs(db, 'c1'))[0]?.text).toBe('他关上门。');
    expect(planRangeReplace(saved, { from: { paragraphId: 'gone', offset: 0 }, to: { paragraphId: 'p0', offset: 0 } }, ai('x'), newId)).toEqual({ ok: false, error: '原文位置无效' });
  });
});

describe('候选稿', () => {
  it('新建为待处理；作者修改内容；接受或放弃后不能再改', async () => {
    const { db } = await chapterWith(['他推开门。']);
    const target = { from: { paragraphId: 'p0', offset: 1 }, to: { paragraphId: 'p0', offset: 3 } };
    let c = value(await createCandidate(db, { id: 'k1', chapterId: 'c1', operation: 'rewrite', target, baseText: '推开', baseVersions: { p0: 1 }, generated: '轻推', llmCallId: null }, ctx));
    expect(c).toMatchObject({ status: 'pending', content: '轻推', generated: '轻推', target, baseVersions: { p0: 1 } });
    c = value(await updateCandidateContent(db, c, '轻轻推开', ctx));
    expect(c).toMatchObject({ content: '轻轻推开', generated: '轻推', version: 2 });
    expect(value(await listCandidates(db, 'c1')).map((x) => x.id)).toEqual(['k1']);
    c = value(await setCandidateStatus(db, c, 'accepted', null, ctx));
    expect(value(await listCandidates(db, 'c1'))).toEqual([]);
    expect(value(await listCandidates(db, 'c1', ['accepted'])).map((x) => x.id)).toEqual(['k1']);
    expect(await updateCandidateContent(db, c, '再改', ctx)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(value(await getCandidate(db, 'k1')).status).toBe('accepted');
  });
});

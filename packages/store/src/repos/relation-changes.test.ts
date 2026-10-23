import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { deleteCastPresence, listCastAppearances, listCastPresence, saveCastPresence, updateCastPresence } from './cast-presence';
import { createChapter, trashChapter } from './chapter';
import { saveChapterMemory } from './chapter-memory';
import { saveChapterPlan } from './chapter-plan';
import { createEntity } from './entity';
import {
  countPendingRelationSuggestions,
  listRelationScans,
  listRelationSuggestions,
  saveRelationScan,
  settleRelationSuggestion,
  type SuggestionInput,
} from './relation-suggestion';

const ctx = { now: '2026-10-23T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-relation-changes-'));
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

async function setup(db: ProjectDb) {
  const c1 = value(await createChapter(db, { id: 'c1', title: '第一章' }, ctx));
  const c2 = value(await createChapter(db, { id: 'c2', title: '第二章', after: 'c1' }, ctx));
  for (const [id, name] of [
    ['shen', '沈孤舟'],
    ['gu', '顾寒衣'],
  ] as const)
    value(await createEntity(db, { id, kind: 'character', name }, ctx));
  return { c1, c2 };
}

const suggestion = (id: string, patch: Partial<SuggestionInput> = {}): SuggestionInput => ({
  id,
  chapterId: 'c1',
  kind: 'relation_add',
  relationshipId: null,
  fromId: 'shen',
  fromName: '沈孤舟',
  toId: 'gu',
  toName: '顾寒衣',
  category: 'ally',
  label: ' 暂时联手 ',
  oldLabel: '',
  mutual: true,
  secret: false,
  description: '',
  validToChapterId: null,
  reason: ' 两人约定先对付藏锋山庄 ',
  memoryVersion: 1,
  ...patch,
});

describe('关系与人物变化的建议（B73 补充）', () => {
  it('一次查找换掉这些章原来待确认的建议，采用过、忽略过的留着；记下每章找到的记忆版本', async () => {
    const db = fresh();
    await setup(db);
    value(await saveRelationScan(db, { scanned: [{ chapterId: 'c1', memoryVersion: 1 }], llmCallId: null, suggestions: [suggestion('s1'), suggestion('s2', { kind: 'cast_exit', toId: null, toName: '', category: null, label: '', fromId: 'gu', fromName: '顾寒衣' })] }, ctx));
    const first = value(await listRelationSuggestions(db));
    expect(first.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(first[0]).toMatchObject({ label: '暂时联手', reason: '两人约定先对付藏锋山庄', status: 'pending', mutual: true, memoryVersion: 1 });

    const adopted = value(await settleRelationSuggestion(db, 's2', 1, 'adopted', 'x1', ctx));
    expect(adopted).toMatchObject({ status: 'adopted', resultId: 'x1', version: 2 });
    // 已经处理过的不能再处理。
    expect(await settleRelationSuggestion(db, 's2', 2, 'ignored', null, ctx)).toMatchObject({ ok: false, error: { code: 'conflict' } });

    value(await saveRelationScan(db, { scanned: [{ chapterId: 'c1', memoryVersion: 3 }], llmCallId: null, suggestions: [suggestion('s3', { label: '盟友' })] }, ctx));
    expect(value(await listRelationSuggestions(db)).map((s) => s.id)).toEqual(['s3']);
    expect(value(await listRelationSuggestions(db, null)).map((s) => `${s.id}:${s.status}`)).toEqual(['s3:pending', 's2:adopted']);
    expect(value(await listRelationScans(db))).toEqual(new Map([['c1', 3]]));
    expect(value(await countPendingRelationSuggestions(db))).toBe(1);
  });

  it('回收站里的章节上的建议不列出、不计数；同一章里先列出场，再列关系，最后是退场', async () => {
    const db = fresh();
    const { c2 } = await setup(db);
    value(
      await saveRelationScan(
        db,
        {
          scanned: [{ chapterId: 'c2', memoryVersion: 1 }],
          llmCallId: null,
          suggestions: [
            suggestion('a', { chapterId: 'c2', kind: 'cast_exit', toId: null, toName: '', category: null, label: '' }),
            suggestion('b', { chapterId: 'c2' }),
            suggestion('c', { chapterId: 'c2', kind: 'cast_enter', fromId: null, fromName: '白衣人', toId: null, toName: '', category: null, label: '' }),
          ],
        },
        ctx,
      ),
    );
    expect(value(await listRelationSuggestions(db)).map((s) => s.id)).toEqual(['c', 'b', 'a']);
    value(await trashChapter(db, c2.id, c2.version, ctx));
    expect(value(await listRelationSuggestions(db))).toEqual([]);
    expect(value(await countPendingRelationSuggestions(db))).toBe(0);
  });
});

describe('人物的出场、退场与回归（B73 补充）', () => {
  it('同一人物同一章同种记录只有一条，再记时改说明；修改有版本守卫；可以删除', async () => {
    const db = fresh();
    await setup(db);
    const exit = value(await saveCastPresence(db, { id: 'p1', entityId: 'gu', chapterId: 'c1', kind: 'exit', note: ' 坠崖 ' }, ctx));
    expect(exit).toMatchObject({ entityId: 'gu', chapterId: 'c1', kind: 'exit', note: '坠崖', version: 1 });
    const again = value(await saveCastPresence(db, { id: 'p2', entityId: 'gu', chapterId: 'c1', kind: 'exit', note: '坠崖身亡' }, ctx));
    expect(again).toMatchObject({ id: 'p1', note: '坠崖身亡', version: 2 });
    value(await saveCastPresence(db, { id: 'p3', entityId: 'gu', chapterId: 'c2', kind: 'return', note: '' }, ctx));
    expect(await updateCastPresence(db, 'p3', 1, { chapterId: 'c1', kind: 'exit', note: '' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await updateCastPresence(db, 'p1', 1, { chapterId: 'c2', kind: 'exit', note: '' }, ctx)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(await saveCastPresence(db, { id: 'p4', entityId: 'nobody', chapterId: 'c1', kind: 'exit', note: '' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    value(await deleteCastPresence(db, 'p3', 1));
    expect(await deleteCastPresence(db, 'p3', 1)).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(value(await listCastPresence(db)).map((p) => p.id)).toEqual(['p1']);
  });

  it('出现过的章节取自章节计划的出场人物与长篇记忆的人物状态（回收站以外）', async () => {
    const db = fresh();
    const { c2 } = await setup(db);
    value(await saveChapterPlan(db, 'c2', null, { goal: '', castIds: ['gu', 'shen'], beats: [], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: null }, ctx));
    value(await saveChapterMemory(db, { chapterId: 'c1', summary: '沈孤舟出场', castState: { shen: '负伤' }, foreshadowProgress: {}, basedOn: {}, llmCallId: null }, ctx));
    const sorted = (rows: readonly { chapterId: string; entityId: string }[]) => rows.map((r) => `${r.chapterId}:${r.entityId}`).sort();
    expect(sorted(value(await listCastAppearances(db)))).toEqual(['c1:shen', 'c2:gu', 'c2:shen']);
    value(await trashChapter(db, c2.id, c2.version, ctx));
    expect(sorted(value(await listCastAppearances(db)))).toEqual(['c1:shen']);
  });
});

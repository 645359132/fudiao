import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter, trashChapter } from './chapter';
import { getChapterMemory, listChapterMemories, reviewStaleMemories, saveChapterMemory } from './chapter-memory';
import { deleteChapterPlan, getChapterPlan, listChapterPlans, saveChapterPlan, setPlanStatus, type PlanFields } from './chapter-plan';
import { createForeshadow, deleteForeshadow, getForeshadow, listForeshadows, updateForeshadow, type ForeshadowFields } from './foreshadow';
import { addIssues, countPendingIssues, getIssue, listIssues, replacePendingIssues, reviewStaleIssues, setIssueStatus, type IssueInput } from './review-issue';
import { createCustomSkill, deleteCustomSkill, ensureBuiltinSkills, listSkills, updateSkill } from './writing-skill';

const ctx = { now: '2026-10-10T00:00:00.000Z' };
const later = { now: '2026-10-10T01:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-writing-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

let ids = 0;
const newId = () => `w${String(ids++).padStart(5, '0')}`;

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** 两章，第一章有两段（版本 1）。 */
async function fresh(): Promise<ProjectDb> {
  const r = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: ctx.now });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  opened.push(r.value.db);
  const db = r.value.db;
  value(await createChapter(db, { id: 'c1', title: '第一章' }, ctx));
  value(await createChapter(db, { id: 'c2', title: '第二章', after: 'c1' }, ctx));
  value(
    await db.transaction([
      { sql: "INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES ('g1', 'c1', 'a0', '雨下得更紧了。', ?, ?)", params: [ctx.now, ctx.now] },
      { sql: "INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES ('g2', 'c1', 'a1', '他没有回头。', ?, ?)", params: [ctx.now, ctx.now] },
    ]),
  );
  return db;
}

const anchor = (paragraphId: string, paragraphVersion = 1) => ({ paragraphId, paragraphVersion, start: 0, end: 2, quote: '雨下' });

describe('伏笔账本', () => {
  const fields: ForeshadowFields = {
    title: '玉佩的来历',
    content: '掌柜多看了玉佩一眼',
    reveal: '玉佩是王家失物的仿品',
    plantChapterId: 'c1',
    plantAnchor: anchor('g1'),
    payoffChapterId: 'c2',
    payoffAnchor: null,
    status: 'planted',
  };

  it('新建、读取、按状态列出、按版本修改与删除', async () => {
    const db = await fresh();
    const f = value(await createForeshadow(db, { id: 'f1', ...fields }, ctx));
    expect(f).toMatchObject({ title: '玉佩的来历', plantAnchor: anchor('g1'), payoffAnchor: null, status: 'planted', version: 1 });
    value(await createForeshadow(db, { id: 'f2', ...fields, title: '债主', status: 'planned', plantAnchor: null }, ctx));
    expect(value(await listForeshadows(db, ['planned'])).map((x) => x.id)).toEqual(['f2']);

    const paid = value(await updateForeshadow(db, f, { ...fields, status: 'paid_off', payoffAnchor: anchor('g2') }, later));
    expect(paid).toMatchObject({ status: 'paid_off', version: 2 });
    expect(await updateForeshadow(db, f, fields, later)).toEqual({ ok: false, error: { code: 'conflict' } });

    expect(await deleteForeshadow(db, f)).toEqual({ ok: false, error: { code: 'conflict' } });
    value(await deleteForeshadow(db, paid));
    expect(await getForeshadow(db, 'f1')).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('章节计划里要埋或要收的伏笔不能删除（否则计划里留下指不到的标识）；从计划里去掉以后可以', async () => {
    const db = await fresh();
    const f = value(await createForeshadow(db, { id: 'f1', ...fields }, ctx));
    const plan = value(await saveChapterPlan(db, 'c2', null, { goal: '收回玉佩', castIds: [], beats: ['对质'], foreshadowPlant: [], foreshadowPayoff: ['f1'], treatment: '', targetWords: 3000 }, ctx));
    expect(await deleteForeshadow(db, f)).toEqual({ ok: false, error: { code: 'in_use' } });
    expect(value(await getForeshadow(db, 'f1')).id).toBe('f1');
    value(await saveChapterPlan(db, 'c2', plan, { goal: '收回玉佩', castIds: [], beats: ['对质'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }, later));
    value(await deleteForeshadow(db, f));
  });
});

describe('章节计划', () => {
  const plan: PlanFields = {
    goal: '林舟当出玉佩',
    castIds: ['e1'],
    beats: ['讨价还价', '掌柜起疑'],
    foreshadowPlant: ['f1'],
    foreshadowPayoff: [],
    treatment: '讨价略写，起疑展开',
    targetWords: 3000,
  };

  it('没有计划时新建，之后按版本修改；写作进度单独推进', async () => {
    const db = await fresh();
    expect(value(await getChapterPlan(db, 'c1'))).toBeNull();
    const p = value(await saveChapterPlan(db, 'c1', null, plan, ctx));
    expect(p).toMatchObject({ chapterId: 'c1', beats: ['讨价还价', '掌柜起疑'], status: 'todo', version: 1 });
    const edited = value(await saveChapterPlan(db, 'c1', p, { ...plan, targetWords: null }, later));
    expect(edited).toMatchObject({ targetWords: null, version: 2 });
    expect(await saveChapterPlan(db, 'c1', p, plan, later)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(value(await setPlanStatus(db, edited, 'written', later))).toMatchObject({ status: 'written', version: 3 });
  });

  it('按版本删除计划；写手写过（有写作进度）的计划不删', async () => {
    const db = await fresh();
    const p = value(await saveChapterPlan(db, 'c1', null, plan, ctx));
    const edited = value(await saveChapterPlan(db, 'c1', p, { ...plan, goal: '改过' }, later));
    expect(await deleteChapterPlan(db, p)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(await deleteChapterPlan(db, { ...edited, progress: { runId: 'r', segments: [], words: [], done: 0, snapshotId: 's' } })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    value(await deleteChapterPlan(db, edited));
    expect(value(await getChapterPlan(db, 'c1'))).toBeNull();
  });

  it('按章节顺序列出，回收站中的章节不列', async () => {
    const db = await fresh();
    value(await saveChapterPlan(db, 'c2', null, plan, ctx));
    value(await saveChapterPlan(db, 'c1', null, plan, ctx));
    expect(value(await listChapterPlans(db)).map((p) => p.chapterId)).toEqual(['c1', 'c2']);
    value(await trashChapter(db, 'c2', 1, later));
    expect(value(await listChapterPlans(db)).map((p) => p.chapterId)).toEqual(['c1']);
  });
});

describe('写作技能', () => {
  const builtins = [
    { key: 'foreshadow', name: '伏笔埋设与回收', version: '1', stages: ['writing'] as const },
    { key: 'cliffhanger', name: '章末钩子', version: '1', stages: ['writing'] as const },
  ];

  it('两处同时登记内置技能（两个写手同时开写）：都成功，每个技能只有一条', async () => {
    const db = await fresh();
    const [a, b] = await Promise.all([ensureBuiltinSkills(db, builtins, newId, ctx), ensureBuiltinSkills(db, builtins, newId, ctx)]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(value(await ensureBuiltinSkills(db, builtins, newId, ctx)).map((s) => s.key).sort()).toEqual(builtins.map((x) => x.key).sort());
  });

  it('登记内置技能；内置技能升级时保留作者的启用状态与改动', async () => {
    const db = await fresh();
    const first = value(await ensureBuiltinSkills(db, builtins, newId, ctx));
    expect(first.map((s) => [s.key, s.enabled, s.builtinVersion])).toEqual([
      ['foreshadow', true, '1'],
      ['cliffhanger', true, '1'],
    ]);
    const hook = first.find((s) => s.key === 'cliffhanger')!;
    value(await updateSkill(db, hook, { enabled: false, instruction: '停在悬念上，不要总结' }, later));
    const upgraded = value(await ensureBuiltinSkills(db, [builtins[0]!, { ...builtins[1]!, version: '2' }], newId, later));
    expect(upgraded.find((s) => s.key === 'cliffhanger')).toMatchObject({ enabled: false, instruction: '停在悬念上，不要总结', builtinVersion: '2' });
    // 没有变化时不写库。
    const again = value(await ensureBuiltinSkills(db, [builtins[0]!, { ...builtins[1]!, version: '2' }], newId, later));
    expect(again.find((s) => s.key === 'cliffhanger')?.version).toBe(upgraded.find((s) => s.key === 'cliffhanger')?.version);
  });

  it('内置技能的阶段随模板登记与同步，作者不能改；自定义技能可以设阶段，没给时为写章节', async () => {
    const db = await fresh();
    const planning = { key: 'snowflake', name: '雪花写作法', version: '1', stages: ['planning'] as const };
    const first = value(await ensureBuiltinSkills(db, [...builtins, planning], newId, ctx));
    expect(first.map((s) => [s.key, s.stages])).toEqual([
      ['foreshadow', ['writing']],
      ['cliffhanger', ['writing']],
      ['snowflake', ['planning']],
    ]);
    const snowflake = first.find((s) => s.key === 'snowflake')!;
    expect(await updateSkill(db, snowflake, { stages: ['writing'] }, later)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    // 模板改了阶段（同一版本也同步）。
    const synced = value(await ensureBuiltinSkills(db, [...builtins, { ...planning, stages: ['planning', 'writing'] as const }], newId, later));
    expect(synced.find((s) => s.key === 'snowflake')?.stages).toEqual(['planning', 'writing']);

    const plain = value(await createCustomSkill(db, { id: 's1', key: 'mine', name: '我的', description: '', instruction: '对话要短' }, ctx));
    expect(plain.stages).toEqual(['writing']);
    const both = value(await createCustomSkill(db, { id: 's2', key: 'arc', name: '三幕', description: '', instruction: '按三幕排', stages: ['writing', 'planning'] }, ctx));
    expect(both.stages).toEqual(['planning', 'writing']);
    expect(value(await updateSkill(db, both, { stages: ['planning'] }, later)).stages).toEqual(['planning']);
  });

  it('自定义技能须写明说明，可以删除；内置技能只能停用', async () => {
    const db = await fresh();
    const [builtin] = value(await ensureBuiltinSkills(db, builtins, newId, ctx));
    expect(await createCustomSkill(db, { id: 's1', key: 'mine', name: '我的', description: '', instruction: '  ' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    const mine = value(await createCustomSkill(db, { id: 's1', key: 'mine', name: '我的', description: '', instruction: '对话不超过三句就要有动作' }, ctx));
    expect(await updateSkill(db, mine, { instruction: '' }, later)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await deleteCustomSkill(db, builtin!)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    value(await deleteCustomSkill(db, mine));
    expect(value(await listSkills(db)).map((s) => s.key)).toEqual(['foreshadow', 'cliffhanger']);
  });
});

describe('长篇记忆', () => {
  const memory = { chapterId: 'c1', summary: '林舟深夜当玉', castState: { e1: '急需用钱' }, foreshadowProgress: { f1: 'planted' }, basedOn: { g1: 1, g2: 1 }, llmCallId: null };

  it('写入后重建为整行替换，状态回到有效', async () => {
    const db = await fresh();
    const m = value(await saveChapterMemory(db, memory, ctx));
    expect(m).toMatchObject({ summary: '林舟深夜当玉', basedOn: { g1: 1, g2: 1 }, status: 'valid', version: 1 });
    value(await db.transaction([{ sql: "UPDATE chapter_memory SET status = 'stale' WHERE chapter_id = 'c1'", params: [] }]));
    const rebuilt = value(await saveChapterMemory(db, { ...memory, summary: '林舟当玉未成' }, later));
    expect(rebuilt).toMatchObject({ summary: '林舟当玉未成', status: 'valid', version: 2 });
    expect(value(await listChapterMemories(db)).map((x) => x.chapterId)).toEqual(['c1']);
  });

  it('依据的段落改过、删掉或本章多了段落时标为待复核；没有变化时不动', async () => {
    const db = await fresh();
    value(await saveChapterMemory(db, memory, ctx));
    expect(value(await reviewStaleMemories(db, later))).toEqual([]);
    value(await db.transaction([{ sql: "UPDATE paragraph SET text = '雨停了。', version = 2 WHERE id = 'g1'", params: [] }]));
    expect(value(await reviewStaleMemories(db, later))).toEqual(['c1']);
    expect(value(await getChapterMemory(db, 'c1'))).toMatchObject({ status: 'stale' });

    value(await saveChapterMemory(db, { ...memory, basedOn: { g1: 2, g2: 1 } }, later));
    value(
      await db.transaction([
        { sql: "INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES ('g3', 'c1', 'a2', '门开了。', ?, ?)", params: [ctx.now, ctx.now] },
      ]),
    );
    expect(value(await reviewStaleMemories(db, later))).toEqual(['c1']);
  });

  it('删掉一段、或一段挪到别的章（段落数不变）也标为待复核；已是待复核的不再动；全书的记忆列表不带依据的段落版本', async () => {
    const db = await fresh();
    value(await saveChapterMemory(db, memory, ctx));
    value(await saveChapterMemory(db, { ...memory, chapterId: 'c2', basedOn: {} }, ctx));
    expect(value(await reviewStaleMemories(db, later))).toEqual([]);
    value(await db.transaction([{ sql: "DELETE FROM paragraph WHERE id = 'g2'", params: [] }]));
    expect(value(await reviewStaleMemories(db, later))).toEqual(['c1']);
    expect(value(await reviewStaleMemories(db, later))).toEqual([]);

    // 第二章记着的是“没有段落”；第一章的一段挪过来以后两章都变了。
    value(await saveChapterMemory(db, { ...memory, basedOn: { g1: 1 } }, later));
    expect(value(await reviewStaleMemories(db, later))).toEqual([]);
    value(await db.transaction([{ sql: "UPDATE paragraph SET chapter_id = 'c2' WHERE id = 'g1'", params: [] }]));
    expect(value(await reviewStaleMemories(db, later)).sort()).toEqual(['c1', 'c2']);

    const listed = value(await listChapterMemories(db));
    expect(listed.map((m) => m.chapterId)).toEqual(['c1', 'c2']);
    expect(listed.every((m) => !('basedOn' in m))).toBe(true);
    expect(value(await getChapterMemory(db, 'c1'))).toMatchObject({ basedOn: { g1: 1 } });
  });
});

describe('审核问题', () => {
  const issue = (id: string, over: Partial<IssueInput> = {}): IssueInput => ({
    id,
    chapterId: 'c1',
    kind: 'setting_conflict',
    severity: 'medium',
    anchor: anchor('g1'),
    evidence: [{ type: 'entity', id: 'e1' }],
    description: '年龄与设定不符',
    suggestion: '改为二十八岁',
    llmCallId: null,
    source: 'program',
    ...over,
  });

  it('一并写入，严重的在前；只有待处理的问题可以处理', async () => {
    const db = await fresh();
    value(await addIssues(db, [issue('i1', { severity: 'low', kind: 'ai_tone' }), issue('i2', { severity: 'high' })], ctx));
    const list = value(await listIssues(db, 'c1'));
    expect(list.map((i) => [i.id, i.severity])).toEqual([
      ['i2', 'high'],
      ['i1', 'low'],
    ]);
    const ignored = value(await setIssueStatus(db, list[1]!, 'ignored', later));
    expect(ignored.status).toBe('ignored');
    expect(await setIssueStatus(db, ignored, 'fixed', later)).toMatchObject({ ok: false });
    expect(value(await listIssues(db, 'c1', ['ignored'])).map((i) => i.id)).toEqual(['i1']);
  });

  it('锚点所在段落改过或删掉后，待处理的问题标为过期', async () => {
    const db = await fresh();
    value(await addIssues(db, [issue('i1'), issue('i2', { anchor: anchor('g2') })], ctx));
    expect(value(await reviewStaleIssues(db, 'c1', later))).toEqual([]);
    value(await db.transaction([{ sql: "DELETE FROM paragraph WHERE id = 'g2'", params: [] }]));
    expect(value(await reviewStaleIssues(db, 'c1', later))).toEqual(['i2']);
    expect(value(await listIssues(db, 'c1', ['stale'])).map((i) => i.id)).toEqual(['i2']);
  });

  it('重新审核：同一来源仍待处理的旧问题过期，换成新的；另一来源的问题与作者处理过的问题不动', async () => {
    const db = await fresh();
    value(await addIssues(db, [issue('i1', { source: 'model' }), issue('i2', { source: 'model' }), issue('i3')], ctx));
    value(await setIssueStatus(db, value(await getIssue(db, 'i2'))!, 'ignored', later));
    value(await replacePendingIssues(db, 'c1', 'model', [issue('i4', { source: 'model' })], later));
    expect(value(await listIssues(db, 'c1')).map((i) => i.id).sort()).toEqual(['i3', 'i4']);
    expect(value(await getIssue(db, 'i1'))?.status).toBe('stale');
    expect(value(await getIssue(db, 'i2'))?.status).toBe('ignored');
    expect(value(await countPendingIssues(db))).toEqual(new Map([['c1', 2]]));
    // 这一次没有问题：旧问题同样过期。
    value(await replacePendingIssues(db, 'c1', 'model', [], later));
    expect(value(await listIssues(db, 'c1')).map((i) => i.id)).toEqual(['i3']);
    expect(value(await getIssue(db, 'none'))).toBeNull();
  });
});

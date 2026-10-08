import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportData, importData } from '../data-export';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter } from './chapter';
import { createEntity, deleteEntity, updateEntity } from './entity';
import { createFact, deleteFact, getFact, listFacts, reviewStaleFacts, setFactStatus, updateFact, type FactInput } from './fact';

const ctx = { now: '2026-10-08T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-facts-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

let ids = 0;
const newId = () => `r${String(ids++).padStart(5, '0')}`;

async function fresh(): Promise<ProjectDb> {
  const r = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: ctx.now });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  opened.push(r.value.db);
  const db = r.value.db;
  value(await createEntity(db, { id: 'shen', kind: 'character', name: '沈砚' }, ctx));
  value(await createEntity(db, { id: 'shop', kind: 'location', name: '当铺' }, ctx));
  return db;
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const world = (content: string, basis: FactInput['basis'] = []): FactInput => ({
  kind: 'world',
  holderId: null,
  subjectIds: [],
  content,
  modality: null,
  confidence: null,
  validFromChapterId: null,
  validToChapterId: null,
  validFrom: null,
  validTo: null,
  basis,
});

const status = async (db: ProjectDb, id: string) => {
  const f = value(await getFact(db, id));
  return [f.status, f.reviewReason];
};

describe('三类事实', () => {
  it('世界事实、人物认知与人物说法；故事时间范围与适用章节', async () => {
    const db = await fresh();
    value(await createChapter(db, { id: 'c1', title: '第一章' }, ctx));
    value(await createChapter(db, { id: 'c2', title: '第二章' }, ctx));
    const w = value(await createFact(db, 'f1', { ...world('沈砚欠下赌债'), subjectIds: ['shen', 'shen'], validFrom: { label: '第三年春', order: 3 }, validTo: { label: '入冬', order: 4 }, validFromChapterId: 'c1', validToChapterId: 'c2' }, 'confirmed', ctx, newId));
    expect(w).toMatchObject({ kind: 'world', subjectIds: ['shen'], validFrom: { label: '第三年春', order: 3 }, validTo: { label: '入冬', order: 4 }, status: 'confirmed', basis: [] });
    const belief = value(await createFact(db, 'f2', { ...world('掌柜认得那块玉'), kind: 'belief', holderId: 'shen', modality: 'inferred', confidence: 0.6 }, 'candidate', ctx, newId));
    expect(belief).toMatchObject({ holderId: 'shen', modality: 'inferred', confidence: 0.6 });
    value(await createFact(db, 'f3', { ...world('我从没来过这里'), kind: 'claim', holderId: 'shen', modality: 'claimed' }, 'candidate', ctx, newId));
    expect(value(await listFacts(db)).map((f) => f.kind)).toEqual(['world', 'belief', 'claim']);
  });

  it('校验：持有者、来源方式、相信程度、故事时间与章节的先后、内容不能为空', async () => {
    const db = await fresh();
    value(await createChapter(db, { id: 'c1', title: '第一章' }, ctx));
    value(await createChapter(db, { id: 'c2', title: '第二章' }, ctx));
    const bad = async (input: FactInput) => (await createFact(db, `x${ids++}`, input, 'candidate', ctx, newId)).ok;
    expect(await bad({ ...world('甲'), holderId: 'shen' })).toBe(false);
    expect(await bad({ ...world('甲'), kind: 'belief' })).toBe(false);
    expect(await bad({ ...world('甲'), kind: 'belief', holderId: 'shop' })).toBe(false);
    expect(await bad({ ...world('甲'), kind: 'claim', holderId: 'shen', modality: 'observed' })).toBe(false);
    expect(await bad({ ...world('甲'), confidence: 1.5 })).toBe(false);
    expect(await bad({ ...world('甲'), validFrom: { label: '冬', order: 5 }, validTo: { label: '春', order: 1 } })).toBe(false);
    expect(await bad({ ...world('甲'), validFromChapterId: 'c2', validToChapterId: 'c1' })).toBe(false);
    expect(await bad(world(' '))).toBe(false);
    expect(await bad(world('甲', [{ type: 'entity', id: 'missing' }]))).toBe(false);
  });
});

describe('依据与待复核（B12 首版）', () => {
  it('依据的设定修改后，已确认的事实标为待复核并写明原因；候选与已驳回的不动', async () => {
    const db = await fresh();
    value(await createFact(db, 'f1', world('当铺在城南', [{ type: 'entity', id: 'shop' }]), 'confirmed', ctx, newId));
    value(await createFact(db, 'f2', world('当铺夜里不开门', [{ type: 'entity', id: 'shop' }]), 'candidate', ctx, newId));
    value(await createFact(db, 'f3', world('当铺是新开的', [{ type: 'entity', id: 'shop' }]), 'rejected', ctx, newId));
    expect(value(await reviewStaleFacts(db, ctx))).toBe(0);
    value(await updateEntity(db, 'shop', 1, { description: '城北的老当铺' }, ctx));
    expect(value(await reviewStaleFacts(db, ctx))).toBe(1);
    expect(await status(db, 'f1')).toEqual(['needs_review', '设定“当铺”已修改']);
    expect(await status(db, 'f2')).toEqual(['candidate', null]);
    expect(await status(db, 'f3')).toEqual(['rejected', null]);
    // 再检查一次不重复标记。
    expect(value(await reviewStaleFacts(db, ctx))).toBe(0);
  });

  it('沿依赖链传递：依据的事实待复核时，以它为依据的已确认事实也待复核', async () => {
    const db = await fresh();
    value(await createFact(db, 'f1', world('当铺在城南', [{ type: 'entity', id: 'shop' }]), 'confirmed', ctx, newId));
    value(await createFact(db, 'f2', world('沈砚每天经过城南', [{ type: 'fact', id: 'f1' }]), 'confirmed', ctx, newId));
    value(await createFact(db, 'f3', world('沈砚认得掌柜', [{ type: 'fact', id: 'f2' }]), 'confirmed', ctx, newId));
    value(await updateEntity(db, 'shop', 1, { name: '城北当铺' }, ctx));
    expect(value(await reviewStaleFacts(db, ctx))).toBe(3);
    expect(await status(db, 'f2')).toEqual(['needs_review', '依据的事实“当铺在城南”需要复核']);
    expect(await status(db, 'f3')).toEqual(['needs_review', '依据的事实“沈砚每天经过城南”需要复核']);
  });

  it('复核后重新确认：依据的版本更新，不再被标记；依据的事实仍待复核时会再次标记', async () => {
    const db = await fresh();
    value(await createFact(db, 'f1', world('当铺在城南', [{ type: 'entity', id: 'shop' }]), 'confirmed', ctx, newId));
    value(await createFact(db, 'f2', world('沈砚每天经过城南', [{ type: 'fact', id: 'f1' }]), 'confirmed', ctx, newId));
    value(await updateEntity(db, 'shop', 1, { name: '城北当铺' }, ctx));
    value(await reviewStaleFacts(db, ctx));
    value(await setFactStatus(db, 'f2', 1, 'confirmed', ctx));
    value(await reviewStaleFacts(db, ctx));
    expect((await status(db, 'f2'))[0]).toBe('needs_review');
    value(await setFactStatus(db, 'f1', 1, 'confirmed', ctx));
    expect(value(await getFact(db, 'f1')).basis).toEqual([{ type: 'entity', id: 'shop', version: 2 }]);
    value(await setFactStatus(db, 'f2', 1, 'confirmed', ctx));
    expect(value(await reviewStaleFacts(db, ctx))).toBe(0);
    expect(await status(db, 'f2')).toEqual(['confirmed', null]);
  });

  it('修改事实内容：版本加一，以它为依据的事实待复核；删除依据时写明已删除', async () => {
    const db = await fresh();
    value(await createFact(db, 'f1', world('当铺在城南'), 'confirmed', ctx, newId));
    value(await createFact(db, 'f2', world('沈砚每天经过城南', [{ type: 'fact', id: 'f1' }]), 'confirmed', ctx, newId));
    value(await createFact(db, 'f3', world('掌柜住在当铺后院', [{ type: 'entity', id: 'shop' }]), 'confirmed', ctx, newId));
    const changed = value(await updateFact(db, 'f1', 1, world('当铺在城北'), ctx, newId));
    expect(changed.version).toBe(2);
    expect(await updateFact(db, 'f1', 1, world('当铺在城东'), ctx, newId)).toEqual({ ok: false, error: { code: 'conflict' } });
    value(await reviewStaleFacts(db, ctx));
    expect(await status(db, 'f2')).toEqual(['needs_review', '依据的事实“当铺在城北”已修改']);
    value(await deleteEntity(db, 'shop', 1));
    value(await reviewStaleFacts(db, ctx));
    expect(await status(db, 'f3')).toEqual(['needs_review', '依据的设定已删除']);
    value(await setFactStatus(db, 'f2', 1, 'confirmed', ctx));
    value(await deleteFact(db, 'f1', 2));
    value(await reviewStaleFacts(db, ctx));
    expect(await status(db, 'f2')).toEqual(['needs_review', '依据的事实已删除']);
  });

  it('事实不能以自己为依据；依据去重', async () => {
    const db = await fresh();
    value(await createFact(db, 'f1', world('甲'), 'confirmed', ctx, newId));
    expect(await updateFact(db, 'f1', 1, world('甲', [{ type: 'fact', id: 'f1' }]), ctx, newId)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    const f = value(await createFact(db, 'f2', world('乙', [{ type: 'entity', id: 'shop' }, { type: 'entity', id: 'shop' }]), 'confirmed', ctx, newId));
    expect(f.basis).toEqual([{ type: 'entity', id: 'shop', version: 1 }]);
  });

  it('事实与依据导出再导入后一致（数据迁移验收：已确认事实、来源关系）', async () => {
    const db = await fresh();
    value(await createFact(db, 'f1', world('当铺在城南', [{ type: 'entity', id: 'shop' }]), 'confirmed', ctx, newId));
    const r = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: ctx.now });
    if (!r.ok) throw new Error();
    opened.push(r.value.db);
    value(await importData(r.value.db, value(await exportData(db))));
    expect(value(await listFacts(r.value.db))).toEqual(value(await listFacts(db)));
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createEntity, deleteEntity, getEntity, listEntities, setEntityLocked, updateEntity } from './entity';

const ctx = { now: '2026-10-08T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-entities-'));
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

describe('设定条目', () => {
  it('新建、修改名字别名说明与属性；别名去重并去掉与名字相同的项；版本加一', async () => {
    const db = fresh();
    const e = value(await createEntity(db, { id: 'e1', kind: 'character', name: ' 沈砚 ' }, ctx));
    expect(e).toMatchObject({ name: '沈砚', aliases: [], description: '', attributes: [], locked: false, version: 1 });
    const updated = value(
      await updateEntity(
        db,
        'e1',
        1,
        { aliases: ['沈先生', ' 沈先生', '', '沈砚', '砚哥'], description: '当铺常客', attributes: [{ label: '年龄', value: '二十八' }, { label: ' ', value: '' }] },
        ctx,
      ),
    );
    expect(updated).toMatchObject({ aliases: ['沈先生', '砚哥'], description: '当铺常客', attributes: [{ label: '年龄', value: '二十八' }], version: 2 });
    expect(value(await getEntity(db, 'e1'))).toEqual(updated);
  });

  it('列表按种类与名字排序', async () => {
    const db = fresh();
    value(await createEntity(db, { id: 'a', kind: 'location', name: '当铺' }, ctx));
    value(await createEntity(db, { id: 'b', kind: 'character', name: '沈砚' }, ctx));
    value(await createEntity(db, { id: 'c', kind: 'character', name: '掌柜' }, ctx));
    expect(value(await listEntities(db)).map((e) => e.name)).toEqual(['掌柜', '沈砚', '当铺']);
  });

  it('锁定后不能修改也不能删除（自动流程与作者都一样），解锁后可以；锁定不提升版本', async () => {
    const db = fresh();
    value(await createEntity(db, { id: 'e1', kind: 'rule', name: '城中宵禁' }, ctx));
    const locked = value(await setEntityLocked(db, 'e1', 1, true, ctx));
    expect(locked).toMatchObject({ locked: true, version: 1 });
    expect(await updateEntity(db, 'e1', 1, { description: '取消宵禁' }, ctx)).toEqual({ ok: false, error: { code: 'locked' } });
    expect(await deleteEntity(db, 'e1', 1)).toEqual({ ok: false, error: { code: 'locked' } });
    value(await setEntityLocked(db, 'e1', 1, false, ctx));
    expect(value(await updateEntity(db, 'e1', 1, { description: '子时起宵禁' }, ctx)).description).toBe('子时起宵禁');
  });

  it('版本不符时冲突；名字不能为空', async () => {
    const db = fresh();
    value(await createEntity(db, { id: 'e1', kind: 'item', name: '玉佩' }, ctx));
    expect(await updateEntity(db, 'e1', 9, { name: '玉' }, ctx)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(await updateEntity(db, 'e1', 1, { name: ' ' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await createEntity(db, { id: 'x', kind: 'item', name: '' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('仍有人物认知以它为持有者时不能删除；没有引用时可以删除', async () => {
    const db = fresh();
    value(await createEntity(db, { id: 'e1', kind: 'character', name: '沈砚' }, ctx));
    value(await createEntity(db, { id: 'e2', kind: 'location', name: '当铺' }, ctx));
    value(await db.transaction([{ sql: "INSERT INTO fact (id, kind, holder_id, content, created_at, updated_at) VALUES ('f1', 'belief', 'e1', '掌柜认得那块玉', ?, ?)", params: [ctx.now, ctx.now] }]));
    expect(await deleteEntity(db, 'e1', 1)).toEqual({ ok: false, error: { code: 'in_use' } });
    expect(await deleteEntity(db, 'e2', 1)).toEqual({ ok: true, value: undefined });
    expect(await getEntity(db, 'e2')).toEqual({ ok: false, error: { code: 'not_found' } });
  });
});

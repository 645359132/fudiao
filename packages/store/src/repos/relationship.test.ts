import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createChapter, trashChapter } from './chapter';
import { createEntity, deleteEntity } from './entity';
import {
  createRelationship,
  deleteRelationship,
  listRelationPositions,
  listRelationships,
  setRelationPosition,
  updateRelationship,
  type RelationshipFields,
} from './relationship';

const ctx = { now: '2026-10-15T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-relations-'));
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

async function people(db: ProjectDb) {
  for (const [id, name] of [
    ['shen', '沈砚'],
    ['wei', '卫七'],
    ['master', '青崖老人'],
  ] as const)
    value(await createEntity(db, { id, kind: 'character', name }, ctx));
  value(await createEntity(db, { id: 'gang', kind: 'organization', name: '漕帮' }, ctx));
}

const fields = (patch: Partial<RelationshipFields> = {}): RelationshipFields => ({
  fromId: 'master',
  toId: 'shen',
  category: 'mentor',
  label: '师父',
  mutual: false,
  description: '',
  secret: false,
  validFromChapterId: null,
  validToChapterId: null,
  ...patch,
});

describe('人物关系（B73）', () => {
  it('新建、修改（版本守卫）与删除；称谓与说明去掉首尾空白', async () => {
    const db = fresh();
    await people(db);
    const created = value(await createRelationship(db, { id: 'r1', ...fields({ label: ' 师父 ', description: ' 临终托付 ' }) }, ctx));
    expect(created).toMatchObject({ id: 'r1', fromId: 'master', toId: 'shen', category: 'mentor', label: '师父', description: '临终托付', mutual: false, secret: false, version: 1 });

    const updated = value(await updateRelationship(db, 'r1', 1, fields({ category: 'family', label: '叔父', secret: true }), ctx));
    expect(updated).toMatchObject({ category: 'family', label: '叔父', secret: true, version: 2 });
    expect(await updateRelationship(db, 'r1', 1, fields(), ctx)).toEqual({ ok: false, error: { code: 'conflict' } });

    expect(await deleteRelationship(db, 'r1', 1)).toEqual({ ok: false, error: { code: 'conflict' } });
    expect((await deleteRelationship(db, 'r1', 2)).ok).toBe(true);
    expect(await deleteRelationship(db, 'r1', 2)).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(value(await listRelationships(db))).toEqual([]);
  });

  it('两端须是不同的、已有的设定；称谓不能为空', async () => {
    const db = fresh();
    await people(db);
    expect(await createRelationship(db, { id: 'r', ...fields({ toId: 'master' }) }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await createRelationship(db, { id: 'r', ...fields({ toId: 'nobody' }) }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid', detail: '关系的一端不是已有的设定' } });
    expect(await createRelationship(db, { id: 'r', ...fields({ label: '  ' }) }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid', detail: '关系的称谓不能为空' } });
  });

  it('设定删除时，它的关系与关系图上的位置一起删除；适用章节被删除时变为不限', async () => {
    const db = fresh();
    await people(db);
    const chapter = value(await createChapter(db, { id: 'c1', title: '第一章' }, ctx));
    value(await createRelationship(db, { id: 'r1', ...fields({ validFromChapterId: 'c1' }) }, ctx));
    value(await createRelationship(db, { id: 'r2', ...fields({ fromId: 'wei', toId: 'gang', category: 'affiliation', label: '账房' }) }, ctx));
    value(await setRelationPosition(db, 'wei', { x: 10, y: 20 }, ctx));
    value(await setRelationPosition(db, 'wei', { x: 30, y: 40 }, ctx));
    value(await setRelationPosition(db, 'shen', { x: 0, y: 0 }, ctx));
    expect(value(await listRelationPositions(db))).toEqual([
      { entityId: 'shen', x: 0, y: 0 },
      { entityId: 'wei', x: 30, y: 40 },
    ]);

    value(await deleteEntity(db, 'wei', 1));
    expect(value(await listRelationships(db)).map((r) => r.id)).toEqual(['r1']);
    expect(value(await listRelationPositions(db))).toEqual([{ entityId: 'shen', x: 0, y: 0 }]);

    value(await setRelationPosition(db, 'shen', null, ctx));
    expect(value(await listRelationPositions(db))).toEqual([]);

    // 回收站里的章节还在，关系的起始章节不变；章节真正删除的情形由外键 SET NULL 处理。
    value(await trashChapter(db, chapter.id, chapter.version, ctx));
    expect(value(await listRelationships(db))[0]?.validFromChapterId).toBe('c1');
  });
});

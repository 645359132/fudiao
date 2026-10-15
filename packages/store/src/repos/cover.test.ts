import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { getCover, getCoverThumbnail, MAX_COVER_CHARS, removeCover, saveCover } from './cover';
import { createProject } from './project';

const ctx = { now: '2026-10-15T00:00:00.000Z' };
const later = { now: '2026-10-15T01:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-cover-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

async function fresh(): Promise<ProjectDb> {
  const r = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: ctx.now });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  opened.push(r.value.db);
  value(await createProject(r.value.db, { id: 'p1', title: '雨夜' }, ctx));
  return r.value.db;
}

const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const thumbnail = 'data:image/jpeg;base64,/9j/4AAQ';

describe('作品封面（B76）', () => {
  it('没有封面时为空；设定后读出封面与缩略图；更换时版本加一；去掉后回到没有封面', async () => {
    const db = await fresh();
    expect(value(await getCover(db))).toBeNull();
    expect(value(await getCoverThumbnail(db))).toBeNull();
    const first = value(await saveCover(db, 'p1', { image, thumbnail, width: 600, height: 800 }, ctx));
    expect(first).toMatchObject({ projectId: 'p1', image, width: 600, height: 800, version: 1 });
    expect(value(await getCoverThumbnail(db))).toBe(thumbnail);
    const second = value(await saveCover(db, 'p1', { image: 'data:image/png;base64,iVBORw0KGgo=', thumbnail, width: 900, height: 1200 }, later));
    expect(second).toMatchObject({ width: 900, version: 2, updatedAt: later.now });
    value(await removeCover(db));
    expect(value(await getCover(db))).toBeNull();
  });

  it('不是图片的 data URL、尺寸无效或太大时不保存', async () => {
    const db = await fresh();
    const bad = [
      { image: 'https://example.com/a.jpg', thumbnail, width: 1, height: 1 },
      { image: 'data:text/plain;base64,AAAA', thumbnail, width: 1, height: 1 },
      { image, thumbnail, width: 0, height: 1 },
      { image, thumbnail, width: 1.5, height: 1 },
      { image: `data:image/jpeg;base64,${'A'.repeat(MAX_COVER_CHARS)}`, thumbnail, width: 1, height: 1 },
    ];
    for (const cover of bad) expect(await saveCover(db, 'p1', cover, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(value(await getCover(db))).toBeNull();
  });
});

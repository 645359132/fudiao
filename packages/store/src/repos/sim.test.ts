import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { sqlEventStore } from '../sql-event-store';
import { createChapter } from './chapter';
import {
  createSimRun,
  createSimScene,
  getSimRun,
  getSimScene,
  listSimRuns,
  listSimScenes,
  listSimSnapshots,
  saveSimSnapshot,
  setSimRunProgress,
  updateSimScene,
  type SimSceneFields,
} from './sim';

const ctx = { now: '2026-10-13T00:00:00.000Z' };
const later = { now: '2026-10-13T01:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-sim-'));
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
  value(await createChapter(r.value.db, { id: 'c1', title: '第一章' }, ctx));
  return r.value.db;
}

const fields: SimSceneFields = { chapterId: 'c1', title: ' 当铺谈判 ', config: { zones: [{ id: 'shop', name: '当铺' }] }, protocol: 'turn_based', maxRounds: 8, firstSpeaker: 'lin_zhou' };

describe('推演场景', () => {
  it('新建与读取；场景名去掉首尾空白', async () => {
    const db = await fresh();
    const scene = value(await createSimScene(db, { id: 's1', ...fields }, ctx));
    expect(scene).toMatchObject({ id: 's1', chapterId: 'c1', title: '当铺谈判', config: fields.config, configVersion: 1, protocol: 'turn_based', maxRounds: 8, firstSpeaker: 'lin_zhou', version: 1 });
    expect(value(await getSimScene(db, 's1'))).toEqual(scene);
    expect(value(await getSimScene(db, 'none'))).toBeNull();
    value(await createSimScene(db, { id: 's2', ...fields, chapterId: null, title: '仓库' }, later));
    expect(value(await listSimScenes(db)).map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('修改：场景配置变了配置版本才加一；版本不符时冲突', async () => {
    const db = await fresh();
    const scene = value(await createSimScene(db, { id: 's1', ...fields }, ctx));
    const renamed = value(await updateSimScene(db, scene, { ...fields, title: '当铺夜谈', maxRounds: 6 }, later));
    expect(renamed).toMatchObject({ title: '当铺夜谈', maxRounds: 6, configVersion: 1, version: 2 });
    const changed = value(await updateSimScene(db, renamed, { ...fields, config: { zones: [] } }, later));
    expect(changed).toMatchObject({ config: { zones: [] }, configVersion: 2, version: 3 });
    expect(await updateSimScene(db, scene, fields, later)).toEqual({ ok: false, error: { code: 'conflict' } });
  });

  it('场景名为空、回合上限不是正整数时拒绝', async () => {
    const db = await fresh();
    expect(await createSimScene(db, { id: 's1', ...fields, title: '  ' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await createSimScene(db, { id: 's1', ...fields, maxRounds: 0 }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(value(await listSimScenes(db))).toEqual([]);
  });
});

describe('推演运行', () => {
  it('登记运行时带上当时的场景配置；场景之后再改，运行里的配置不变', async () => {
    const db = await fresh();
    const scene = value(await createSimScene(db, { id: 's1', ...fields }, ctx));
    const run = value(await createSimRun(db, { id: 'r1', sceneId: 's1', sceneConfig: scene.config, sceneConfigVersion: scene.configVersion, mode: 'auto' }, ctx));
    expect(run).toMatchObject({ id: 'r1', sceneId: 's1', sceneConfig: fields.config, sceneConfigVersion: 1, mode: 'auto', status: 'created', round: 0, lastSeq: 0, parentRunId: null, branchFromSeq: null });
    value(await updateSimScene(db, scene, { ...fields, config: { zones: [] } }, later));
    expect(value(await getSimRun(db, 'r1'))?.sceneConfig).toEqual(fields.config);
  });

  it('进度写回运行记录；分支记下来源；按场景列出，新的在前', async () => {
    const db = await fresh();
    const scene = value(await createSimScene(db, { id: 's1', ...fields }, ctx));
    const base = { sceneId: 's1', sceneConfig: scene.config, sceneConfigVersion: 1, mode: 'interactive' as const };
    value(await createSimRun(db, { id: 'r1', ...base }, ctx));
    value(await sqlEventStore(db).append('r1', 0, [{ type: 'RunStarted' }, { type: 'RoundStarted' }], ctx.now));
    expect(value(await setSimRunProgress(db, 'r1', { status: 'paused', endReason: null, pauseReason: 'author', round: 1 }, later))).toMatchObject({ status: 'paused', pauseReason: 'author', round: 1, lastSeq: 2 });
    expect(value(await setSimRunProgress(db, 'r1', { status: 'ended', endReason: 'max_rounds', pauseReason: null, round: 8 }, later))).toMatchObject({ status: 'ended', endReason: 'max_rounds', pauseReason: null });
    expect(await setSimRunProgress(db, 'none', { status: 'running', endReason: null, pauseReason: null, round: 1 }, later)).toEqual({ ok: false, error: { code: 'not_found' } });

    const fork = value(await createSimRun(db, { id: 'r2', ...base, batchId: 'b1', parent: { runId: 'r1', seq: 2 } }, later));
    expect(fork).toMatchObject({ parentRunId: 'r1', branchFromSeq: 2, batchId: 'b1' });
    expect(value(await listSimRuns(db, 's1')).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(value(await listSimRuns(db, 'other'))).toEqual([]);
  });

  it('状态快照：同一序号只记一次，必须对应已有的事件', async () => {
    const db = await fresh();
    const scene = value(await createSimScene(db, { id: 's1', ...fields }, ctx));
    value(await createSimRun(db, { id: 'r1', sceneId: 's1', sceneConfig: scene.config, sceneConfigVersion: 1, mode: 'auto' }, ctx));
    value(await sqlEventStore(db).append('r1', 0, [{ type: 'RunStarted' }], ctx.now));
    value(await saveSimSnapshot(db, { runId: 'r1', seq: 1, state: { round: 0 }, stateHash: 'h0' }, ctx));
    value(await saveSimSnapshot(db, { runId: 'r1', seq: 1, state: { round: 9 }, stateHash: 'other' }, later));
    expect(value(await listSimSnapshots(db, 'r1'))).toEqual([{ runId: 'r1', seq: 1, state: { round: 0 }, stateHash: 'h0', createdAt: ctx.now }]);
    expect(await saveSimSnapshot(db, { runId: 'r1', seq: 5, state: {}, stateHash: 'h' }, ctx)).toMatchObject({ ok: false });
  });
});

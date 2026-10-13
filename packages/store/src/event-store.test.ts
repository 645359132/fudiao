import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EventStore } from './event-store';
import { memoryEventStore } from './memory';
import { jsonlCallLog, jsonlEventStore } from './node/jsonl';
import { loadMigrations, openProjectDb, type ProjectDb } from './node/sqlite';
import { sqlEventStore } from './sql-event-store';

const AT = '2026-10-07T00:00:00.000Z';
const root = mkdtempSync(join(tmpdir(), 'fudiao-store-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

/** 一个空的作品库，带一个推演场景。 */
function projectDb(): ProjectDb {
  const result = openProjectDb(join(root, `db${opened.length}`), { migrations: loadMigrations(), now: AT });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  opened.push(result.value.db);
  return result.value.db;
}

async function addScene(db: ProjectDb): Promise<void> {
  const done = await db.transaction([
    { sql: "INSERT INTO sim_scene (id, title, config, protocol, max_rounds, created_at, updated_at) VALUES ('scene', '场景', '{}', 'turn_based', 4, ?, ?)", params: [AT, AT] },
  ]);
  if (!done.ok) throw new Error(JSON.stringify(done.error));
}

async function addRun(db: ProjectDb, runId: string): Promise<void> {
  const done = await db.transaction([
    {
      sql: "INSERT OR IGNORE INTO sim_run (id, scene_id, scene_config, scene_config_version, mode, created_at, updated_at) VALUES (?, 'scene', '{}', 1, 'auto', ?, ?)",
      params: [runId, AT, AT],
    },
  ]);
  if (!done.ok) throw new Error(JSON.stringify(done.error));
}

/** 契约测试里的运行没有事先登记：追加前补上运行记录，其余原样交给 SQLite 实现。 */
function sqliteSubject(): EventStore {
  const db = projectDb();
  const inner = sqlEventStore(db);
  const ready = addScene(db);
  return {
    async append(runId, expectedSeq, payloads, at) {
      await ready;
      await addRun(db, runId);
      return inner.append(runId, expectedSeq, payloads, at);
    },
    read: (runId) => inner.read(runId),
    runs: () => inner.runs(),
  };
}

let n = 0;
const subjects: [string, () => EventStore][] = [
  ['内存', () => memoryEventStore()],
  ['JSONL 文件', () => jsonlEventStore(join(root, `s${n++}`))],
  ['SQLite ', sqliteSubject],
];

describe.each(subjects)('%s事件存储', (_name, make) => {
  it('按批次追加，序号从 1 连续递增', async () => {
    const store = make();
    expect(await store.append('run1', 0, [{ type: 'A' }, { type: 'B' }], AT)).toEqual({ ok: true, value: 2 });
    expect(await store.append('run1', 2, [{ type: 'C' }], AT)).toEqual({ ok: true, value: 3 });
    const events = await store.read('run1');
    expect(events.map((e) => [e.seq, e.payload, e.batch])).toEqual([
      [1, { type: 'A' }, { first: 1, index: 0, size: 2 }],
      [2, { type: 'B' }, { first: 1, index: 1, size: 2 }],
      [3, { type: 'C' }, { first: 3, index: 0, size: 1 }],
    ]);
    expect(events.every((e) => e.runId === 'run1' && e.at === AT)).toBe(true);
  });

  it('序号不一致时返回冲突，不写入', async () => {
    const store = make();
    await store.append('run1', 0, [{ type: 'A' }], AT);
    expect(await store.append('run1', 0, [{ type: 'B' }], AT)).toEqual({
      ok: false,
      error: { code: 'seq_conflict', expected: 0, actual: 1 },
    });
    expect(await store.read('run1')).toHaveLength(1);
  });

  it('各次运行分开保存', async () => {
    const store = make();
    await store.append('b', 0, [1], AT);
    await store.append('a', 0, [2], AT);
    expect(await store.runs()).toEqual(['a', 'b']);
    expect(await store.read('missing')).toEqual([]);
  });

  it('写入后修改调用方的对象不影响记录', async () => {
    const store = make();
    const payload = { type: 'A', list: [1] };
    await store.append('run1', 0, [payload], AT);
    payload.list.push(2);
    expect((await store.read('run1'))[0]?.payload).toEqual({ type: 'A', list: [1] });
  });
});

describe('SQLite 事件存储', () => {
  async function ready(...runs: string[]) {
    const db = projectDb();
    await addScene(db);
    for (const run of runs) await addRun(db, run);
    return { db, store: sqlEventStore(db) };
  }

  it('调用方读到的序号落后或超前都是冲突，一条也不写', async () => {
    const { store } = await ready('run1');
    await store.append('run1', 0, [{ type: 'A' }, { type: 'B' }], AT);
    expect(await store.append('run1', 1, [{ type: 'C' }], AT)).toEqual({ ok: false, error: { code: 'seq_conflict', expected: 1, actual: 2 } });
    expect(await store.append('run1', 5, [{ type: 'C' }, { type: 'D' }], AT)).toEqual({ ok: false, error: { code: 'seq_conflict', expected: 5, actual: 2 } });
    expect((await store.read('run1')).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('两个写入者同时追加：只有一个成功，另一个得到冲突，没有交错的批次', async () => {
    const { store } = await ready('run1');
    await store.append('run1', 0, [{ type: 'Start' }], AT);
    const results = await Promise.all([store.append('run1', 1, [{ by: 'a' }, { by: 'a' }], AT), store.append('run1', 1, [{ by: 'b' }, { by: 'b' }, { by: 'b' }], AT)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: { code: 'seq_conflict', expected: 1 } });
    const written = (await store.read('run1')).slice(1);
    expect(new Set(written.map((e) => (e.payload as { by: string }).by)).size).toBe(1);
    expect(written.every((e, i) => e.seq === i + 2 && e.batch.first === 2 && e.batch.index === i && e.batch.size === written.length)).toBe(true);
  });

  it('事件的类型与行动者写进查询用的列，运行记录上的最后序号随之更新', async () => {
    const { db, store } = await ready('run1', 'run2');
    await store.append('run1', 0, [{ type: 'RunStarted' }, { type: 'ProposalSubmitted', actor: 'lin_zhou' }, '没有类型'], AT);
    const rows = await db.query("SELECT seq, type, actor FROM sim_event WHERE run_id = 'run1' ORDER BY seq");
    expect(rows.ok && rows.value).toEqual([
      { seq: 1, type: 'RunStarted', actor: null },
      { seq: 2, type: 'ProposalSubmitted', actor: 'lin_zhou' },
      { seq: 3, type: null, actor: null },
    ]);
    const runs = await db.query('SELECT id, last_seq FROM sim_run ORDER BY id');
    expect(runs.ok && runs.value).toEqual([
      { id: 'run1', last_seq: 3 },
      { id: 'run2', last_seq: 0 },
    ]);
    // 只列出有事件的运行。
    expect(await store.runs()).toEqual(['run1']);
  });

  it('没有登记的运行不能追加事件；空的一批不写任何东西', async () => {
    const { store } = await ready('run1');
    await expect(store.append('unknown', 0, [{ type: 'A' }], AT)).rejects.toThrow('推演事件没有写入');
    expect(await store.append('run1', 0, [], AT)).toEqual({ ok: true, value: 0 });
    expect(await store.append('run1', 2, [], AT)).toEqual({ ok: false, error: { code: 'seq_conflict', expected: 2, actual: 0 } });
    expect(await store.read('run1')).toEqual([]);
  });

  it('关闭作品库后重新打开，事件原样读回', async () => {
    const dir = join(root, 'reopen');
    const first = openProjectDb(dir, { migrations: loadMigrations(), now: AT });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    await addScene(first.value.db);
    await addRun(first.value.db, 'run1');
    await sqlEventStore(first.value.db).append('run1', 0, [{ type: 'A', nested: { list: [1, '二'] } }, { type: 'B' }], AT);
    first.value.db.close();

    const second = openProjectDb(dir, { migrations: loadMigrations(), now: AT });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    opened.push(second.value.db);
    const store = sqlEventStore(second.value.db);
    expect(await store.read('run1')).toEqual([
      { runId: 'run1', seq: 1, at: AT, batch: { first: 1, index: 0, size: 2 }, payload: { type: 'A', nested: { list: [1, '二'] } } },
      { runId: 'run1', seq: 2, at: AT, batch: { first: 1, index: 1, size: 2 }, payload: { type: 'B' } },
    ]);
    expect(await store.append('run1', 2, [{ type: 'C' }], AT)).toEqual({ ok: true, value: 3 });
  });
});

describe('JSONL 文件的崩溃恢复', () => {
  it('末尾不完整的批次与写到一半的行被丢弃，之后的追加接在最后一个完整批次之后', async () => {
    const dir = join(root, 'crash');
    const store = jsonlEventStore(dir);
    await store.append('run1', 0, [{ type: 'A' }], AT);
    const file = join(dir, 'run1', 'events.jsonl');
    // 模拟崩溃：一批三条只写进了一条完整的行和半行。
    const partial = { runId: 'run1', seq: 2, at: AT, batch: { first: 2, index: 0, size: 3 }, payload: { type: 'B' } };
    appendFileSync(file, `${JSON.stringify(partial)}\n{"runId":"run1","seq":3,"at`);

    expect((await store.read('run1')).map((e) => e.seq)).toEqual([1]);
    expect(await store.append('run1', 1, [{ type: 'C' }], AT)).toEqual({ ok: true, value: 2 });
    expect((await store.read('run1')).map((e) => e.payload)).toEqual([{ type: 'A' }, { type: 'C' }]);
    expect(readFileSync(file, 'utf8')).not.toContain('"type":"B"');
  });
});

describe('JSONL 调用记录', () => {
  it('只返回最近一次完成的记录，失败与取消的不算', async () => {
    const log = jsonlCallLog(join(root, 'calls'), 'run1');
    const base = {
      stepKey: 's1',
      requestHash: 'h',
      task: 'character_action' as const,
      provider: 'p',
      model: 'm',
      templateId: 't',
      templateVersion: '1',
      params: { maxOutputTokens: 10 },
      cost: null,
      startedAt: AT,
      finishedAt: AT,
    };
    await log.append({ ...base, status: 'error', error: { code: 'server', message: '500' } });
    expect(await log.findCompleted('s1')).toBeUndefined();
    await log.append({ ...base, status: 'cancelled' });
    expect(await log.findCompleted('s1')).toBeUndefined();
    await log.append({ ...base, status: 'completed' });
    expect(await log.findCompleted('s1')).toMatchObject({ status: 'completed' });
    expect(await log.findCompleted('s2')).toBeUndefined();
  });
});

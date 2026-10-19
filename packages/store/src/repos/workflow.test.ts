import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { abandonWorkflowRun, createWorkflowRun, getWorkflowRun, interruptRunningSteps, listWorkflowRuns, updateWorkflowStep, updateWorkflowSteps } from './workflow';

const ctx = { now: '2026-10-19T00:00:00.000Z' };
const later = { now: '2026-10-19T01:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-workflow-'));
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

const input = { id: '01W1', workflow: 'quick_book', title: '一键成书', params: { idea: '当铺夜遇旧主', chapters: 6 }, mode: 'step' as const, budgetUsd: 0.5, steps: ['model', 'seed', 'plan'] };

describe('写作工作流的仓储', () => {
  it('新建一次运行时步骤都为待做，按顺序读回；参数原样保存', async () => {
    const db = fresh();
    const created = value(await createWorkflowRun(db, input, ctx));
    expect(created.run).toMatchObject({ id: '01W1', workflow: 'quick_book', params: { idea: '当铺夜遇旧主', chapters: 6 }, mode: 'step', budgetUsd: 0.5, abandoned: false });
    expect(created.steps.map((s) => [s.idx, s.key, s.status, s.attempt, s.output])).toEqual([
      [0, 'model', 'pending', 0, null],
      [1, 'seed', 'pending', 0, null],
      [2, 'plan', 'pending', 0, null],
    ]);
  });

  it('没有步骤、步骤的键重复或预算不大于 0 时不建', async () => {
    const db = fresh();
    expect(await createWorkflowRun(db, { ...input, steps: [] }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await createWorkflowRun(db, { ...input, steps: ['a', 'a'] }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await createWorkflowRun(db, { ...input, budgetUsd: 0 }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(value(await listWorkflowRuns(db))).toEqual([]);
  });

  it('修改一步：结果、用量与改动存为 JSON 读回相同；版本不符时报冲突；null 清空', async () => {
    const db = fresh();
    const { steps } = value(await createWorkflowRun(db, input, ctx));
    const seed = steps[1]!;
    const changed = value(
      await updateWorkflowStep(
        db,
        seed,
        {
          status: 'awaiting_author',
          output: { title: '夜当', characters: [{ name: '沈砚' }] },
          attempt: 1,
          note: '等你看',
          usage: { input: 100, output: 50, cost: 0.001, unknown: 0 },
          startedAt: ctx.now,
          finishedAt: later.now,
        },
        later,
      ),
    );
    expect(changed).toMatchObject({
      status: 'awaiting_author',
      output: { title: '夜当', characters: [{ name: '沈砚' }] },
      attempt: 1,
      note: '等你看',
      usage: { input: 100, output: 50, cost: 0.001, unknown: 0 },
      version: 2,
      updatedAt: later.now,
    });
    expect(await updateWorkflowStep(db, seed, { status: 'done' }, later)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const cleared = value(await updateWorkflowStep(db, changed, { output: null, changes: [{ kind: 'project' }], edited: true }, later));
    expect(cleared).toMatchObject({ output: null, changes: [{ kind: 'project' }], edited: true });
  });

  it('同时改几步在一个事务里：有一步版本不符时都不改', async () => {
    const db = fresh();
    const { steps } = value(await createWorkflowRun(db, input, ctx));
    const outdated = { ...steps[2]!, version: 9 };
    expect(
      await updateWorkflowSteps(
        db,
        '01W1',
        [
          { step: steps[0]!, patch: { status: 'done' } },
          { step: outdated, patch: { status: 'stale' } },
        ],
        later,
      ),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(value(await getWorkflowRun(db, '01W1'))?.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
    const both = value(
      await updateWorkflowSteps(
        db,
        '01W1',
        [
          { step: steps[0]!, patch: { status: 'done' } },
          { step: steps[2]!, patch: { status: 'stale' } },
        ],
        later,
      ),
    );
    expect(both.steps.map((s) => s.status)).toEqual(['done', 'pending', 'stale']);
  });

  it('打开作品时把进行中的步骤改为中断；放弃运行后仍可读出', async () => {
    const db = fresh();
    const { run, steps } = value(await createWorkflowRun(db, input, ctx));
    value(await updateWorkflowStep(db, steps[0]!, { status: 'running' }, ctx));
    expect(value(await interruptRunningSteps(db, later))).toBe(1);
    expect(value(await getWorkflowRun(db, run.id))?.steps[0]?.status).toBe('interrupted');
    expect(value(await interruptRunningSteps(db, later))).toBe(0);
    expect(value(await abandonWorkflowRun(db, run, later))).toMatchObject({ abandoned: true, version: 2 });
    expect(value(await listWorkflowRuns(db)).map((r) => r.id)).toEqual(['01W1']);
    expect(value(await getWorkflowRun(db, 'none'))).toBeNull();
  });
});

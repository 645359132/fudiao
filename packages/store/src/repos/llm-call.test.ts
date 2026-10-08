import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { appendLlmCall, findCompletedCall, listLlmCalls, usageSummary, type LlmCallRow } from './llm-call';

const root = mkdtempSync(join(tmpdir(), 'fudiao-calls-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fresh(): ProjectDb {
  const result = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: '2026-10-08T00:00:00.000Z' });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  opened.push(result.value.db);
  return result.value.db;
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

let n = 0;
const call = (patch: Partial<LlmCallRow>): LlmCallRow => {
  n++;
  return {
    id: `c${String(n).padStart(3, '0')}`,
    stepKey: null,
    taskKind: 'selection_edit',
    provider: 'p1',
    model: 'm1',
    servedModel: 'm1',
    params: { maxOutputTokens: 1_000 },
    templateId: 'selection_edit',
    templateVersion: '1',
    requestHash: `h${n}`,
    status: 'completed',
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    cost: 0.001,
    response: { text: '好' },
    error: null,
    startedAt: `2026-10-08T00:00:${String(n).padStart(2, '0')}.000Z`,
    finishedAt: `2026-10-08T00:00:${String(n).padStart(2, '0')}.500Z`,
    ...patch,
  };
};

describe('模型调用记录', () => {
  it('写入并读回；步骤只复用已完成（完成、截断、拒答）的最近一次记录', async () => {
    const db = fresh();
    const failed = call({ stepKey: 's1', status: 'error', usage: null, cost: null, response: null, error: { code: 'network' }, servedModel: null });
    value(await appendLlmCall(db, failed));
    expect(value(await findCompletedCall(db, 's1'))).toBeNull();
    const first = call({ stepKey: 's1' });
    value(await appendLlmCall(db, first));
    const second = call({ stepKey: 's1', status: 'refused', response: { text: '', refusal: true } });
    value(await appendLlmCall(db, second));
    value(await appendLlmCall(db, call({ stepKey: 's1', status: 'cancelled' })));
    expect(value(await findCompletedCall(db, 's1'))).toEqual(second);
    expect(value(await listLlmCalls(db, 2)).map((c) => c.status)).toEqual(['cancelled', 'refused']);
    expect(value(await listLlmCalls(db)).at(-1)).toEqual(failed);
  });

  it('用量汇总：全部、按任务、按模型；费用未知的调用单独计数，失败的调用不算', async () => {
    const db = fresh();
    value(await appendLlmCall(db, call({ cost: 0.002, usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0 } })));
    value(await appendLlmCall(db, call({ taskKind: 'candidate_text', cost: null })));
    value(await appendLlmCall(db, call({ model: 'm2', status: 'error', usage: null, cost: null, response: null, error: { code: 'auth' } })));
    const summary = value(await usageSummary(db));
    expect(summary.total).toEqual({ calls: 3, inputTokens: 200, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 0, cost: 0.002, unknownCost: 1 });
    expect(summary.byTask.map((t) => [t.task, t.calls, t.unknownCost])).toEqual([
      ['candidate_text', 1, 1],
      ['selection_edit', 2, 0],
    ]);
    expect(summary.byModel.map((m) => [m.model, m.calls, m.inputTokens])).toEqual([
      ['m1', 2, 200],
      ['m2', 1, 0],
    ]);
    expect(value(await usageSummary(fresh())).total).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, unknownCost: 0 });
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { appendLlmCall, findCompletedCall, listLlmCalls, listRunCalls, mayBeBilled, usageSummary, type LlmCallRow } from './llm-call';

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
    costEstimate: null,
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
    expect(summary.total).toEqual({ calls: 3, inputTokens: 200, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 0, cost: 0.002, unknownCost: 1, estimatedCalls: 0, estimatedCost: 0 });
    expect(summary.byTask.map((t) => [t.task, t.calls, t.unknownCost])).toEqual([
      ['candidate_text', 1, 1],
      ['selection_edit', 2, 0],
    ]);
    expect(summary.byModel.map((m) => [m.model, m.calls, m.inputTokens])).toEqual([
      ['m1', 2, 200],
      ['m2', 1, 0],
    ]);
    expect(value(await usageSummary(fresh())).total).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, unknownCost: 0, estimatedCost: 0, estimatedCalls: 0 });
  });

  it('没有用量的调用按估计计入，单独列出；服务已经开始回复后失败的调用可能已计费，算作费用未知', async () => {
    const db = fresh();
    value(await appendLlmCall(db, call({ cost: 0.002 })));
    // 服务没有返回用量：费用未知，按请求的最坏估计记下。
    const noUsage = call({ usage: null, cost: null, costEstimate: 0.03 });
    value(await appendLlmCall(db, noUsage));
    // 读到一半断线：带部分用量与估计。
    const broken = call({ status: 'error', usage: { input: 300, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: null, costEstimate: 0.05, response: null, error: { code: 'network', message: '断开', partial: { usage: null } } });
    value(await appendLlmCall(db, broken));
    // 价格未配置、又没有用量的断线：费用未知，没有估计。
    value(await appendLlmCall(db, call({ status: 'error', usage: null, cost: null, response: null, error: { code: 'network', partial: { usage: null } } })));
    // 还没收到回复就失败：不可能计费，不算费用未知。
    value(await appendLlmCall(db, call({ status: 'error', usage: null, cost: null, response: null, error: { code: 'auth' } })));
    expect(value(await usageSummary(db)).total).toEqual({
      calls: 5,
      inputTokens: 400,
      outputTokens: 21,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.002,
      unknownCost: 3,
      estimatedCost: 0.08,
      estimatedCalls: 2,
    });
    const recent = value(await listLlmCalls(db));
    expect(recent.find((c) => c.id === broken.id)).toEqual(broken);
    expect(recent.map(mayBeBilled)).toEqual([false, true, true, true, true]);
  });

  it('一次推演运行的调用带上估计值与是否可能计费', async () => {
    const db = fresh();
    value(await appendLlmCall(db, call({ stepKey: 'run1:1:a', cost: 0.002 })));
    value(await appendLlmCall(db, call({ stepKey: 'run1:1:b', usage: null, cost: null, costEstimate: 0.03 })));
    value(await appendLlmCall(db, call({ stepKey: 'run1:1:c', status: 'error', usage: null, cost: null, response: null, error: { code: 'network', partial: { usage: null } }, costEstimate: 0.05 })));
    value(await appendLlmCall(db, call({ stepKey: 'run1:1:d', status: 'error', usage: null, cost: null, response: null, error: { code: 'auth' } })));
    value(await appendLlmCall(db, call({ stepKey: 'run2:1:a', cost: 1 })));
    expect(value(await listRunCalls(db, 'run1')).map((c) => [c.stepKey, c.cost, c.costEstimate, c.billed])).toEqual([
      ['run1:1:a', 0.002, null, true],
      ['run1:1:b', null, 0.03, true],
      ['run1:1:c', null, 0.05, true],
      ['run1:1:d', null, null, false],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetGuard, costOf, estimateInputTokens, withBudget, worstCase } from './budget';
import { memoryCallLog, withCallLog } from './call-log';
import { inspectRequests } from './inspect';
import { routeByProvider } from './router';
import { memorySamples, RecordingAdapter, ReplayAdapter } from './replay';
import { requestHash } from './request-hash';
import { parseModelJson, partialStringField, structured } from './structured';
import { baseRequest, scriptedPort, usage } from './testing/scripted-port';
import type { LlmStreamEvent } from './types';

describe('录制与回放', () => {
  it('录制后回放得到相同的结果与文本片段，不调用模型', async () => {
    const samples = memorySamples();
    const { port, requests } = scriptedPort([{ text: '{"kind":"wait"}' }]);
    const recorded = await new RecordingAdapter(port, samples).complete(baseRequest());
    expect(samples.all()).toHaveLength(1);

    const events: LlmStreamEvent[] = [];
    const replayed = await new ReplayAdapter(samples).complete(baseRequest(), { onEvent: (e) => events.push(e) });
    expect(replayed).toEqual(recorded);
    expect(events).toContainEqual({ type: 'text', delta: '{"kind":"wait"}' });
    expect(requests).toHaveLength(1);
  });

  it('样本只按请求哈希匹配，与步骤键无关', async () => {
    const samples = memorySamples();
    await new RecordingAdapter(scriptedPort([{ text: 'x' }]).port, samples).complete(baseRequest({ stepKey: 'run-a' }));
    const replayed = await new ReplayAdapter(samples).complete(baseRequest({ stepKey: 'run-b' }));
    expect(replayed.ok).toBe(true);
  });

  it('找不到样本时报错，不会悄悄联网', async () => {
    const result = await new ReplayAdapter(memorySamples()).complete(baseRequest());
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'replay_missing' }) });
  });

  it('模板版本变化后旧样本不再匹配', async () => {
    const samples = memorySamples();
    await new RecordingAdapter(scriptedPort([{ text: 'x' }]).port, samples).complete(baseRequest());
    const result = await new ReplayAdapter(samples).complete(baseRequest({ template: { id: 'character_action', version: '2' } }));
    expect(result.ok).toBe(false);
  });

  it('取消的调用不录制', async () => {
    const samples = memorySamples();
    await new RecordingAdapter(scriptedPort([{ text: '{"ki', outcome: 'cancelled' }]).port, samples).complete(baseRequest());
    expect(samples.all()).toEqual([]);
  });
});

describe('parseModelJson', () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['好的，结果如下：\n{"a":[1,2,],}\n以上。', { a: [1, 2] }],
    ['[{"a":1}]', [{ a: 1 }]],
  ])('修复常见格式错误：%j', (text, expected) => {
    expect(parseModelJson(text)).toEqual({ ok: true, value: expected });
  });

  it('无法修复时返回错误', () => {
    expect(parseModelJson('我拒绝回答').ok).toBe(false);
  });
});

describe('partialStringField', () => {
  // 引号、反斜杠、换行与控制字符、成对与落单的代理项、像键名的文字。
  const MESSAGES = ['', '好的', '他说："走吧。"', 'C:\\书稿\\第一章', '第一行\n第二行\t缩进\r\u0001', '雨😀夜', '\ud83d落单', '"message":"假的"', '\\"\\\\'];

  it.each(MESSAGES.flatMap((m) => [[m, false] as const, [m, true] as const]))('流式到达的每一段前缀，读出的都是完整值的前缀；到齐时就是完整值：%j', (message, actionsFirst) => {
    const full = JSON.stringify(actionsFirst ? { actions: [{ tool: 'x', message: null }], message, done: true } : { message, actions: [], done: true });
    for (let n = 0; n <= full.length; n++) {
      const got = partialStringField(full.slice(0, n), 'message');
      if (got !== null) expect(message.startsWith(got)).toBe(true);
    }
    expect(partialStringField(full, 'message')).toBe(message);
  });

  it('字段还没出现时为 null；转义按 JSON 的规则还原', () => {
    expect(partialStringField('{"mess', 'message')).toBeNull();
    expect(partialStringField(String.raw`{"message": "第一行\n第二行\"引号\"中`, 'message')).toBe('第一行\n第二行"引号"中');
    expect(partialStringField(String.raw`{"message":"半个转义\u4e`, 'message')).toBe('半个转义');
    expect(partialStringField('{"message":"末尾一个反斜杠\\', 'message')).toBe('末尾一个反斜杠');
  });
});

describe('结构化输出管线', () => {
  const Action = z.object({ kind: z.enum(['wait', 'move']), rationale: z.string() });
  const repairMessage = (issues: readonly string[]) => `修正：${issues.join('；')}`;

  it('通过校验时直接返回', async () => {
    const { port } = scriptedPort([{ text: '{"kind":"wait","rationale":"观望"}' }]);
    const result = await structured(port, Action, baseRequest(), { maxRepairs: 2, repairMessage });
    expect(result.ok && result.value.value).toEqual({ kind: 'wait', rationale: '观望' });
    expect(result.ok && result.value.attempts).toHaveLength(1);
  });

  it('校验失败时带着错误信息请求修正，修正调用计入记录', async () => {
    const { port, requests } = scriptedPort([
      { text: '{"kind":"run"}' },
      { text: '{"kind":"move","rationale":"靠近南门"}' },
    ]);
    const result = await structured(port, Action, baseRequest({ stepKey: 's1' }), { maxRepairs: 2, repairMessage });
    expect(result.ok && result.value.value.kind).toBe('move');
    expect(result.ok && result.value.attempts).toHaveLength(2);
    const repair = requests[1]!;
    expect(repair.stepKey).toBe('s1#repair1');
    expect(repair.messages.at(-2)).toEqual({ role: 'assistant', content: '{"kind":"run"}' });
    expect(repair.messages.at(-1)?.content).toMatch(/^修正：kind: .*；rationale: /);
    expect(repair.repairOf).toEqual([expect.stringMatching(/^kind: /), expect.stringMatching(/^rationale: /)]);
    expect(requests[0]?.repairOf).toBeUndefined();
  });

  it('修正调用在调用记录中写明上一次输出未通过校验的原因', async () => {
    const log = memoryCallLog();
    const { port } = scriptedPort([{ text: '{"kind":"run"}' }, { text: '{"kind":"move","rationale":"靠近南门"}' }]);
    await structured(withCallLog(port, log, () => '2026-10-09T00:00:00.000Z'), Action, baseRequest({ stepKey: 's1' }), { maxRepairs: 2, repairMessage });
    expect(log.records().map((r) => [r.stepKey, r.repairIssues])).toEqual([
      ['s1', undefined],
      ['s1#repair1', [expect.stringMatching(/^kind: /), expect.stringMatching(/^rationale: /)]],
    ]);
  });

  it('修正原因不计入请求哈希（原因已在修正消息中），录制回放样本照常匹配', () => {
    expect(requestHash(baseRequest({ repairOf: ['kind: 无效'] }))).toBe(requestHash(baseRequest({})));
  });

  it('超过修正次数时返回 invalid_output 与最后的错误', async () => {
    const { port, requests } = scriptedPort([{ text: 'not json' }]);
    const result = await structured(port, Action, baseRequest(), { maxRepairs: 2, repairMessage });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid_output', issues: [expect.any(String)] }),
    });
    expect(requests).toHaveLength(3);
  });

  it('拒答、截断与取消不请求修正', async () => {
    for (const outcome of ['refused', 'truncated', 'cancelled'] as const) {
      const { port, requests } = scriptedPort([{ text: '{', outcome }]);
      const result = await structured(port, Action, baseRequest(), { maxRepairs: 2, repairMessage });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: outcome }) });
      expect(requests).toHaveLength(1);
    }
  });

  it('调用失败时返回 call_failed', async () => {
    const { port } = scriptedPort([{ code: 'server', message: '500' }]);
    const result = await structured(port, Action, baseRequest(), { maxRepairs: 2, repairMessage });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'call_failed' }) });
  });
});

describe('预算守卫', () => {
  it('按价格表计算费用，含缓存读取', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }, { input: 4, output: 20, cacheRead: 0.2 })).toBeCloseTo(4 + 2 + 0.2);
  });

  it('价格或用量未知时费用为未知', () => {
    expect(costOf(usage(1, 1), undefined)).toBeNull();
    expect(costOf(null, { input: 1, output: 1 })).toBeNull();
  });

  it('估算输入规模时计入系统提示、消息与输出格式', () => {
    const small = estimateInputTokens(baseRequest());
    const large = estimateInputTokens(baseRequest({ messages: [{ role: 'user', content: '字'.repeat(1000) }] }));
    expect(large - small).toBeGreaterThanOrEqual(990);
  });

  it('累计费用将超过预算时停止发起新调用，保留已完成的结果', async () => {
    const { port, requests } = scriptedPort([{ text: 'a', usage: usage(1_000, 1_000) }]);
    // 每次约 1000 输入 + 1000 输出 = 0.004 + 0.02 美元；预估按最大输出计。
    const guard = new BudgetGuard({ limitUsd: 0.05 });
    const guarded = withBudget(port, guard);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await guarded.complete(baseRequest()));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.at(-1)).toEqual({ ok: false, error: expect.objectContaining({ code: 'budget_exceeded' }) });
    expect(requests).toHaveLength(2);
    expect(guard.spentUsd).toBeCloseTo(0.048);
  });

  it('价格未知时按 Token 数限制', async () => {
    const { port, requests } = scriptedPort([{ text: 'a', usage: usage(1_000, 1_000) }]);
    const guarded = withBudget(port, new BudgetGuard({ limitTokens: 2_500 }));
    const request = baseRequest({ model: { ...baseRequest().model, prices: undefined as never } });
    for (let i = 0; i < 4; i++) await guarded.complete(request);
    expect(requests).toHaveLength(1);
  });

  // 一次调用的最坏估计：输入 5 字（“规则”“行动？”）按 5 Token、输出按上限 1,000，约 0.02002 美元。
  const worst = (5 * 4 + 1_000 * 20) / 1_000_000;

  it('同时发出的调用：给进行中的调用预留最坏估计，合计不超过预算', async () => {
    const { port, requests } = scriptedPort([{ text: 'a', usage: usage(100, 50) }]);
    const guard = new BudgetGuard({ limitUsd: 0.05 });
    const guarded = withBudget(port, guard);
    const results = await Promise.all(Array.from({ length: 5 }, () => guarded.complete(baseRequest())));
    expect(requests).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.error.code === 'budget_exceeded')).toHaveLength(3);
    // 结束后预留换成实际费用（100 输入、50 输出），之后的调用照常放行。
    expect(guard.spentUsd).toBeCloseTo(2 * 0.0014, 9);
    expect(guard.reservedUsd).toBe(0);
    expect((await guarded.complete(baseRequest())).ok).toBe(true);
  });

  it('同时发出的调用按 Token 数限制时同样预留', async () => {
    const { port, requests } = scriptedPort([{ text: 'a', usage: usage(10, 10) }]);
    const guard = new BudgetGuard({ limitTokens: 2_500 });
    await Promise.all(Array.from({ length: 4 }, () => withBudget(port, guard).complete(baseRequest())));
    expect(requests).toHaveLength(2);
    expect(guard.reservedTokens).toBe(0);
    expect(guard.spentTokens).toBe(40);
  });

  it('失败时释放预留，不计费用', async () => {
    const { port } = scriptedPort([{ code: 'server', message: '500' }]);
    const guard = new BudgetGuard({ limitUsd: 0.05 });
    const results = await Promise.all(Array.from({ length: 2 }, () => withBudget(port, guard).complete(baseRequest())));
    expect(results.every((r) => !r.ok && r.error.code === 'server')).toBe(true);
    expect([guard.spentUsd, guard.reservedUsd, guard.estimatedCalls]).toEqual([0, 0, 0]);
  });

  it('服务没有返回用量时按请求的最坏估计计入已花费，并记为估计', async () => {
    const { port, requests } = scriptedPort([{ text: 'a', usage: null }]);
    const guard = new BudgetGuard({ limitUsd: 0.05 });
    const guarded = withBudget(port, guard);
    for (let i = 0; i < 4; i++) await guarded.complete(baseRequest());
    expect(requests).toHaveLength(2);
    expect(guard.spentUsd).toBeCloseTo(2 * worst, 9);
    expect(guard.estimatedCalls).toBe(2);
    expect(guard.unknownCostCalls).toBe(0);
  });

  it('服务已经开始回复后出错（可能已计费）时同样按估计计入；部分用量已知时输入取实际值', async () => {
    const partial = { inputTokens: 300, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const { port } = scriptedPort([{ code: 'network', message: '断开', partial: { usage: partial } }]);
    const guard = new BudgetGuard({ limitUsd: 1 });
    await withBudget(port, guard).complete(baseRequest());
    expect(guard.spentUsd).toBeCloseTo((300 * 4 + 1_000 * 20) / 1_000_000, 9);
    expect(guard.estimatedCalls).toBe(1);
  });

  it('请求的最坏估计：价格未知时费用为 null，Token 照算', () => {
    expect(worstCase(baseRequest())).toEqual({ tokens: 1_005, usd: expect.closeTo(worst, 9) });
    expect(worstCase(baseRequest({ model: { ...baseRequest().model, prices: undefined as never } }))).toEqual({ tokens: 1_005, usd: null });
  });
});

describe('调用记录与幂等步骤', () => {
  const at = () => '2026-10-07T00:00:00.000Z';

  it('已有完成记录的步骤直接复用，不再调用', async () => {
    const log = memoryCallLog();
    const { port, requests } = scriptedPort([{ text: 'first' }, { text: 'second' }]);
    const logged = withCallLog(port, log, at);
    const a = await logged.complete(baseRequest({ stepKey: 'run1:r1:propose:protagonist:0' }));
    const b = await logged.complete(baseRequest({ stepKey: 'run1:r1:propose:protagonist:0' }));
    expect(b).toEqual(a);
    expect(requests).toHaveLength(1);
    expect(log.records()).toEqual([
      expect.objectContaining({ status: 'completed', templateId: 'character_action', templateVersion: '1', cost: expect.any(Number) }),
    ]);
  });

  it('失败与取消的步骤在恢复时重新调用', async () => {
    const log = memoryCallLog();
    const { port, requests } = scriptedPort([{ code: 'server', message: '500' }, { text: '{', outcome: 'cancelled' }, { text: 'ok' }]);
    const logged = withCallLog(port, log, at);
    for (let i = 0; i < 3; i++) await logged.complete(baseRequest({ stepKey: 's' }));
    expect(requests).toHaveLength(3);
    expect(log.records().map((r) => r.status)).toEqual(['error', 'cancelled', 'completed']);
  });

  it('同一步骤键对应不同的请求时报错，不复用旧结果', async () => {
    const log = memoryCallLog();
    const logged = withCallLog(scriptedPort([{ text: 'x' }]).port, log, at);
    await logged.complete(baseRequest({ stepKey: 's' }));
    const changed = await logged.complete(baseRequest({ stepKey: 's', messages: [{ role: 'user', content: '另一个问题' }] }));
    expect(changed).toEqual({ ok: false, error: expect.objectContaining({ code: 'step_conflict' }) });
  });

  it('没有步骤键的调用同样记录（B36），每次都实际调用', async () => {
    const log = memoryCallLog();
    const { port, requests } = scriptedPort([{ text: 'a' }, { text: 'b' }]);
    const logged = withCallLog(port, log, at);
    await logged.complete(baseRequest({}));
    await logged.complete(baseRequest({}));
    expect(requests).toHaveLength(2);
    expect(log.records().map((r) => [r.stepKey, r.status])).toEqual([
      [null, 'completed'],
      [null, 'completed'],
    ]);
  });

  it('服务没有返回用量时费用为未知，并按请求的最坏估计记下估计值', async () => {
    const log = memoryCallLog();
    await withCallLog(scriptedPort([{ text: 'x', usage: null }]).port, log, at).complete(baseRequest());
    await withCallLog(scriptedPort([{ text: 'x' }]).port, log, at).complete(baseRequest());
    expect(log.records().map((r) => [r.cost === null, r.costEstimate])).toEqual([
      [true, expect.closeTo((5 * 4 + 1_000 * 20) / 1_000_000, 9)],
      [false, null],
    ]);
  });

  it('出错时：服务已经开始回复的记下部分用量与估计（可能已计费），没开始的不记', async () => {
    const log = memoryCallLog();
    const partial = { inputTokens: 300, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await withCallLog(scriptedPort([{ code: 'network', message: '断开', partial: { usage: partial } }]).port, log, at).complete(baseRequest());
    await withCallLog(scriptedPort([{ code: 'auth', message: '401' }]).port, log, at).complete(baseRequest());
    expect(log.records()).toEqual([
      expect.objectContaining({ status: 'error', cost: null, costEstimate: expect.closeTo((300 * 4 + 1_000 * 20) / 1_000_000, 9), error: expect.objectContaining({ partial: { usage: partial } }) }),
      expect.objectContaining({ status: 'error', cost: null, costEstimate: null }),
    ]);
  });

  it('记录中不含系统提示与消息正文之外的凭据', async () => {
    const log = memoryCallLog();
    await withCallLog(scriptedPort([{ text: 'x' }]).port, log, at).complete(baseRequest({ stepKey: 's' }));
    expect(JSON.stringify(log.records())).not.toMatch(/api[-_]?key|authorization/i);
  });
});

describe('请求检查', () => {
  it('在请求发出前调用检查函数，检查失败时不发出请求', async () => {
    const { port, requests } = scriptedPort([{ text: 'x' }]);
    const inspected = inspectRequests(port, (request) => {
      if (JSON.stringify(request).includes('CANARY')) throw new Error('泄露');
    });
    await inspected.complete(baseRequest());
    await expect(inspected.complete(baseRequest({ system: [{ text: 'CANARY-秘密' }] }))).rejects.toThrow('泄露');
    expect(requests).toHaveLength(1);
  });
});

describe('按服务分派', () => {
  it('把请求交给对应服务的适配器，未配置的服务返回错误', async () => {
    const a = scriptedPort([{ text: 'a' }]);
    const b = scriptedPort([{ text: 'b' }]);
    const routed = routeByProvider({ anthropic: a.port, deepseek: b.port });
    const viaA = await routed.complete(baseRequest());
    expect(viaA.ok && viaA.value.text).toBe('a');
    const missing = await routed.complete(baseRequest({ model: { ...baseRequest().model, provider: 'nowhere' } }));
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad_request' }) });
    expect(b.requests).toHaveLength(0);
  });
});

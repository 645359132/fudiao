import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EventStore } from './event-store';
import { memoryEventStore } from './memory';
import { jsonlCallLog, jsonlEventStore } from './node/jsonl';

const AT = '2026-10-07T00:00:00.000Z';
const root = mkdtempSync(join(tmpdir(), 'fudiao-store-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const subjects: [string, () => EventStore][] = [
  ['内存', () => memoryEventStore()],
  ['JSONL 文件', () => jsonlEventStore(join(root, `s${n++}`))],
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

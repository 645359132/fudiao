import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { clearBenchmarkSamples, listBenchmarkSamples, saveBenchmarkSamples } from './benchmark';
import { createWorkflowRun } from './workflow';

const ctx = { now: '2026-10-20T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-benchmark-'));
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
  value(await createWorkflowRun(r.value.db, { id: 'run', workflow: 'benchmark', title: '扫榜拆书', params: {}, mode: 'step', budgetUsd: null, steps: ['import'] }, ctx));
  return r.value.db;
}

const book = (title: string, text = '') => ({ title, author: '', tags: '', words: '', blurb: '', text });

describe('扫榜拆书的样章', () => {
  it('按顺序写入与读出；再写一次时换掉原来的；清除后为空', async () => {
    const db = await fresh();
    value(await saveBenchmarkSamples(db, 'run', [book(' 甲书 ', '样章一'), book('乙书')], ctx));
    expect(value(await listBenchmarkSamples(db, 'run')).map((s) => [s.idx, s.title, s.text])).toEqual([
      [0, '甲书', '样章一'],
      [1, '乙书', ''],
    ]);
    value(await saveBenchmarkSamples(db, 'run', [book('丙书')], ctx));
    expect(value(await listBenchmarkSamples(db, 'run')).map((s) => s.title)).toEqual(['丙书']);
    expect(value(await clearBenchmarkSamples(db, 'run'))).toBe(1);
    expect(value(await listBenchmarkSamples(db, 'run'))).toEqual([]);
  });

  it('书名为空时不写入', async () => {
    const db = await fresh();
    expect(await saveBenchmarkSamples(db, 'run', [book(' ')], ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });
});

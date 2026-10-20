// 扫榜拆书的样章（需求 B79，迁移 0022）：榜单条目与对标作品的样章原文，只留在本机的作品库里，
// 不导出；一次运行用完即删。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { queryAll, type RepoError, type WriteContext } from './common';

const SampleRow = z
  .object({ run_id: z.string(), idx: z.number().int(), title: z.string(), author: z.string(), tags: z.string(), words: z.string(), blurb: z.string(), text: z.string() })
  .transform((r) => ({ runId: r.run_id, idx: r.idx, title: r.title, author: r.author, tags: r.tags, words: r.words, blurb: r.blurb, text: r.text }));
export type BenchmarkSample = z.output<typeof SampleRow>;

export type BenchmarkSampleInput = Omit<BenchmarkSample, 'runId' | 'idx'>;

/** 写入一次运行的榜单条目与样章（先删掉这次运行原有的），在一个事务中完成。 */
export async function saveBenchmarkSamples(port: SqlPort, runId: string, samples: readonly BenchmarkSampleInput[], ctx: WriteContext): Promise<Result<void, RepoError>> {
  if (samples.some((s) => s.title.trim() === '')) return err({ code: 'invalid', detail: '每一本都要有书名' });
  const done = await port.transaction([
    { sql: 'DELETE FROM benchmark_sample WHERE run_id = ?', params: [runId] },
    ...samples.map((s, idx) => ({
      sql: 'INSERT INTO benchmark_sample (run_id, idx, title, author, tags, words, blurb, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [runId, idx, s.title.trim(), s.author.trim(), s.tags.trim(), s.words.trim(), s.blurb.trim(), s.text, ctx.now],
    })),
  ]);
  return done.ok ? ok(undefined) : err({ code: 'sql', error: done.error });
}

export function listBenchmarkSamples(port: SqlPort, runId: string): Promise<Result<BenchmarkSample[], RepoError>> {
  return queryAll(port, SampleRow, 'SELECT run_id, idx, title, author, tags, words, blurb, text FROM benchmark_sample WHERE run_id = ? ORDER BY idx', [runId]);
}

/**
 * 删掉用完了的样章原文（打开作品时兜底）：运行已放弃、或对标分析这一步已完成或跳过（样章在那一步用完）的。
 * 正常流程在对比结束与放弃时就删；这里管的是崩溃、或作者停在对标分析的草稿处再也没有回来的情形。返回删了几本。
 */
export async function purgeBenchmarkSamples(port: SqlPort): Promise<Result<number, RepoError>> {
  const done = await port.transaction([
    {
      sql: `DELETE FROM benchmark_sample WHERE run_id IN (SELECT id FROM workflow_run WHERE status = 'abandoned')
        OR run_id IN (SELECT run_id FROM workflow_step WHERE key = 'compare' AND status IN ('done', 'skipped'))`,
      params: [],
    },
  ]);
  return done.ok ? ok(done.value[0]?.changes ?? 0) : err({ code: 'sql', error: done.error });
}

/** 删掉一次运行的样章原文。返回删了几本。 */
export async function clearBenchmarkSamples(port: SqlPort, runId: string): Promise<Result<number, RepoError>> {
  const done = await port.transaction([{ sql: 'DELETE FROM benchmark_sample WHERE run_id = ?', params: [runId] }]);
  return done.ok ? ok(done.value[0]?.changes ?? 0) : err({ code: 'sql', error: done.error });
}

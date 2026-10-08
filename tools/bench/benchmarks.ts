// 性能基准（施工文档第八章 M1-12）：在 Node 端（better-sqlite3，与桌面端共用迁移与仓储代码）测大作品的数据操作耗时。
// 界面渲染与 Rust 命令的往返不在此列，由手工清单在真实窗口中记录。
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { countWords } from '@fudiao/shared';
import { exportData, importChapters, listChapters, listParagraphs, saveChapterParagraphs, searchParagraphs, sourceStats, type Chapter } from '@fudiao/store';
import { loadMigrations, openProjectDb, PROJECT_DB_FILE, type ProjectDb } from '@fudiao/store/node';
import type { CorpusChapter } from './corpus';

export type Measure = {
  readonly name: string;
  /** 需求第八章的目标（毫秒）；null 表示只记录。 */
  readonly target: number | null;
  readonly samples: readonly number[];
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly pass: boolean | null;
};

export type BenchReport = {
  readonly preset: string;
  readonly chapters: number;
  readonly paragraphs: number;
  readonly words: number;
  readonly dbBytes: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly measures: readonly Measure[];
};

/** 需求第八章“大作品操作”“保存反馈”的目标。保存：停止输入后 2 秒内显示已保存，减去 800 毫秒防抖。 */
export const TARGETS = { chapterSwitch: 1_000, search: 2_000, save: 1_200 } as const;

const ctx = { now: '2026-10-08T00:00:00.000Z' };

function summarize(name: string, target: number | null, samples: number[]): Measure {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  const max = sorted.at(-1) ?? 0;
  return { name, target, samples, median: at(0.5), p95: at(0.95), max, pass: target === null ? null : max <= target };
}

async function time<T>(f: () => Promise<T> | T): Promise<[number, T]> {
  const start = performance.now();
  const value = await f();
  return [performance.now() - start, value];
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }, what: string): T {
  if (!r.ok) throw new Error(`${what}失败：${JSON.stringify(r.error)}`);
  return r.value;
}

/** 在数组中均匀取 n 个。 */
const spread = <T>(list: readonly T[], n: number): T[] =>
  list.length <= n ? [...list] : Array.from({ length: n }, (_, i) => list[Math.floor((i * (list.length - 1)) / Math.max(1, n - 1))] as T);

export type BenchOptions = {
  /** 每项操作取样的章节数。 */
  readonly samples?: number;
  readonly searchQueries?: readonly string[];
};

// 覆盖：常见词、长短语、不存在的词（索引）；1 字、2 字，以及不存在的 2 字词（扫描全部段落，最坏情况）。
export const DEFAULT_QUERIES = ['城隍庙', '三年前的那个晚上', '没有出现过的句子', '灯', '玉佩', '鲸鱼'] as const;

export async function runBenchmarks(preset: string, corpus: readonly CorpusChapter[], options: BenchOptions = {}): Promise<BenchReport> {
  const n = options.samples ?? 20;
  const root = mkdtempSync(join(tmpdir(), 'fudiao-bench-'));
  const open = () => must(openProjectDb(root, { migrations: loadMigrations(), now: ctx.now }), '打开作品库').db;
  let db: ProjectDb = open();
  try {
    const measures: Measure[] = [];
    let id = 0;
    const newId = () => `bench${String(id++).padStart(9, '0')}`;

    const [importMs] = await time(async () => must(await importChapters(db, corpus, ctx, newId), '导入'));
    measures.push(summarize('导入全部章节（一个事务）', null, [importMs]));

    const reopen: number[] = [];
    let chapters: Chapter[] = [];
    for (let i = 0; i < 3; i++) {
      db.close();
      const [ms, list] = await time(async () => {
        db = open();
        return must(await listChapters(db, 'normal'), '读取目录');
      });
      reopen.push(ms);
      chapters = list;
    }
    measures.push(summarize('打开作品并读取目录', null, reopen));

    const sampled = spread(chapters, n);
    const switches: number[] = [];
    for (const c of sampled) switches.push((await time(async () => must(await listParagraphs(db, c.id), '读取章节')))[0]);
    measures.push(summarize('章节切换（读取一章正文）', TARGETS.chapterSwitch, switches));

    const edits: number[] = [];
    const splits: number[] = [];
    for (const c of sampled) {
      const saved = must(await listParagraphs(db, c.id), '读取章节');
      const current = saved.map((p, i) => ({ id: p.id, text: i === Math.floor(saved.length / 2) ? `${p.text}他又补了一句。` : p.text, source: p.source }));
      const [editMs, afterEdit] = await time(async () => must(await saveChapterParagraphs(db, c.id, saved, current, { splits: [], merges: [] }, ctx), '保存'));
      edits.push(editMs);
      // 在第一段中间按回车：前半段保留标识，后半段是新段落。
      const first = afterEdit[0];
      if (first === undefined) continue;
      const cut = Math.floor(first.text.length / 2);
      const splitId = newId();
      const next = [
        { id: first.id, text: first.text.slice(0, cut), source: first.source },
        { id: splitId, text: first.text.slice(cut), source: first.source },
        ...afterEdit.slice(1).map((p) => ({ id: p.id, text: p.text, source: p.source })),
      ];
      splits.push(
        (await time(async () => must(await saveChapterParagraphs(db, c.id, afterEdit, next, { splits: [{ id: splitId, from: first.id }], merges: [] }, ctx), '保存')))[0],
      );
    }
    measures.push(summarize('保存（改一段）', TARGETS.save, edits));
    measures.push(summarize('保存（拆分一段）', TARGETS.save, splits));

    for (const q of options.searchQueries ?? DEFAULT_QUERIES) {
      const runs: number[] = [];
      let hits = 0;
      for (let i = 0; i < 3; i++) {
        const [ms, result] = await time(async () => must(await searchParagraphs(db, q), '查找'));
        runs.push(ms);
        hits = result.hits.length;
      }
      measures.push(summarize(`全文查找“${q}”（${[...q].length < 3 ? '扫描' : '索引'}，${hits} 处）`, TARGETS.search, runs));
    }

    measures.push(summarize('段落来源统计', null, [(await time(async () => must(await sourceStats(db), '统计')))[0]]));
    measures.push(summarize('导出全部数据（作品包的 data 部分）', null, [(await time(async () => must(await exportData(db), '导出')))[0]]));
    const backup = join(root, 'backup.sqlite');
    measures.push(summarize('备份（VACUUM INTO）', null, [(await time(() => db.backupTo(backup)))[0]]));

    const version = await db.query('SELECT sqlite_version() AS v');
    const cpu = cpus();
    return {
      preset,
      chapters: corpus.length,
      paragraphs: corpus.reduce((sum, c) => sum + c.paragraphs.length, 0),
      words: corpus.reduce((sum, c) => sum + c.paragraphs.reduce((s, p) => s + countWords(p), 0), 0),
      dbBytes: statSync(join(root, PROJECT_DB_FILE)).size,
      environment: {
        platform: `${platform()} ${release()}`,
        cpu: `${cpu[0]?.model.trim() ?? '未知'} × ${cpu.length}`,
        memory: `${Math.round(totalmem() / 1024 ** 3)} GB`,
        node: process.version,
        sqlite: version.ok ? String(version.value[0]?.['v'] ?? '') : '未知',
      },
      measures,
    };
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const ms = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));

/** Markdown 表格，可直接贴进 tools/bench/README.md。 */
export function formatReport(r: BenchReport): string {
  const lines = [
    `### ${r.preset}：${r.chapters} 章、${r.paragraphs.toLocaleString('en-US')} 段、${r.words.toLocaleString('en-US')} 字，作品库 ${(r.dbBytes / 1024 ** 2).toFixed(1)} MB`,
    '',
    Object.entries(r.environment)
      .map(([k, v]) => `${k}: ${v}`)
      .join('；'),
    '',
    '| 操作 | 次数 | 中位数（毫秒） | P95 | 最大 | 目标 | 结果 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.measures.map(
      (m) =>
        `| ${m.name} | ${m.samples.length} | ${ms(m.median)} | ${ms(m.p95)} | ${ms(m.max)} | ${m.target === null ? '—' : `≤ ${m.target.toLocaleString('en-US')}`} | ${m.pass === null ? '记录' : m.pass ? '通过' : '未通过'} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

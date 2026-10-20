// 扫榜拆书（需求 B79，施工文档 M6-07）：作者粘贴或导入榜单与对标作品的样章，软件逐本拆出结构与技法，再横向对比。
// 不联网抓取任何网站（凭据代理只发往模型服务的主机，硬性规则 16）。样章原文只进入逐本拆解的请求，
// 不进入对比、写手、规划与 AI 助手的请求；它存在本机作品库的 benchmark_sample 表里，不导出，用完即删。
import type { CallOptions } from '@fudiao/llm';
import { BENCHMARK_QUOTE_CHARS, BenchmarkBookOutput, BenchmarkCompareOutput, renderBenchmarkBook, renderBenchmarkCompare } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import { clearBenchmarkSamples, listBenchmarkSamples, saveBenchmarkSamples, type BenchmarkSampleInput, type RepoError, type SqlPort } from '@fudiao/store';
import { overlapTrimmer, parseRankList, sliceChars } from '@fudiao/writing';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';

/** 每本样章最多给模型多少字：太长时给开头与结尾。 */
export const BENCHMARK_SAMPLE_CHARS = 15_000;
/** 样章至少要有多少字才拆。 */
export const MIN_SAMPLE_CHARS = 200;
const BOOK_OUTPUT_TOKENS = 4_000 + THINKING_ALLOWANCE;
const COMPARE_OUTPUT_TOKENS = 4_000 + THINKING_ALLOWANCE;

export type BenchmarkBookInputForm = { readonly title: string; readonly text: string };
export type BenchmarkAnalysis = BenchmarkBookOutput;
export type BenchmarkCompare = BenchmarkCompareOutput;

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

/** 把榜单与样章合成样章表的各行：书名对得上的样章并进那一条，对不上的另起一条。 */
export function mergeSamples(rankText: string, books: readonly BenchmarkBookInputForm[]): BenchmarkSampleInput[] {
  const rows: BenchmarkSampleInput[] = parseRankList(rankText).map((e) => ({ ...e, text: '' }));
  for (const b of books) {
    const title = b.title.trim();
    if (title === '' && b.text.trim() === '') continue;
    const at = rows.findIndex((r) => r.title === title);
    if (at >= 0) rows[at] = { ...rows[at]!, text: b.text };
    else rows.push({ title: title || `样章 ${rows.length + 1}`, author: '', tags: '', words: '', blurb: '', text: b.text });
  }
  return rows;
}

/**
 * 拆解结果里的文字逐项做复述检查（与样章相同、长于上限的截短），引文超长的截短。返回截短了几处。
 * 来源是给模型看过的那段样章（模型只可能抄它看到的），窗口集合只建一次。
 */
function scrub(analysis: BenchmarkBookOutput, sources: readonly string[]): { readonly analysis: BenchmarkBookOutput; readonly trimmed: number } {
  let trimmed = 0;
  const trim = overlapTrimmer(sources, BENCHMARK_QUOTE_CHARS);
  const t = (s: string) => {
    const r = trim(s);
    trimmed += r.trimmed;
    return r.text;
  };
  const quote = (s: string) => {
    if ([...s].length <= BENCHMARK_QUOTE_CHARS) return s;
    trimmed += 1;
    return `${[...s].slice(0, BENCHMARK_QUOTE_CHARS).join('')}……`;
  };
  return {
    analysis: {
      genre: t(analysis.genre),
      sellingPoints: analysis.sellingPoints.map(t),
      hook: t(analysis.hook),
      pacing: analysis.pacing.map((p) => ({ chapter: t(p.chapter), role: t(p.role), beats: t(p.beats) })),
      cast: analysis.cast.map((c) => ({ role: t(c.role), description: t(c.description) })),
      conflict: t(analysis.conflict),
      chapterHooks: t(analysis.chapterHooks),
      techniques: analysis.techniques.map(t),
      quotes: analysis.quotes.slice(0, 3).map((q) => ({ text: quote(q.text), why: t(q.why) })),
    },
    trimmed,
  };
}

function scrubCompare(compare: BenchmarkCompareOutput, sources: readonly string[]): { readonly compare: BenchmarkCompareOutput; readonly trimmed: number } {
  let trimmed = 0;
  const trim = overlapTrimmer(sources, BENCHMARK_QUOTE_CHARS);
  const t = (s: string) => {
    const r = trim(s);
    trimmed += r.trimmed;
    return r.text;
  };
  return {
    compare: {
      common: compare.common.map(t),
      gaps: compare.gaps.map(t),
      borrow: compare.borrow.map(t),
      directions: compare.directions.map((d) => ({ idea: t(d.idea), why: t(d.why) })),
      skill: t(compare.skill),
    },
    trimmed,
  };
}

/** 给模型看的样章：超出字数时给开头与结尾（按字截，不切开表情符号与扩展区的字）。 */
function clip(text: string, limit: number): { readonly text: string; readonly clipped: boolean } {
  const length = [...text].length;
  if (length <= limit) return { text, clipped: false };
  return { text: `${sliceChars(text, 0, limit / 2)}\n……\n${sliceChars(text, length - limit / 2)}`, clipped: true };
}

export function benchmarkUseCases(deps: AppDeps, project: () => SqlPort | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });
  const withPort = <T>(f: (port: SqlPort) => Promise<Result<T, AppError>>): Promise<Result<T, AppError>> => {
    const port = project();
    return port === null ? Promise.resolve(err({ code: 'no_work' })) : f(port);
  };

  return {
    /** 写入一次运行的榜单与样章（原有的换掉）。至少要有一本带样章（不少于 200 字）。 */
    saveBenchmarkSamples: (runId: string, rows: readonly BenchmarkSampleInput[]) =>
      withPort(async (port) => {
        if (!rows.some((r) => r.text.trim().length >= MIN_SAMPLE_CHARS)) return err(settings(`至少粘贴或导入一本对标作品的样章（不少于 ${MIN_SAMPLE_CHARS} 字）`));
        const saved = await saveBenchmarkSamples(port, runId, rows, ctx());
        return saved.ok ? ok(rows.length) : err(repo(saved.error));
      }),

    /** 这次运行的榜单条目（书名、标签、字数、有没有样章与样章字数）；不带简介与原文。 */
    benchmarkBooks: (runId: string) =>
      withPort(async (port) => {
        const rows = await listBenchmarkSamples(port, runId);
        if (!rows.ok) return err(repo(rows.error));
        return ok(rows.value.map((r) => ({ idx: r.idx, title: r.title, tags: r.tags, words: r.words, chars: r.text.trim().length })));
      }),

    /** 拆解一本（样章不少于 200 字的）；结果经复述检查。 */
    analyzeBook: (runId: string, idx: number, stepKey: string, options: CallOptions = {}) =>
      withPort(async (port): Promise<Result<{ readonly analysis: BenchmarkAnalysis; readonly trimmed: number }, AppError>> => {
        const rows = await listBenchmarkSamples(port, runId);
        if (!rows.ok) return err(repo(rows.error));
        const row = rows.value.find((r) => r.idx === idx);
        if (row === undefined) return err(settings('样章已经删掉了：重新开始一次扫榜拆书'));
        const sample = clip(row.text, BENCHMARK_SAMPLE_CHARS);
        const prompt = renderBenchmarkBook({ title: row.title, author: row.author, tags: row.tags, words: row.words, blurb: row.blurb, text: sample.text, clipped: sample.clipped });
        if (!prompt.ok) return err(settings(prompt.error));
        const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: BOOK_OUTPUT_TOKENS, effort: 'medium', stepKey }, BenchmarkBookOutput, options);
        if (!result.ok) return result;
        return ok(scrub(result.value.value, [sample.text, row.blurb]));
      }),

    /**
     * 横向对比：只读各本的拆解与榜单的书名、标签、字数（来自“榜单与样章”一步的结果，样章删掉以后也在），不读样章原文；
     * 结果同样经复述检查（样章还在时以它为来源；对比的请求里没有样章，这一道只是兜底）。
     */
    compareBooks: (
      runId: string,
      rank: readonly { readonly title: string; readonly tags: string; readonly words: string }[],
      analyses: readonly { readonly title: string; readonly analysis: BenchmarkAnalysis }[],
      idea: string,
      stepKey: string,
      options: CallOptions = {},
    ) =>
      withPort(async (port): Promise<Result<{ readonly compare: BenchmarkCompare; readonly trimmed: number }, AppError>> => {
        const rows = await listBenchmarkSamples(port, runId);
        if (!rows.ok) return err(repo(rows.error));
        const line = (xs: readonly string[]) => xs.join('；');
        const prompt = renderBenchmarkCompare({
          rank: rank.map((r) => ({ title: r.title, tags: r.tags, words: r.words })),
          books: analyses.map(({ title, analysis: a }) => ({
            title,
            genre: a.genre,
            sellingPoints: line(a.sellingPoints),
            hook: a.hook,
            pacing: line(a.pacing.map((p) => `${p.chapter}：${p.role}（${p.beats}）`)),
            cast: line(a.cast.map((c) => `${c.role}：${c.description}`)),
            conflict: a.conflict,
            chapterHooks: a.chapterHooks,
            techniques: line(a.techniques),
          })),
          idea,
        });
        if (!prompt.ok) return err(settings(prompt.error));
        const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: COMPARE_OUTPUT_TOKENS, effort: 'medium', stepKey }, BenchmarkCompareOutput, options);
        if (!result.ok) return result;
        return ok(scrubCompare(result.value.value, rows.value.flatMap((r) => [clip(r.text, BENCHMARK_SAMPLE_CHARS).text, r.blurb])));
      }),

    /** 删掉这次运行的样章原文。返回删了几条。 */
    clearBenchmark: (runId: string) =>
      withPort(async (port) => {
        const done = await clearBenchmarkSamples(port, runId);
        return done.ok ? ok(done.value) : err(repo(done.error));
      }),
  };
}

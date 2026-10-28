// 写作工作流的真实模型试用（施工文档 M6-08）：在 m3/eval/book.json 的短篇上依次跑一键成书、全书体检、开篇打磨、
// 人物补全、续写一卷与扫榜拆书，记下每个工作流各步的状态、说明、用量、丢弃的条数与发现的问题，写成报告由人阅读判断。
// 只经应用服务层的用例；写章节的钩子与服务层默认的就地实现相同（依次写、整理长篇记忆、审核），另外记下每章的数字。
// 工作流以“一路做完”运行；须作者动手的步骤（导出、处理开篇问题）由这里代作者做，草稿等确认时代作者采用。
import { countWords } from '@fudiao/shared';
import { reviewWithRetry, type ReviewIssueView } from '../../apps/desktop/src/app/review';
import type { AppService } from '../../apps/desktop/src/app/service';
import type { BookSize, WorkflowHooks, WorkflowView } from '../../apps/desktop/src/app/workflows';
import type { EvalBook } from '../m3-eval/book';
import { importBook } from '../m3-eval/run';
import { benchmarkSamples, BOOK_CHAPTERS, CONTRADICTION, EVAL_ORDER, paramsFor, WORDS_PER_CHAPTER, type EvalWorkflow } from './material';

export type Hooks = { readonly log: (line: string) => void; readonly now: () => number };

type Usage = { readonly input: number; readonly output: number; readonly cost: number; readonly unknown: number };

export type StepRecord = {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly status: string;
  readonly note: string;
  readonly attempt: number;
  readonly usage: Usage | null;
};

export type FlowRecord = {
  readonly key: EvalWorkflow;
  title: string;
  runId: string | null;
  state: string;
  /** 最后一次推进停在哪里的一句话。 */
  summary: string;
  /** 用例返回的错误，或没有开始的原因；正常时为 null。 */
  error: string | null;
  steps: StepRecord[];
  spent: Usage;
  ms: number;
  /** 模型给出、对不上标签或定位不到原文而丢弃的条数（各步合计）；扫榜拆书为复述检查截短的处数。 */
  dropped: number;
  /** 这个工作流做出来的东西与发现的问题，写进报告。 */
  findings: string[];
  /** 各步的结果（写进 result.json）。 */
  outputs: Record<string, unknown>;
};

export type ChapterRecord = {
  readonly flow: EvalWorkflow;
  readonly title: string;
  readonly words: number;
  readonly paragraphs: number;
  readonly segments: string;
  readonly issues: number;
  readonly dropped: number;
  /** 模型审核重试后仍没有完成的原因；完成或没有审核时为 null。 */
  readonly reviewIncomplete: string | null;
  /** 模型审核没完成后重试的次数。 */
  readonly reviewRetries: number;
  readonly writeMs: number;
  readonly reviewMs: number;
};

/** 植入的跨章矛盾（全书体检）：疑点里有没有提到、读原文时定位到没有、依据是不是前一章植入的那一段。 */
export type PlantRecord = {
  readonly inserted: string | null;
  readonly suspected: boolean;
  readonly located: boolean;
  readonly evidenceMatched: boolean;
  readonly suspects: readonly string[];
  readonly issues: readonly string[];
};

export type EvalResult = {
  readonly title: string;
  readonly flows: readonly FlowRecord[];
  readonly chapters: readonly ChapterRecord[];
  readonly plant: PlantRecord | null;
  readonly usage: { readonly calls: number; readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly unknownCost: number } | null;
  readonly bookText: string;
};

export type QuoteRow = { readonly key: string; readonly title: string; readonly calls: number; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number | null };

/** 写出章节之后作品的规模：估算一键成书之后的工作流时用（那时还没有章节）。 */
export const ASSUMED_BOOK: BookSize = { chapters: BOOK_CHAPTERS, written: BOOK_CHAPTERS, words: BOOK_CHAPTERS * WORDS_PER_CHAPTER };
/** 工作流以外的调用：能力自检三次，开篇打磨里交给写手修订一段（偏高的估计，思考计入输出）。 */
export const EXTRA_ESTIMATE = { calls: 4, inputTokens: 10_000, outputTokens: 16_000 } as const;

const describe = (error: unknown): string => {
  if (typeof error === 'string') return error;
  const e = error as { code?: string; detail?: string };
  return e.detail ?? e.code ?? JSON.stringify(error);
};

/** 选中的工作流加上它们要用的前置（扫榜拆书以外都要先有一键成书写出的章节），按运行顺序。 */
export function planFlows(selected: readonly EvalWorkflow[]): EvalWorkflow[] {
  const set = new Set(selected);
  if ([...set].some((k) => k !== 'benchmark')) set.add('quick_book');
  return EVAL_ORDER.filter((k) => set.has(k));
}

/** 运行前的预计：每个工作流按 quoteWorkflow（一键成书之后的按写出章节后的规模假定），另加工作流以外的调用。 */
export async function quoteFlows(app: AppService, book: EvalBook, flows: readonly EvalWorkflow[]): Promise<{ readonly rows: QuoteRow[]; readonly total: QuoteRow } | string> {
  const params = paramsFor(book);
  const titles = new Map(app.workflowCatalog().map((w) => [w.key, w.title]));
  const rows: QuoteRow[] = [];
  for (const key of flows) {
    const p = key === 'benchmark' ? { idea: params.benchmark.idea, entries: flows.includes('quick_book') ? 2 : 1 } : params[key];
    const quote = await app.quoteWorkflow(key, p, key === 'quick_book' ? undefined : ASSUMED_BOOK);
    if (!quote.ok) return `${titles.get(key) ?? key}的预计没有算出：${describe(quote.error)}`;
    rows.push({ key, title: titles.get(key) ?? key, calls: quote.value.calls, inputTokens: quote.value.inputTokens, outputTokens: quote.value.outputTokens, costUsd: quote.value.costUsd });
  }
  const model = await app.defaultModel();
  const prices = model.ok ? (model.value?.model.prices ?? null) : null;
  const extraCost = prices === null ? null : (EXTRA_ESTIMATE.inputTokens * prices.input + EXTRA_ESTIMATE.outputTokens * prices.output) / 1_000_000;
  rows.push({ key: 'extra', title: '能力自检与开篇修订', ...EXTRA_ESTIMATE, costUsd: extraCost });
  const total = rows.reduce<QuoteRow>(
    (sum, r) => ({ ...sum, calls: sum.calls + r.calls, inputTokens: sum.inputTokens + r.inputTokens, outputTokens: sum.outputTokens + r.outputTokens, costUsd: sum.costUsd === null || r.costUsd === null ? null : sum.costUsd + r.costUsd }),
    { key: 'total', title: '合计', calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  return { rows, total };
}

const issueLine = (i: ReviewIssueView) => `【${i.kind}·${i.severity}】${i.anchor.quote === '' ? '' : `“${i.anchor.quote}”：`}${i.description}${i.suggestion === '' ? '' : `（建议：${i.suggestion}）`}${i.evidenceText.length > 0 ? `（依据：${i.evidenceText.join('；')}）` : ''}`;

const short = (text: string, n = 80) => (text.length <= n ? text : `${text.slice(0, n)}……`);

export async function runWorkflowEval(app: AppService, book: EvalBook, selected: readonly EvalWorkflow[], hooks: Hooks): Promise<EvalResult> {
  const { log, now } = hooks;
  const params = paramsFor(book);
  const flows = planFlows(selected);
  const records: FlowRecord[] = [];
  const chapters: ChapterRecord[] = [];
  let plant: PlantRecord | null = null;
  let current: EvalWorkflow = 'quick_book';

  const titleOf = async (id: string) => {
    const work = await app.reloadWork();
    return work.ok ? (work.value.chapters.find((c) => c.id === id)?.title ?? id) : id;
  };
  const textOf = async (id: string) => {
    const content = await app.openChapter(id);
    return content.ok ? content.value.saved : [];
  };

  // 写章节的钩子：与服务层默认的就地实现相同（依次写、整理长篇记忆、审核；模型审核没有完成时这一步出错），另外记下每章的数字。
  const writing: WorkflowHooks = {
    // 推演成章的推演步骤：就地一步一步推到停下（与服务层默认的钩子相同）；试用脚本目前不跑这个工作流。
    async simulate(runId, { signal, onProgress }) {
      let view = await app.simRunStatus(runId);
      if (view.ok && view.value.phase === 'Paused') view = await app.resumeSimRun(runId);
      while (view.ok && view.value.phase !== 'Ended' && view.value.phase !== 'Paused' && view.value.phase !== 'AwaitingAuthor' && signal?.aborted !== true) {
        view = await app.stepSimRun(runId, { ...(signal !== undefined && { signal }) });
        if (view.ok) onProgress(`第 ${view.value.round} 回合`);
      }
      if (!view.ok) return { ok: false, summary: describe(view.error) };
      if (signal?.aborted === true) return { ok: false, summary: '已停下', cancelled: true };
      return { ok: view.value.phase === 'Ended', summary: `推演停在第 ${view.value.round} 回合` };
    },
    async writeChapters(ids, review, options) {
      const done: string[] = [];
      const incomplete: string[] = [];
      for (const id of ids) {
        const title = await titleOf(id);
        log(`  写《${title}》…`);
        let at = now();
        const written = await app.writeChapter(id, options);
        const writeMs = now() - at;
        if (!written.ok) return { ok: false, summary: `${done.length > 0 ? `已写完 ${done.length} 章；` : ''}停在这一章：${describe(written.error)}` };
        if (written.value.status !== 'written') return { ok: false, summary: `${done.length > 0 ? `已写完 ${done.length} 章；` : ''}写手停下：${written.value.reason ?? ''}` };
        const memory = await app.buildMemory(id, options);
        if (!memory.ok) return { ok: false, summary: `已写完 ${done.length + 1} 章，长篇记忆没有整理成：${describe(memory.error)}` };
        at = now();
        const attempt = review ? await reviewWithRetry(() => app.reviewChapter(id, options), options.signal) : null;
        const reviewed = attempt?.result ?? null;
        const reviewMs = now() - at;
        const saved = await textOf(id);
        const text = saved.map((p) => p.text).join('\n');
        chapters.push({
          flow: current,
          title,
          words: countWords(text),
          paragraphs: saved.length,
          segments: `${written.value.segmentsDone}/${written.value.segmentsTotal}`,
          issues: reviewed?.ok === true ? reviewed.value.issues.length : 0,
          dropped: reviewed?.ok === true ? reviewed.value.dropped : 0,
          reviewIncomplete: attempt === null || attempt.complete ? null : (attempt.reason ?? '原因不明'),
          reviewRetries: attempt?.retries ?? 0,
          writeMs,
          reviewMs,
        });
        log(`    ${countWords(text)} 字${reviewed === null ? '' : reviewed.ok ? `，审核 ${reviewed.value.issues.length} 条问题` : `，审核失败：${describe(reviewed.error)}`}`);
        if (options.signal?.aborted === true) return { ok: false, summary: `已写完 ${done.length + 1} 章，审核时停下` };
        // 与服务层默认的钩子相同：审核重试后仍没完成时记下这一章，接着写后面的。
        if (attempt !== null && !attempt.complete) incomplete.push(`《${title}》（${attempt.reason ?? ''}）`);
        done.push(id);
      }
      return { ok: true, summary: `写完了 ${done.length} 章${review ? '并审核' : ''}${incomplete.length === 0 ? '' : `；这些章的审核没有完成：${incomplete.join('、')}`}` };
    },
    async reviewChapters(ids, options) {
      let done = 0;
      const incomplete: string[] = [];
      for (const id of ids) {
        const attempt = await reviewWithRetry(() => app.reviewChapter(id, options), options.signal);
        if (options.signal?.aborted === true) return { ok: false, summary: `${done > 0 ? `已审完 ${done} 章；` : ''}已停下` };
        const title = await titleOf(id);
        if (attempt.complete && attempt.result.ok) {
          log(`  审核《${title}》：${attempt.result.value.issues.length} 条问题`);
          done += 1;
        } else incomplete.push(`《${title}》（${attempt.reason ?? ''}）`);
      }
      return { ok: true, summary: `审完了 ${done} 章${incomplete.length === 0 ? '' : `；这些章的审核没有完成：${incomplete.join('、')}`}` };
    },
  };

  const record = (key: EvalWorkflow): FlowRecord => {
    const r: FlowRecord = { key, title: key, runId: null, state: 'not_started', summary: '', error: null, steps: [], spent: { input: 0, output: 0, cost: 0, unknown: 0 }, ms: 0, dropped: 0, findings: [], outputs: {} };
    records.push(r);
    return r;
  };
  const absorb = (r: FlowRecord, view: WorkflowView) => {
    r.title = view.title;
    r.state = view.state;
    r.spent = view.spent;
    r.steps = view.steps.map((s) => ({ key: s.key, label: s.label, kind: s.kind, status: s.status, note: s.note, attempt: s.attempt, usage: s.usage }));
    r.outputs = Object.fromEntries(view.steps.map((s) => [s.key, s.output]));
  };

  /**
   * 推进到做完或停在作者那里：须作者动手的步骤交给 manual 里对应的处理（没有时直接采用），等确认的草稿代作者采用。
   * 出错、可能过时或预算用完时停下。
   */
  const drive = async (r: FlowRecord, runId: string, manual: Readonly<Record<string, () => Promise<void>>> = {}): Promise<WorkflowView | null> => {
    let view: WorkflowView | null = null;
    for (let round = 0; round < 12; round++) {
      const out = await app.advanceWorkflow(runId, { hooks: writing, onProgress: (note) => log(`  · ${note}`) });
      if (!out.ok) {
        r.error = describe(out.error);
        return view;
      }
      view = out.value.view;
      absorb(r, view);
      r.summary = out.value.summary;
      log(`  ${out.value.summary}`);
      const idx = view.steps.findIndex((s) => s.status === 'awaiting_author');
      if (view.state !== 'waiting' || idx < 0) return view;
      const s = view.steps[idx]!;
      const handle = manual[s.key];
      if (handle !== undefined) await handle();
      else if (s.kind === 'draft') log(`  （代作者确认后采用：${s.note}）`);
      const adopted = await app.adoptWorkflowStep(runId, idx, { hooks: writing });
      if (!adopted.ok) {
        r.error = `采用“${s.label}”没有成：${describe(adopted.error)}`;
        return view;
      }
      view = adopted.value;
      absorb(r, view);
      log(`  采用“${s.label}”：${view.steps[idx]?.note ?? ''}`);
    }
    r.error = '推进的次数超过上限';
    return view;
  };

  const start = async (r: FlowRecord, key: Exclude<EvalWorkflow, 'benchmark'>): Promise<string | null> => {
    const started = await app.startWorkflow({ workflow: key, params: params[key], mode: 'auto', budgetUsd: null });
    if (!started.ok) {
      r.error = `没有开始：${describe(started.error)}`;
      return null;
    }
    r.runId = started.value.run.id;
    absorb(r, started.value);
    return started.value.run.id;
  };

  const writtenChapters = async () => {
    const view = await app.planningView();
    return view.ok ? view.value.chapters.filter((c) => c.hasText) : [];
  };

  // 一、作品、设定与伏笔（不调用模型）。
  const imported = await importBook(app, book);
  if (imported !== null) {
    const r = record('quick_book');
    r.error = imported;
    return finish();
  }

  for (const key of flows) {
    current = key;
    const r = record(key);
    const started = now();
    log(`\n【${app.workflowCatalog().find((w) => w.key === key)?.title ?? key}】`);
    if (key !== 'quick_book' && key !== 'benchmark' && (await writtenChapters()).length === 0) {
      r.error = '没有写好的章节（一键成书没有写出来），跳过';
      log(`  ${r.error}`);
      continue;
    }
    switch (key) {
      case 'quick_book': {
        const runId = await start(r, key);
        if (runId !== null) await drive(r, runId);
        const written = await writtenChapters();
        r.findings.push(`写出 ${written.length} 章：${written.map((c) => `《${c.chapter.title}》${c.pendingIssues} 条待处理问题`).join('、')}`);
        if (flows.includes('book_audit')) plant = { inserted: await insertContradiction(), suspected: false, located: false, evidenceMatched: false, suspects: [], issues: [] };
        break;
      }
      case 'book_audit': {
        const runId = await start(r, key);
        if (runId === null) break;
        const view = await drive(r, runId);
        if (view !== null) await auditFindings(r, view);
        break;
      }
      case 'opening_polish': {
        const runId = await start(r, key);
        if (runId === null) break;
        await drive(r, runId, { handle: () => handleOpening(r) });
        const diag = r.outputs['diagnose'] as { dropped?: number } | null | undefined;
        const again = r.outputs['recheck'] as { dropped?: number } | null | undefined;
        r.dropped = (diag?.dropped ?? 0) + (again?.dropped ?? 0);
        const metrics = r.outputs['metrics'] as { chapters?: { title: string; metrics: Record<string, number | null> }[] } | null | undefined;
        for (const c of metrics?.chapters ?? []) r.findings.push(`《${c.title}》的数字：${JSON.stringify(c.metrics)}`);
        break;
      }
      case 'cast_completion': {
        const runId = await start(r, key);
        if (runId === null) break;
        await drive(r, runId);
        const gaps = r.outputs['gaps'] as { gaps?: { name: string; noDescription: boolean; noRelation: boolean }[] } | null | undefined;
        for (const g of gaps?.gaps ?? []) r.findings.push(`缺口：${g.name}${g.noDescription ? '（说明为空）' : ''}${g.noRelation ? '（出场却没有关系）' : ''}`);
        const draft = r.outputs['draft'] as { characters?: { name: string; entityId: string | null; identity: string; personality: string; motive: string }[]; relationships?: { from: string; to: string; label: string; description: string }[]; dropped?: number } | null | undefined;
        r.dropped = draft?.dropped ?? 0;
        for (const c of draft?.characters ?? []) r.findings.push(`人物${c.entityId === null ? '（新）' : ''}：${c.name}——${short([c.identity, c.personality, c.motive].filter((x) => x !== '').join('；'))}`);
        for (const x of draft?.relationships ?? []) r.findings.push(`关系：${x.from}→${x.to}：${x.label}${x.description === '' ? '' : `（${short(x.description, 50)}）`}`);
        break;
      }
      case 'next_volume': {
        const runId = await start(r, key);
        if (runId === null) break;
        await drive(r, runId);
        const outline = r.outputs['outline'] as { title?: string; summary?: string; mainline?: string[]; newCharacters?: { name: string }[]; newForeshadows?: { title: string }[] } | null | undefined;
        if (outline !== null && outline !== undefined) {
          r.findings.push(`卷纲：${outline.title ?? ''}——${outline.summary ?? ''}`);
          r.findings.push(`主线：${(outline.mainline ?? []).join('；')}；新人物：${(outline.newCharacters ?? []).map((c) => c.name).join('、') || '无'}；新伏笔：${(outline.newForeshadows ?? []).map((f) => f.title).join('、') || '无'}`);
        }
        const plan = r.outputs['plan'] as { chapters?: { title: string; goal: string }[] } | null | undefined;
        for (const c of plan?.chapters ?? []) r.findings.push(`计划：${c.title}——${short(c.goal)}`);
        break;
      }
      case 'benchmark': {
        const first = (await writtenChapters())[0];
        const firstText = first === undefined ? null : { title: first.chapter.title, text: (await textOf(first.chapter.id)).map((p) => p.text).join('\n') };
        const { rankText, books } = benchmarkSamples(book, firstText);
        const started2 = await app.startBenchmark({ rankText, books, idea: params.benchmark.idea, mode: 'auto', budgetUsd: null });
        if (!started2.ok) {
          r.error = `没有开始：${describe(started2.error)}`;
          break;
        }
        r.runId = started2.value.run.id;
        absorb(r, started2.value);
        await drive(r, r.runId);
        const analyses = r.outputs['analyze'] as { analyses?: { title: string; trimmed: number; analysis: { hook: string; sellingPoints: string[]; techniques: string[] } }[] } | null | undefined;
        for (const a of analyses?.analyses ?? []) {
          r.dropped += a.trimmed;
          r.findings.push(`拆解《${a.title}》：卖点 ${a.analysis.sellingPoints.length} 条，技法 ${a.analysis.techniques.length} 条；开头：${short(a.analysis.hook)}`);
        }
        const compare = r.outputs['compare'] as { common?: string[]; gaps?: string[]; directions?: { idea: string }[]; skill?: string; trimmed?: number } | null | undefined;
        if (compare !== null && compare !== undefined) {
          r.dropped += compare.trimmed ?? 0;
          r.findings.push(`共性：${(compare.common ?? []).join('；')}`);
          r.findings.push(`空位：${(compare.gaps ?? []).join('；')}`);
          r.findings.push(`开书方向：${(compare.directions ?? []).map((d) => d.idea).join('；')}`);
          r.findings.push(`规划技能：${short(compare.skill ?? '', 200)}`);
        }
        const left = await app.benchmarkBooks(r.runId);
        r.findings.push(left.ok && left.value.length === 0 ? '样章原文已删除' : `样章原文还在：${left.ok ? left.value.length : describe(left.error)} 本`);
        break;
      }
    }
    r.ms = now() - started;
    log(`  用量：输入 ${r.spent.input.toLocaleString('en-US')}、输出 ${r.spent.output.toLocaleString('en-US')} Token，${money(r.spent)}${r.error === null ? '' : `；出错：${r.error}`}`);
  }
  return finish();

  /** 在第一章与第三章中间各插入一段（作者手写），两段前后矛盾。返回说明；章节不够时说明原因。 */
  async function insertContradiction(): Promise<string> {
    const written = await writtenChapters();
    const earlier = written[CONTRADICTION.earlier.chapter - 1];
    const later = written[CONTRADICTION.later.chapter - 1];
    if (earlier === undefined || later === undefined) return `章节不够（写出 ${written.length} 章），没有植入`;
    for (const [c, text] of [
      [earlier, CONTRADICTION.earlier.text],
      [later, CONTRADICTION.later.text],
    ] as const) {
      const saved = await textOf(c.chapter.id);
      const at = Math.max(1, Math.floor(saved.length / 2));
      const next = saved.map((p) => ({ id: p.id, text: p.text, source: 'handwritten' as const }));
      next.splice(at, 0, { id: `plant-${c.chapter.id}`, text, source: 'handwritten' });
      const stored = await app.saveChapter(c.chapter.id, saved, next, { splits: [], merges: [] });
      if (!stored.ok) return `植入《${c.chapter.title}》没有成：${describe(stored.error)}`;
    }
    log(`  植入跨章矛盾：《${earlier.chapter.title}》当掉端砚，《${later.chapter.title}》端砚还在身上。`);
    return `《${earlier.chapter.title}》当掉端砚，《${later.chapter.title}》端砚还在身上`;
  }

  async function auditFindings(r: FlowRecord, view: WorkflowView) {
    const work = await app.reloadWork();
    const title = (id: string) => (work.ok ? (work.value.chapters.find((c) => c.id === id)?.title ?? id) : id);
    const suspects = (r.outputs['suspects'] as { suspects?: { earlierId: string; laterId: string; kind: string; about: string; severity: string }[]; dropped?: number } | null | undefined) ?? null;
    const located = (r.outputs['locate'] as { dropped?: number } | null | undefined) ?? null;
    r.dropped = (suspects?.dropped ?? 0) + (located?.dropped ?? 0);
    for (const s of suspects?.suspects ?? []) r.findings.push(`疑点：《${title(s.earlierId)}》→《${title(s.laterId)}》［${s.kind}·${s.severity}］${s.about}`);
    const written = await writtenChapters();
    const earlier = written[CONTRADICTION.earlier.chapter - 1];
    const later = written[CONTRADICTION.later.chapter - 1];
    const earlierPara = earlier === undefined ? undefined : (await textOf(earlier.chapter.id)).find((p) => p.text === CONTRADICTION.earlier.text);
    const laterPara = later === undefined ? undefined : (await textOf(later.chapter.id)).find((p) => p.text === CONTRADICTION.later.text);
    const laterHits: ReviewIssueView[] = [];
    for (const c of written) {
      const issues = await app.reviewIssues(c.chapter.id);
      if (!issues.ok) continue;
      for (const i of issues.value.filter((x) => x.source === 'continuity')) {
        r.findings.push(`跨章问题：《${c.chapter.title}》${issueLine(i)}`);
        if (laterPara !== undefined && i.anchor.paragraphId === laterPara.id) laterHits.push(i);
      }
    }
    r.findings.push(`体检报告：${view.steps.find((s) => s.key === 'report')?.note ?? '没有生成'}`);
    if (plant !== null && plant.inserted !== null && earlier !== undefined && later !== undefined) {
      const about = (suspects?.suspects ?? []).filter((s) => s.about.includes(CONTRADICTION.keyword));
      plant = {
        ...plant,
        suspected: about.some((s) => s.earlierId === earlier.chapter.id && s.laterId === later.chapter.id),
        suspects: about.map((s) => `《${title(s.earlierId)}》→《${title(s.laterId)}》${s.about}`),
        located: laterHits.length > 0,
        evidenceMatched: earlierPara !== undefined && laterHits.some((i) => i.evidence.some((e) => e.type === 'paragraph' && e.id === earlierPara.id)),
        issues: laterHits.map(issueLine),
      };
    }
  }

  /** 处理开篇问题（代作者）：把第一章里最严重的一条开篇问题交给写手修订，其余不动。 */
  async function handleOpening(r: FlowRecord) {
    const first = (await writtenChapters())[0];
    if (first === undefined) return;
    const issues = await app.reviewIssues(first.chapter.id);
    const opening = issues.ok ? issues.value.filter((i) => i.source === 'opening') : [];
    for (const i of opening) r.findings.push(`开篇问题：《${first.chapter.title}》${issueLine(i)}`);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const target = [...opening].sort((a, b) => rank[a.severity] - rank[b.severity])[0];
    if (target === undefined) {
      r.findings.push('第一章没有开篇问题，没有交给写手');
      return;
    }
    const saved = await textOf(first.chapter.id);
    const before = saved.find((p) => p.id === target.anchor.paragraphId)?.text ?? '';
    log(`  交给写手修订：${short(target.description, 40)}`);
    const revised = await app.reviseIssue(target.id);
    if (!revised.ok) {
      r.findings.push(`交给写手修订没有成：${describe(revised.error)}`);
      return;
    }
    const old = new Set(saved.map((p) => p.text));
    const after = revised.value.paragraphs.filter((p) => !old.has(p.text)).map((p) => p.text);
    r.findings.push(`交给写手修订“${short(target.description, 40)}”：原文“${short(before, 120)}”改为“${short(after.join('\n'), 160)}”`);
  }

  async function finish(): Promise<EvalResult> {
    const usage = await app.usage();
    const total = usage.ok ? usage.value.summary.total : null;
    const work = await app.reloadWork();
    const texts: string[] = [];
    if (work.ok) {
      for (const c of work.value.chapters) {
        const text = (await textOf(c.id)).map((p) => p.text).join('\n');
        if (text !== '') texts.push(`${c.title}\n\n${text}`);
      }
    }
    return {
      title: book.title,
      flows: records,
      chapters,
      plant,
      usage: total === null ? null : { calls: total.calls, inputTokens: total.inputTokens, outputTokens: total.outputTokens, cost: total.cost, unknownCost: total.unknownCost },
      bookText: texts.join('\n\n\n'),
    };
  }
}

const STATUS: Readonly<Record<string, string>> = { pending: '待做', running: '进行中', awaiting_author: '等作者', done: '已完成', failed: '出错', skipped: '已跳过', interrupted: '中断', stale: '可能过时' };
const cell = (text: string) => text.replace(/\|/g, '｜').replace(/\n/g, ' ');
/** 费用：有调用的价格未知时写明（中转站等没有价格的服务全部未知）。 */
const money = (u: { readonly cost: number; readonly unknown: number }) => (u.unknown > 0 ? (u.cost > 0 ? `至少 $${u.cost.toFixed(4)}` : '未知') : `$${u.cost.toFixed(4)}`);
const seconds = (ms: number) => `${Math.round(ms / 1000)} 秒`;

/** 试用报告（Markdown）：预计与实际用量、每个工作流各步的状态与说明、丢弃的条数、发现的问题、植入矛盾的检出。 */
export function renderReport(result: EvalResult, meta: { readonly model: string; readonly startedAt: string; readonly quote: { readonly rows: readonly QuoteRow[]; readonly total: QuoteRow } | null }): string {
  const out: string[] = [`# 写作工作流试用报告：《${result.title}》`, '', `- 模型：${meta.model}`, `- 开始：${meta.startedAt}`];
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (result.usage !== null) {
    const u = result.usage;
    out.push(`- 实际用量：${u.calls} 次调用，输入 ${fmt(u.inputTokens)} Token，输出 ${fmt(u.outputTokens)} Token，${money({ cost: u.cost, unknown: u.unknownCost })}${u.unknownCost > 0 ? `（${u.unknownCost} 次费用未知）` : ''}`);
  }
  if (meta.quote !== null) {
    out.push('', '## 预计与实际', '', '| 工作流 | 预计调用 | 预计输入 | 预计输出 | 预计费用 | 实际输入 | 实际输出 | 实际费用 | 用时 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const q of meta.quote.rows) {
      const f = result.flows.find((x) => x.key === q.key);
      out.push(`| ${q.title} | ${q.calls} | ${fmt(q.inputTokens)} | ${fmt(q.outputTokens)} | ${q.costUsd === null ? '未知' : `$${q.costUsd.toFixed(3)}`} | ${f === undefined ? '—' : fmt(f.spent.input)} | ${f === undefined ? '—' : fmt(f.spent.output)} | ${f === undefined ? '—' : money(f.spent)} | ${f === undefined ? '—' : seconds(f.ms)} |`);
    }
    const t = meta.quote.total;
    out.push(`| 合计 | ${t.calls} | ${fmt(t.inputTokens)} | ${fmt(t.outputTokens)} | ${t.costUsd === null ? '未知' : `$${t.costUsd.toFixed(3)}`} | | | | |`);
    out.push('', '工作流以外的调用（能力自检、开篇修订）不计入各工作流的实际用量，只在上面的实际用量合计里。');
  }
  if (result.chapters.length > 0) {
    out.push('', '## 写出的章节', '', '| 工作流 | 章节 | 字数 | 段数 | 分段 | 写作 | 审核 | 问题 | 丢弃 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const c of result.chapters) out.push(`| ${c.flow} | ${cell(c.title)} | ${c.words} | ${c.paragraphs} | ${c.segments} | ${seconds(c.writeMs)} | ${seconds(c.reviewMs)}${c.reviewRetries > 0 ? `（重试 ${c.reviewRetries} 次）` : ''} | ${c.reviewIncomplete === null ? c.issues : `${c.issues}（模型审核没有完成：${cell(c.reviewIncomplete)}）`} | ${c.dropped} |`);
  }
  for (const f of result.flows) {
    out.push('', `## ${f.title}`, '', `- 状态：${f.state}；${f.summary}${f.error === null ? '' : `；出错：${f.error}`}`, `- 用量：输入 ${fmt(f.spent.input)}、输出 ${fmt(f.spent.output)} Token，${money(f.spent)}${f.spent.unknown > 0 ? `（${f.spent.unknown} 次费用未知）` : ''}；用时 ${seconds(f.ms)}`, `- 丢弃（或截短）：${f.dropped} 条`);
    if (f.steps.length > 0) {
      out.push('', '| 步骤 | 状态 | 说明 | 输入 | 输出 | 费用 |', '| --- | --- | --- | --- | --- | --- |');
      for (const s of f.steps) out.push(`| ${s.label}${s.attempt > 1 ? `（第 ${s.attempt} 次）` : ''} | ${STATUS[s.status] ?? s.status} | ${cell(s.note)} | ${s.usage === null ? '—' : fmt(s.usage.input)} | ${s.usage === null ? '—' : fmt(s.usage.output)} | ${s.usage === null ? '—' : money(s.usage)} |`);
    }
    if (f.findings.length > 0) out.push('', ...f.findings.map((x) => `- ${x}`));
  }
  if (result.plant !== null) {
    const p = result.plant;
    out.push('', '## 植入的跨章矛盾（全书体检）', '');
    if (p.inserted === null) out.push('没有植入。');
    else {
      out.push(`- 植入：${p.inserted}`, `- 疑点里提到：${p.suspected ? '是' : '否'}${p.suspects.length > 0 ? `（${p.suspects.join('；')}）` : ''}`, `- 读原文定位到植入的那一段：${p.located ? '是' : '否'}`, `- 依据是前一章植入的那一段：${p.evidenceMatched ? '是' : '否'}`);
      for (const i of p.issues) out.push(`- 问题：${i}`);
    }
  }
  out.push(
    '',
    '## 需要作者判断的事',
    '',
    '1. 通读 book.txt：一键成书写的三章与续写的一卷是否接得上，开篇修订是否更好。',
    '2. 全书体检、开篇打磨提出的问题里，哪些是真问题、哪些是误报。',
    '3. 人物补全的小传与关系是否符合正文；扫榜拆书的对标分析与规划技能是否有用。',
    '',
  );
  return out.join('\n');
}

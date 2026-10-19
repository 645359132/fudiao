// 写作工作流（需求 B78，施工文档 M6-01）：作者选一个工作流，软件按固定的步骤依次做，每步的结果存在作品里，
// 可以看、改、采用；可以停下、关掉应用后接着做、重做或跳过某一步，采用过的一步可以撤回。
// 这里是命令表（每个工作流一项：参数、预计用量与步骤）与执行器；步骤的状态转换在 packages/writing（纯函数）。
// 步骤只调用现有的用例，所以锁定设定、写入前快照、版本守卫与段落来源照常生效。
import { costOf, type CallOptions, type LlmUsage, type Prices } from '@fudiao/llm';
import { BookSeedOutput, PlanDraftOutput } from '@fudiao/prompts';
import { err, ok, type Result, type WorkflowMode } from '@fudiao/shared';
import {
  abandonWorkflowRun,
  createWorkflowRun,
  getWorkflowRun,
  listChapterPlans,
  listWorkflowRuns,
  updateWorkflowSteps,
  type RepoError,
  type SqlPort,
  type StepPatch,
  type StepUsage,
  type WorkflowRun,
  type WorkflowRunWithSteps,
  type WorkflowStepRow,
} from '@fudiao/store';
import { nextAction, runState, transition, type RunState, type StepEvent } from '@fudiao/writing';
export { WORKFLOW_STATE_LABEL, WORKFLOW_STEP_STATUS_LABEL } from './labels';
import { z } from 'zod';
import { describeError, type AppError } from './errors';
import type { AppliedDraft, PlanDraft, PlanDraftRequest, PlanningView } from './planning';
import { AuditSuspect, type LocatedSuspect } from './book-audit';
import { foreshadowAudit, type ForeshadowFinding } from '@fudiao/writing';
import { chapterLengths, type Chapter } from '@fudiao/store';
import type { AppDeps } from './ports';
import type { BookSeed, BookSeedRequest, QuickBookStatus } from './quick-book';

/** 工作流的键。新增工作流时在这里加一项，命令表的类型要求它有定义。 */
export const WORKFLOW_KEYS = ['quick_book', 'book_audit'] as const;
export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

/**
 * 步骤的类别：draft 调用模型产出草稿，等作者看、改、采用（“一路做完”时直接采用）；act 调用现有用例改动作品；
 * check 是程序检查或汇总；manual 须作者动手（例如导出要选位置），两种模式下都停下，作者“做这一步”即采用。
 */
export type StepKind = 'draft' | 'act' | 'check' | 'manual';

/** 步骤需要、而应用层自己做不到的事（由状态层提供；没有时用应用层的就地实现）。 */
export type WorkflowHooks = {
  /**
   * 写手依次写这些章（每章写完整理长篇记忆，review 时再审核）。状态层经写手队列做，与成书进度、助手的后台写作同一批规则。
   * ok 为是否全部写完；summary 是怎样结束的一句话。
   */
  writeChapters(chapterIds: readonly string[], review: boolean, options: CallOptions): Promise<{ readonly ok: boolean; readonly summary: string }>;
  /** 依次审核这些章（状态层经依次审核做，与成书进度、助手的后台审核同一时间只有一批）。ok 为是否全部审完。 */
  reviewChapters(chapterIds: readonly string[], options: CallOptions): Promise<{ readonly ok: boolean; readonly summary: string }>;
};

/** 推进时的环境：取消信号、用量回调由执行器包好交给步骤。 */
export type AdvanceEnv = {
  readonly signal?: AbortSignal;
  readonly hooks?: WorkflowHooks;
  /** 每一步的状态写进作品库之后（界面重新读取运行）。 */
  readonly onStep?: (run: WorkflowView) => void;
  /** 正在进行的步骤的进展（给任务页与界面）。 */
  readonly onProgress?: (note: string) => void;
};

/** 执行一步时能用到的：参数、步骤键、调用选项、前面各步的结果与环境。 */
type StepContext<P> = {
  readonly params: P;
  readonly stepKey: string;
  readonly options: CallOptions;
  readonly hooks: WorkflowHooks;
  readonly onProgress: (note: string) => void;
  /** 前面某一步的结果（按它的结构校验过）；没有时为 null。 */
  readonly output: (key: string) => unknown;
};

/** 一步的结果。settled：草稿没有要作者看的东西（例如一处疑点也没找到），直接完成、不停下。 */
type StepResult<O> = { readonly output: O; readonly note: string; readonly settled?: boolean };

/** 命令表里的一步。O 是结果的结构；存进作品库前后都按 output 校验。 */
type StepSpec<P, O> = {
  readonly key: string;
  readonly label: string;
  readonly kind: StepKind;
  readonly output: z.ZodType<O>;
  readonly run: (ctx: StepContext<P>) => Promise<Result<StepResult<O>, AppError>>;
  /** 采用（draft 写进作品；manual 是作者动手的那件事）。返回给作者看的一句话。 */
  readonly adopt?: (ctx: StepContext<P>, output: O) => Promise<Result<string, AppError>>;
  /** 采用会覆盖或删除作品内容时给作者看的说明（“一路做完”时也停下等作者确认）；没有时为 null。 */
  readonly confirm?: (ctx: StepContext<P>, output: O) => Promise<string | null>;
  /** 这一步用不着做时（例如没写想法而作品已有大纲）给出原因，执行器直接跳过它；要做时为 null。 */
  readonly skipIf?: (ctx: StepContext<P>) => Promise<string | null>;
};

type Step<P> = {
  readonly key: string;
  readonly label: string;
  readonly kind: StepKind;
  readonly parse: (value: unknown) => Result<unknown, string>;
  readonly run: (ctx: StepContext<P>) => Promise<Result<StepResult<unknown>, AppError>>;
  readonly adopt?: (ctx: StepContext<P>, output: unknown) => Promise<Result<string, AppError>>;
  readonly confirm?: (ctx: StepContext<P>, output: unknown) => Promise<string | null>;
  readonly skipIf?: (ctx: StepContext<P>) => Promise<string | null>;
};

const invalid = (detail: string): AppError => ({ code: 'settings', detail });

function step<P, O>(spec: StepSpec<P, O>): Step<P> {
  const parse = (value: unknown): Result<O, string> => {
    const parsed = spec.output.safeParse(value);
    return parsed.success ? ok(parsed.data) : err(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'));
  };
  const typed = <R>(f: (ctx: StepContext<P>, output: O) => Promise<R>, failed: (why: string) => R) => (ctx: StepContext<P>, value: unknown) => {
    const parsed = parse(value);
    return parsed.ok ? f(ctx, parsed.value) : Promise.resolve(failed(parsed.error));
  };
  const { adopt, confirm, skipIf } = spec;
  return {
    key: spec.key,
    label: spec.label,
    kind: spec.kind,
    parse,
    run: spec.run,
    ...(skipIf !== undefined && { skipIf }),
    ...(adopt !== undefined && { adopt: typed(adopt, (why) => err(invalid(`这一步的结果不完整：${why}`))) }),
    ...(confirm !== undefined && { confirm: typed(confirm, () => null) }),
  };
}

/** 估算用的作品规模：章数（回收站以外）、有正文的章数与全书字数。 */
export type BookSize = { readonly chapters: number; readonly written: number; readonly words: number };

/** 预计用量：调用次数与 Token（思考计入输出）。 */
export type WorkflowEstimate = { readonly calls: number; readonly inputTokens: number; readonly outputTokens: number };

type WorkflowDef<P> = {
  readonly title: string;
  /** 一句话说明，卡片与助手都用它。 */
  readonly description: string;
  readonly params: z.ZodType<P>;
  readonly runTitle: (params: P) => string;
  readonly estimate: (params: P, book: BookSize) => WorkflowEstimate;
  readonly steps: readonly Step<P>[];
};

/** 去掉参数类型的工作流：参数在每次执行时按定义校验，命令表里各工作流的参数类型因此可以不同。 */
type AnyWorkflow = {
  readonly title: string;
  readonly description: string;
  readonly parseParams: (value: unknown) => Result<unknown, string>;
  readonly runTitle: (params: unknown) => string;
  readonly estimate: (params: unknown, book: BookSize) => WorkflowEstimate;
  readonly steps: readonly Step<unknown>[];
};

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join('.')} ${i.message}`.trim()).join('；');

function erase<P>(def: WorkflowDef<P>): AnyWorkflow {
  const parseParams = (value: unknown): Result<P, string> => {
    const parsed = def.params.safeParse(value);
    return parsed.success ? ok(parsed.data) : err(`参数不完整：${issues(parsed.error)}`);
  };
  const bind = (c: StepContext<unknown>): Result<StepContext<P>, AppError> => {
    const p = parseParams(c.params);
    return p.ok ? ok({ ...c, params: p.value }) : err(invalid(p.error));
  };
  // 参数在开始运行时已校验过，这里不合格只可能是作品库被改动，按空处理。
  const typed = <R>(value: unknown, f: (p: P) => R, fallback: R): R => {
    const p = parseParams(value);
    return p.ok ? f(p.value) : fallback;
  };
  return {
    title: def.title,
    description: def.description,
    parseParams,
    runTitle: (v) => typed(v, def.runTitle, def.title),
    estimate: (v, book) => typed(v, (p) => def.estimate(p, book), { calls: 0, inputTokens: 0, outputTokens: 0 }),
    steps: def.steps.map((s): Step<unknown> => {
      const { adopt, confirm, skipIf } = s;
      return {
        key: s.key,
        label: s.label,
        kind: s.kind,
        parse: s.parse,
        run: (c) => {
          const b = bind(c);
          return b.ok ? s.run(b.value) : Promise.resolve(b);
        },
        ...(adopt !== undefined && {
          adopt: (c: StepContext<unknown>, output: unknown) => {
            const b = bind(c);
            return b.ok ? adopt(b.value, output) : Promise.resolve(b);
          },
        }),
        ...(confirm !== undefined && {
          confirm: (c: StepContext<unknown>, output: unknown) => {
            const b = bind(c);
            return b.ok ? confirm(b.value, output) : Promise.resolve(null);
          },
        }),
        ...(skipIf !== undefined && {
          skipIf: (c: StepContext<unknown>) => {
            const b = bind(c);
            return b.ok ? skipIf(b.value) : Promise.resolve(null);
          },
        }),
      };
    }),
  };
}

/** 一键成书的参数：想法、类型、章数与每章字数（已有大纲时可以不写想法，跳过骨架这一步）。 */
export const QuickBookParams = z.object({
  idea: z.string(),
  genre: z.string(),
  chapters: z.number().int().min(1).max(300),
  wordsPerChapter: z.number().int().min(500).max(20_000),
});
export type QuickBookParams = z.infer<typeof QuickBookParams>;

/** 全书体检的参数：范围（章节标识，null 为从头、到尾）与要不要重新审核已经审过的章节。 */
export const BookAuditParams = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  rereview: z.boolean(),
});
export type BookAuditParams = z.infer<typeof BookAuditParams>;

type ParamsOf = { readonly quick_book: QuickBookParams; readonly book_audit: BookAuditParams };

/** 工作流用到的现有用例（由应用服务提供）。 */
export type WorkflowHost = {
  reloadWork(): Promise<Result<{ readonly project: { readonly outline: string } }, AppError>>;
  exportText(kind: 'txt' | 'md', chapterId?: string): Promise<Result<boolean, AppError>>;
  quickBookStatus(): Promise<Result<QuickBookStatus, AppError>>;
  draftBookSeed(request: BookSeedRequest, options?: CallOptions): Promise<Result<BookSeed, AppError>>;
  applyBookSeed(seed: BookSeed): Promise<Result<{ readonly created: number; readonly relations: number }, AppError>>;
  draftPlans(request: PlanDraftRequest, options?: CallOptions): Promise<Result<PlanDraft, AppError>>;
  applyPlanDraft(draft: PlanDraft): Promise<Result<AppliedDraft, AppError>>;
  planningView(): Promise<Result<PlanningView, AppError>>;
  buildMemory(chapterId: string, options?: CallOptions): Promise<Result<unknown, AppError>>;
  auditChapters(from: string | null, to: string | null): Promise<Result<readonly Chapter[], AppError>>;
  draftSuspects(chapterIds: readonly string[], stepKey: string, options?: CallOptions): Promise<Result<{ readonly suspects: AuditSuspect[]; readonly dropped: number }, AppError>>;
  locateSuspect(suspect: AuditSuspect, stepKey: string, options?: CallOptions): Promise<Result<LocatedSuspect, AppError>>;
  saveContinuityIssues(chapterIds: readonly string[], located: readonly LocatedSuspect[]): Promise<Result<number, AppError>>;
};

/** 中文正文每字约合的 Token 数（估算用，偏保守）。 */
const TOKENS_PER_CHAR = 1.5;

function quickBook(host: WorkflowHost, project: () => SqlPort | null): WorkflowDef<QuickBookParams> {
  return {
    title: '一键成书',
    description: '一句话的想法 → 大纲与人物 → 章节计划 → 写手写完并审核 → 导出',
    params: QuickBookParams,
    runTitle: (p) => `一键成书：${p.idea.trim() === '' ? '按已有大纲' : p.idea.trim().slice(0, 20)}`,
    estimate(p) {
      const words = p.chapters * p.wordsPerChapter;
      const segments = p.chapters * Math.max(1, Math.ceil(p.wordsPerChapter / 1_500));
      return {
        // 骨架、计划各一次；每章分段写、整理记忆、审核。
        calls: 2 + segments + p.chapters * 2,
        inputTokens: Math.round(3_000 + 6_000 + segments * 9_000 + p.chapters * 2 * 6_000 + words * TOKENS_PER_CHAR * 2),
        outputTokens: Math.round(2_000 + p.chapters * 150 + p.chapters * 800 + words * TOKENS_PER_CHAR + p.chapters * (1_500 + 3_000)),
      };
    },
    steps: [
      step<QuickBookParams, { readonly model: string }>({
        key: 'model',
        label: '检查模型',
        kind: 'check',
        output: z.object({ model: z.string() }),
        async run() {
          const status = await host.quickBookStatus();
          if (!status.ok) return status;
          const { model } = status.value;
          if (!model.ready) return err(invalid(`${model.problem ?? '默认模型不能用'}：请在“模型服务”里设置默认模型并运行能力自检`));
          return ok({ output: { model: model.name ?? '' }, note: `默认模型：${model.name ?? ''}` });
        },
      }),
      step<QuickBookParams, BookSeed>({
        key: 'seed',
        label: '大纲与人物',
        kind: 'draft',
        output: BookSeedOutput,
        async run({ params, stepKey, options, onProgress }) {
          onProgress('正在由想法生成作品名、简介、大纲与主要人物');
          const seed = await host.draftBookSeed({ idea: params.idea, genre: params.genre, chapterCount: params.chapters, wordsPerChapter: params.wordsPerChapter, stepKey }, options);
          if (!seed.ok) return seed;
          return ok({ output: seed.value, note: `《${seed.value.title}》：${seed.value.characters.length} 个主要人物` });
        },
        async confirm() {
          const work = await host.reloadWork();
          return work.ok && work.value.project.outline.trim() !== '' ? '采用会替换作品已有的大纲（大纲没有历史版本）' : null;
        },
        async skipIf({ params }) {
          if (params.idea.trim() !== '') return null;
          const work = await host.reloadWork();
          return work.ok && work.value.project.outline.trim() !== '' ? '没有写想法，沿用作品已有的大纲与人物' : null;
        },
        async adopt(_ctx, seed) {
          const applied = await host.applyBookSeed(seed);
          if (!applied.ok) return applied;
          return ok(`已写入作品信息与大纲，新建 ${applied.value.created} 个人物、${applied.value.relations} 条关系`);
        },
      }),
      step<QuickBookParams, PlanDraft>({
        key: 'plan',
        label: '章节计划',
        kind: 'draft',
        output: PlanDraftOutput,
        async run({ params, stepKey, options, onProgress }) {
          onProgress(`正在按大纲拆出 ${params.chapters} 章的章节计划`);
          const draft = await host.draftPlans({ chapterCount: params.chapters, wordsPerChapter: params.wordsPerChapter, stepKey }, options);
          if (!draft.ok) return draft;
          return ok({ output: draft.value, note: `${draft.value.chapters.length} 章的计划` });
        },
        async confirm() {
          const port = project();
          if (port === null) return null;
          const plans = await listChapterPlans(port);
          return plans.ok && plans.value.length > 0 ? `采用会覆盖已有的 ${plans.value.length} 章章节计划` : null;
        },
        async adopt(_ctx, draft) {
          const applied = await host.applyPlanDraft(draft);
          if (!applied.ok) return applied;
          const missing = applied.value.unmatchedCast;
          return ok(`已采用 ${draft.chapters.length} 章的计划${missing.length > 0 ? `；这些人物还没有人物卡片：${missing.join('、')}` : ''}`);
        },
      }),
      step<QuickBookParams, { readonly chapters: readonly string[]; readonly summary: string }>({
        key: 'write',
        label: '写完并审核',
        kind: 'act',
        output: z.object({ chapters: z.array(z.string()), summary: z.string() }),
        async run({ hooks, options, onProgress }) {
          const view = await host.planningView();
          if (!view.ok) return view;
          const todo = view.value.chapters.filter((c) => c.plan !== null && (c.plan.status === 'todo' || c.plan.status === 'writing'));
          if (todo.length === 0) return ok({ output: { chapters: [], summary: '' }, note: '没有待写的章节' });
          onProgress(`写手依次写 ${todo.length} 章，每章写完整理长篇记忆并审核`);
          const ids = todo.map((c) => c.chapter.id);
          const written = await hooks.writeChapters(ids, true, options);
          if (!written.ok) return err(invalid(written.summary));
          return ok({ output: { chapters: ids, summary: written.summary }, note: written.summary });
        },
      }),
      step<QuickBookParams, { readonly saved: boolean }>({
        key: 'export',
        label: '导出',
        kind: 'manual',
        output: z.object({ saved: z.boolean() }),
        run: () => Promise.resolve(ok({ output: { saved: false }, note: '点“导出”选择保存的位置' })),
        async adopt() {
          const saved = await host.exportText('txt');
          if (!saved.ok) return saved;
          return saved.value ? ok('已导出整本正文') : err(invalid('没有导出（取消了保存）'));
        },
      }),
    ],
  };
}

/** 骨架步骤的草稿（界面编辑用）；不是骨架或不合格时为 null。 */
export function seedDraftOf(step: Pick<WorkflowStepView, 'output'>): BookSeed | null {
  const parsed = BookSeedOutput.safeParse(step.output);
  return parsed.success ? parsed.data : null;
}

/** 计划步骤的草稿（界面显示用）；不是计划或不合格时为 null。 */
export function planDraftOf(step: Pick<WorkflowStepView, 'output'>): PlanDraft | null {
  const parsed = PlanDraftOutput.safeParse(step.output);
  return parsed.success ? parsed.data : null;
}

/** 一章约多少字（体检估算没有字数时用）。 */
const AUDIT_WORDS_PER_CHAPTER = 3_000;

/** 全书体检各步的结果。 */
const ChapterCount = z.object({ chapters: z.array(z.string()), note: z.string() });
const ForeshadowReport = z.object({ findings: z.array(z.object({ foreshadowId: z.string(), title: z.string(), problem: z.enum(['overdue', 'not_planted', 'unscheduled']), chapterId: z.string().nullable() })) });
const SuspectDraft = z.object({ suspects: z.array(AuditSuspect), dropped: z.number().int() });
const LocateReport = z.object({ issues: z.number().int(), unconfirmed: z.number().int(), dropped: z.number().int(), failed: z.number().int() });
const AuditReport = z.object({
  chapters: z.array(z.object({ chapterId: z.string(), title: z.string(), pending: z.number().int() })),
  foreshadows: z.number().int(),
  continuity: z.number().int(),
});
export type AuditReport = z.infer<typeof AuditReport>;

const FINDING_LABEL: Readonly<Record<ForeshadowFinding['problem'], string>> = { overdue: '到期未回收', not_planted: '计划埋下，没有迹象', unscheduled: '没有定章节' };

function bookAudit(host: WorkflowHost): WorkflowDef<BookAuditParams> {
  const range = async (p: BookAuditParams) => host.auditChapters(p.from, p.to);
  return {
    title: '全书体检',
    description: '补齐长篇记忆 → 依次审核 → 伏笔核对 → 跨章疑点 → 读原文定位 → 体检报告',
    params: BookAuditParams,
    runTitle: (p) => (p.from === null && p.to === null ? '全书体检：全书' : '全书体检：部分章节'),
    estimate(_p, book) {
      const n = Math.max(book.written, 1);
      const chapterTokens = (book.words > 0 ? book.words / Math.max(book.written, 1) : AUDIT_WORDS_PER_CHAPTER) * TOKENS_PER_CHAR;
      const suspects = Math.min(20, Math.ceil(n / 2));
      return {
        // 每章记忆与审核各一次（已有的会跳过，按最多算），疑点一次，每处疑点一次。
        calls: n * 2 + 1 + suspects,
        inputTokens: Math.round(n * (chapterTokens + 2_000) + n * (chapterTokens + 8_000) + n * 600 + 4_000 + suspects * (chapterTokens * 2 + 2_000)),
        outputTokens: Math.round(n * 1_500 + n * 3_000 + 3_000 + suspects * 1_500),
      };
    },
    steps: [
      step<BookAuditParams, z.infer<typeof ChapterCount>>({
        key: 'memory',
        label: '补齐长篇记忆',
        kind: 'act',
        output: ChapterCount,
        async run({ params, options, onProgress }) {
          const chapters = await range(params);
          if (!chapters.ok) return chapters;
          if (chapters.value.length === 0) return err(invalid('范围里还没有写好正文的章节'));
          const view = await host.planningView();
          if (!view.ok) return view;
          const ids = new Set(chapters.value.map((c) => c.id));
          const todo = view.value.chapters.filter((c) => ids.has(c.chapter.id) && (c.memory === null || c.memory.status === 'stale'));
          const done: string[] = [];
          for (const [i, c] of todo.entries()) {
            onProgress(`整理长篇记忆：第 ${i + 1} / ${todo.length} 章《${c.chapter.title}》`);
            const built = await host.buildMemory(c.chapter.id, options);
            if (!built.ok) return err(invalid(`《${c.chapter.title}》的长篇记忆没有整理成：${describeError(built.error)}${done.length > 0 ? `（已整理 ${done.length} 章，重做时接着整理）` : ''}`));
            done.push(c.chapter.id);
          }
          return ok({ output: { chapters: done, note: '' }, note: done.length === 0 ? `范围内 ${chapters.value.length} 章的长篇记忆都是最新的` : `整理了 ${done.length} 章的长篇记忆` });
        },
      }),
      step<BookAuditParams, z.infer<typeof ChapterCount>>({
        key: 'review',
        label: '依次审核',
        kind: 'act',
        output: ChapterCount,
        async run({ params, hooks, options, onProgress }) {
          const chapters = await range(params);
          if (!chapters.ok) return chapters;
          const view = await host.planningView();
          if (!view.ok) return view;
          const reviewed = new Set(view.value.chapters.filter((c) => c.plan?.status === 'reviewed').map((c) => c.chapter.id));
          const targets = chapters.value.filter((c) => params.rereview || !reviewed.has(c.id)).map((c) => c.id);
          if (targets.length === 0) return ok({ output: { chapters: [], note: '' }, note: '范围内的章节都审核过了（要重新审核，开始时勾选“已审过的也重新审核”）' });
          onProgress(`依次审核 ${targets.length} 章`);
          const done = await hooks.reviewChapters(targets, options);
          if (!done.ok) return err(invalid(done.summary));
          return ok({ output: { chapters: targets, note: done.summary }, note: done.summary });
        },
      }),
      step<BookAuditParams, z.infer<typeof ForeshadowReport>>({
        key: 'foreshadow',
        label: '伏笔核对',
        kind: 'check',
        output: ForeshadowReport,
        async run({ params }) {
          const chapters = await range(params);
          if (!chapters.ok) return chapters;
          const view = await host.planningView();
          if (!view.ok) return view;
          const findings = foreshadowAudit({
            foreshadows: view.value.foreshadows,
            order: new Map(view.value.chapters.map((c, i) => [c.chapter.id, i])),
            written: new Set(view.value.chapters.filter((c) => c.hasText).map((c) => c.chapter.id)),
            range: new Set(chapters.value.map((c) => c.id)),
            progress: new Map(view.value.chapters.flatMap((c) => (c.memory === null ? [] : [[c.chapter.id, c.memory.foreshadowProgress] as const]))),
          });
          const counts = (['overdue', 'not_planted', 'unscheduled'] as const).flatMap((k) => {
            const n = findings.filter((f) => f.problem === k).length;
            return n === 0 ? [] : [`${FINDING_LABEL[k]} ${n} 条`];
          });
          return ok({ output: { findings }, note: counts.length === 0 ? '伏笔账本没有发现问题' : counts.join('，') });
        },
      }),
      step<BookAuditParams, z.infer<typeof SuspectDraft>>({
        key: 'suspects',
        label: '跨章疑点',
        kind: 'draft',
        output: SuspectDraft,
        async run({ params, stepKey, options, onProgress }) {
          const chapters = await range(params);
          if (!chapters.ok) return chapters;
          onProgress(`由 ${chapters.value.length} 章的长篇记忆找跨章的疑点`);
          const drafted = await host.draftSuspects(
            chapters.value.map((c) => c.id),
            stepKey,
            options,
          );
          if (!drafted.ok) return drafted;
          const n = drafted.value.suspects.length;
          return ok({ output: drafted.value, note: n === 0 ? '没有找到跨章的疑点' : `${n} 处疑点，下一步逐条读两章的原文确认；用不着核对的可以先删去`, settled: n === 0 });
        },
        // 采用即确认要核对这些疑点，不改动作品。
        adopt: (_c, draft) => Promise.resolve(ok(`确认核对 ${draft.suspects.length} 处疑点`)),
      }),
      step<BookAuditParams, z.infer<typeof LocateReport>>({
        key: 'locate',
        label: '读原文定位',
        kind: 'act',
        output: LocateReport,
        async run({ params, stepKey, options, onProgress, output }) {
          const chapters = await range(params);
          if (!chapters.ok) return chapters;
          const draft = SuspectDraft.safeParse(output('suspects'));
          const suspects = draft.success ? draft.data.suspects : [];
          const located: LocatedSuspect[] = [];
          let failed = 0;
          for (const [i, s] of suspects.entries()) {
            onProgress(`核对第 ${i + 1} / ${suspects.length} 处疑点`);
            // 每处疑点一个步骤键：中断后接着做时，已经核对过的不再请求。
            const one = await host.locateSuspect(s, `${stepKey}:${i}`, options);
            if (!one.ok) {
              if (options.signal?.aborted === true) return one;
              failed += 1;
              continue;
            }
            located.push(one.value);
          }
          const saved = await host.saveContinuityIssues(
            chapters.value.map((c) => c.id),
            located,
          );
          if (!saved.ok) return saved;
          const unconfirmed = located.filter((l) => l.issues.length === 0).length;
          const dropped = located.reduce((n, l) => n + l.dropped, 0);
          return ok({
            output: { issues: saved.value, unconfirmed, dropped, failed },
            note: `${suspects.length === 0 ? '没有要核对的疑点' : `核对了 ${suspects.length - failed} 处疑点，定位出 ${saved.value} 个问题`}${unconfirmed > 0 ? `；${unconfirmed} 处读了原文没有发现矛盾` : ''}${failed > 0 ? `；${failed} 处没有核对成（调用失败），重做这一步时再试` : ''}`,
          });
        },
      }),
      step<BookAuditParams, AuditReport>({
        key: 'report',
        label: '体检报告',
        kind: 'check',
        output: AuditReport,
        async run({ params, output }) {
          const chapters = await range(params);
          if (!chapters.ok) return chapters;
          const view = await host.planningView();
          if (!view.ok) return view;
          const ids = new Set(chapters.value.map((c) => c.id));
          const rows = view.value.chapters.filter((c) => ids.has(c.chapter.id)).map((c) => ({ chapterId: c.chapter.id, title: c.chapter.title, pending: c.pendingIssues }));
          const fs = ForeshadowReport.safeParse(output('foreshadow'));
          const loc = LocateReport.safeParse(output('locate'));
          const report: AuditReport = { chapters: rows, foreshadows: fs.success ? fs.data.findings.length : 0, continuity: loc.success ? loc.data.issues : 0 };
          const total = rows.reduce((n, r) => n + r.pending, 0);
          const worst = rows.filter((r) => r.pending > 0).length;
          return ok({ output: report, note: `范围内 ${rows.length} 章，${worst} 章有待处理的问题，共 ${total} 条（跨章连贯 ${report.continuity} 条）；伏笔要留意的 ${report.foreshadows} 条` });
        },
      }),
    ],
  };
}

/** 体检各步的结果（界面显示用）；不是这一步或不合格时为 null。 */
export const suspectsOf = (step: Pick<WorkflowStepView, 'output'>) => {
  const parsed = SuspectDraft.safeParse(step.output);
  return parsed.success ? parsed.data : null;
};
export const findingsOf = (step: Pick<WorkflowStepView, 'output'>) => {
  const parsed = ForeshadowReport.safeParse(step.output);
  return parsed.success ? parsed.data.findings : null;
};
export const reportOf = (step: Pick<WorkflowStepView, 'output'>) => {
  const parsed = AuditReport.safeParse(step.output);
  return parsed.success ? parsed.data : null;
};
export const FORESHADOW_FINDING_LABEL = FINDING_LABEL;

/** 卡片与助手用的工作流说明。 */
export type WorkflowInfo = {
  readonly key: WorkflowKey;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly { readonly key: string; readonly label: string; readonly kind: StepKind }[];
};

export type WorkflowStepView = Omit<WorkflowStepRow, 'output'> & {
  readonly label: string;
  readonly kind: StepKind;
  /** 按这一步的结构校验过的结果；没有或不合格时为 null。 */
  readonly output: unknown;
};

/** 一次运行：各步（带名称与类别）、整次的状态、已用的用量。 */
export type WorkflowView = {
  readonly run: WorkflowRun;
  readonly title: string;
  readonly steps: readonly WorkflowStepView[];
  readonly state: RunState;
  readonly spent: StepUsage;
};

/** 推进到停下为止的结果：停在哪里、为什么。 */
export type AdvanceOutcome = { readonly view: WorkflowView; readonly summary: string };

/** 开始前的预计：调用次数、Token 与费用（价格未知时为 null）。 */
export type WorkflowQuote = WorkflowEstimate & { readonly costUsd: number | null; readonly model: string | null };

export type StartWorkflowRequest = {
  readonly workflow: WorkflowKey;
  readonly params: unknown;
  readonly mode: WorkflowMode;
  readonly budgetUsd: number | null;
};

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const EMPTY_USAGE: StepUsage = { input: 0, output: 0, cost: 0, unknown: 0 };

/**
 * 采用前后取作品的结构化现状、记下差别与撤回（由应用服务接上 AI 助手的撤销：captureWork、diffWork、undoChanges）。
 * I 是现状的样子；差别存进步骤，撤回时原样交回。
 */
export type ChangeTracker<I> = {
  capture(): Promise<I | null>;
  diff(before: I, after: I): readonly unknown[];
  undo(changes: readonly unknown[]): Promise<Result<{ readonly undone: readonly string[]; readonly skipped: readonly string[] }, AppError>>;
};

export type WorkflowDeps<I> = {
  readonly deps: AppDeps;
  readonly project: () => SqlPort | null;
  readonly host: WorkflowHost;
  readonly changes: ChangeTracker<I>;
  /** 默认模型的名字与价格（预计与用量的费用按它算）。 */
  readonly pricing: () => Promise<{ readonly model: string; readonly prices: Prices | undefined } | null>;
  /** 没有状态层的钩子时（测试、命令行）就地写章节。 */
  readonly hooks: WorkflowHooks;
};

export function workflowUseCases<I>({ deps, project, host, changes: tracker, pricing, hooks: localHooks }: WorkflowDeps<I>) {
  const ctx = () => ({ now: deps.clock.now() });
  const WORKFLOWS: { readonly [K in WorkflowKey]: WorkflowDef<ParamsOf[K]> } = {
    quick_book: quickBook(host, project),
    book_audit: bookAudit(host),
  };
  const ERASED: { readonly [K in WorkflowKey]: AnyWorkflow } = { quick_book: erase(WORKFLOWS.quick_book), book_audit: erase(WORKFLOWS.book_audit) };
  const isKey = (key: string): key is WorkflowKey => (WORKFLOW_KEYS as readonly string[]).includes(key);
  const defOf = (key: string): AnyWorkflow | null => (isKey(key) ? ERASED[key] : null);

  function viewOf(data: WorkflowRunWithSteps): WorkflowView {
    const def = defOf(data.run.workflow);
    const steps = data.steps.map((s): WorkflowStepView => {
      const spec = def?.steps.find((d) => d.key === s.key);
      const parsed = s.output === null || spec === undefined ? null : spec.parse(s.output);
      return { ...s, label: spec?.label ?? s.key, kind: spec?.kind ?? 'act', output: parsed?.ok === true ? parsed.value : null };
    });
    const spent = data.steps.reduce(
      (sum, s) => (s.usage === null ? sum : { input: sum.input + s.usage.input, output: sum.output + s.usage.output, cost: sum.cost + s.usage.cost, unknown: sum.unknown + s.usage.unknown }),
      EMPTY_USAGE,
    );
    return { run: data.run, title: def?.title ?? data.run.workflow, steps, state: runState(data.steps, data.run.abandoned), spent };
  }

  async function load(port: SqlPort, runId: string): Promise<Result<WorkflowRunWithSteps, AppError>> {
    const got = await getWorkflowRun(port, runId);
    if (!got.ok) return err(repo(got.error));
    return got.value === null ? err({ code: 'not_found' }) : ok(got.value);
  }

  /** 按状态机改几步（同一事务、版本守卫）；extra 给出这次改动之外要一并写的字段。 */
  async function apply(port: SqlPort, data: WorkflowRunWithSteps, event: StepEvent, extra: Readonly<Record<number, StepPatch>> = {}): Promise<Result<WorkflowRunWithSteps, AppError>> {
    const changes = transition(data.steps, event);
    if (!changes.ok) return err(invalid(changes.error));
    const touched = new Map<number, StepPatch>(changes.value.map((c) => [c.idx, { status: c.status, ...(c.attempt !== undefined && { attempt: c.attempt }), ...extra[c.idx] }]));
    for (const [idx, patch] of Object.entries(extra)) if (!touched.has(Number(idx))) touched.set(Number(idx), patch);
    const updates = [...touched].map(([idx, patch]) => ({ step: data.steps[idx]!, patch }));
    const saved = await updateWorkflowSteps(port, data.run.id, updates, ctx());
    return saved.ok ? ok(saved.value) : err(repo(saved.error));
  }

  function contextFor(def: AnyWorkflow, data: WorkflowRunWithSteps, idx: number, env: AdvanceEnv, usage: { value: StepUsage }, prices: Prices | undefined): StepContext<unknown> {
    const s = data.steps[idx]!;
    const options: CallOptions = {
      ...(env.signal !== undefined && { signal: env.signal }),
      onEvent: (e) => {
        if (e.type !== 'usage') return;
        const u: LlmUsage = e.usage;
        const cost = costOf(u, prices);
        usage.value = {
          input: usage.value.input + u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
          output: usage.value.output + u.outputTokens,
          cost: usage.value.cost + (cost ?? 0),
          unknown: usage.value.unknown + (cost === null ? 1 : 0),
        };
      },
    };
    return {
      params: data.run.params,
      stepKey: `workflow:${data.run.id}:${s.key}:${s.attempt}`,
      options,
      hooks: env.hooks ?? localHooks,
      onProgress: (note) => env.onProgress?.(note),
      output: (key) => {
        const other = data.steps.find((x) => x.key === key);
        const spec = def.steps.find((x) => x.key === key);
        if (other === undefined || other.output === null || spec === undefined) return null;
        const parsed = spec.parse(other.output);
        return parsed.ok ? parsed.value : null;
      },
    };
  }

  /** 采用一步：draft 写进作品并记下改动（撤回用），manual 做作者要做的那件事。返回给作者看的一句话与改动。 */
  async function adoptStep(port: SqlPort, def: AnyWorkflow, data: WorkflowRunWithSteps, idx: number, env: AdvanceEnv): Promise<Result<{ readonly note: string; readonly changes: readonly unknown[] | null }, AppError>> {
    const spec = def.steps[idx];
    const row = data.steps[idx];
    if (spec?.adopt === undefined || row === undefined) return err(invalid('这一步没有要采用的结果'));
    const before = spec.kind === 'draft' ? await tracker.capture() : null;
    const adopted = await spec.adopt(contextFor(def, data, idx, env, { value: EMPTY_USAGE }, undefined), row.output);
    if (!adopted.ok) return adopted;
    const after = before === null ? null : await tracker.capture();
    return ok({ note: adopted.value, changes: before === null || after === null ? null : tracker.diff(before, after) });
  }

  /** 执行第 idx 步（它已是下一步）：开始 → 执行 → 产出（或出错、中断）；“一路做完”时草稿直接采用。 */
  async function runStep(port: SqlPort, data: WorkflowRunWithSteps, idx: number, env: AdvanceEnv, prices: Prices | undefined): Promise<Result<WorkflowRunWithSteps, AppError>> {
    const def = defOf(data.run.workflow);
    if (def === null) return err(invalid(`不认得的工作流“${data.run.workflow}”`));
    const spec = def.steps[idx];
    if (spec === undefined) return err(invalid('这次运行的步骤与工作流的定义对不上'));
    const skip = spec.skipIf === undefined ? null : await spec.skipIf(contextFor(def, data, idx, env, { value: EMPTY_USAGE }, prices));
    if (skip !== null) return apply(port, data, { type: 'skip', idx }, { [idx]: { note: skip } });
    const started = await apply(port, data, { type: 'start', idx }, { [idx]: { startedAt: deps.clock.now(), finishedAt: null, note: '' } });
    if (!started.ok) return started;
    env.onStep?.(viewOf(started.value));
    const usage = { value: started.value.steps[idx]?.usage ?? EMPTY_USAGE };
    const c = contextFor(def, started.value, idx, env, usage, prices);
    let result: Result<StepResult<unknown>, AppError>;
    try {
      result = await spec.run(c);
    } catch (e) {
      // 用例以 Result 表达预期错误；这里只兜住意外的异常，这一步记为出错，不让推进停在“进行中”。
      result = err(invalid(`意外的错误：${e instanceof Error ? e.message : String(e)}`));
    }
    const current = await load(port, data.run.id);
    if (!current.ok) return current;
    const finished = { finishedAt: deps.clock.now(), usage: usage.value };
    if (!result.ok) {
      const stopped = env.signal?.aborted === true;
      return apply(port, current.value, { type: stopped ? 'interrupt' : 'fail', idx }, { [idx]: { ...finished, note: stopped ? '已停下，继续时从这一步重做' : describeError(result.error) } });
    }
    const output = result.value.output;
    if (spec.kind === 'manual') return apply(port, current.value, { type: 'produced', idx, waitForAuthor: true }, { [idx]: { ...finished, output, note: result.value.note } });
    if (spec.kind !== 'draft' || result.value.settled === true) return apply(port, current.value, { type: 'produced', idx, waitForAuthor: false }, { [idx]: { ...finished, output, note: result.value.note } });
    const confirmNote = spec.confirm === undefined ? null : await spec.confirm(c, output);
    const produced = await apply(port, current.value, { type: 'produced', idx, waitForAuthor: true }, { [idx]: { ...finished, output, edited: false, changes: null, note: confirmNote ?? result.value.note } });
    if (!produced.ok || current.value.run.mode !== 'auto' || confirmNote !== null) return produced;
    // 一路做完：草稿直接采用；采用不成时停在这一步，草稿还在。
    const adopted = await adoptStep(port, def, produced.value, idx, env);
    if (!adopted.ok) {
      const again = await load(port, data.run.id);
      if (!again.ok) return again;
      const s = again.value.steps[idx]!;
      const noted = await updateWorkflowSteps(port, data.run.id, [{ step: s, patch: { note: `没有采用成：${describeError(adopted.error)}` } }], ctx());
      return noted.ok ? ok(noted.value) : err(repo(noted.error));
    }
    return apply(port, produced.value, { type: 'adopt', idx }, { [idx]: { note: adopted.value.note, changes: adopted.value.changes } });
  }

  function withPort<T>(f: (port: SqlPort) => Promise<Result<T, AppError>>): Promise<Result<T, AppError>> {
    const port = project();
    return port === null ? Promise.resolve(err({ code: 'no_work' })) : f(port);
  }

  /** 作者对一步的操作：按状态机改状态，extra 为一并写的字段。 */
  const act = (runId: string, event: StepEvent, extra: Readonly<Record<number, StepPatch>> = {}) =>
    withPort(async (port) => {
      const data = await load(port, runId);
      if (!data.ok) return data;
      if (data.value.run.abandoned) return err(invalid('这次运行已经放弃'));
      const saved = await apply(port, data.value, event, extra);
      return saved.ok ? ok(viewOf(saved.value)) : saved;
    });

  return {
    /** 可用的工作流（卡片与助手）。 */
    workflowCatalog(): readonly WorkflowInfo[] {
      return WORKFLOW_KEYS.map((key) => {
        const def = ERASED[key];
        return { key, title: def.title, description: def.description, steps: def.steps.map((s) => ({ key: s.key, label: s.label, kind: s.kind })) };
      });
    },

    /** 开始前的预计用量与费用（按默认模型的价格；价格未知时费用为 null）。 */
    async quoteWorkflow(workflow: WorkflowKey, params: unknown): Promise<Result<WorkflowQuote, AppError>> {
      const def = ERASED[workflow];
      const p = def.parseParams(params);
      if (!p.ok) return err(invalid(p.error));
      const view = await host.planningView();
      const port = project();
      const lengths = port === null ? null : await chapterLengths(port);
      const words = lengths?.ok === true ? lengths.value.reduce((n, c) => n + c.length, 0) : 0;
      const book: BookSize = view.ok ? { chapters: view.value.chapters.length, written: view.value.chapters.filter((c) => c.hasText).length, words } : { chapters: 0, written: 0, words: 0 };
      const estimate = def.estimate(p.value, book);
      const price = await pricing();
      const cost = costOf({ inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, price?.prices);
      return ok({ ...estimate, costUsd: cost, model: price?.model ?? null });
    },

    /** 新建一次运行（步骤都为待做）；推进由调用方在后台进行。 */
    startWorkflow(request: StartWorkflowRequest): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        const def = ERASED[request.workflow];
        const p = def.parseParams(request.params);
        if (!p.ok) return err(invalid(p.error));
        if (request.budgetUsd !== null && !(request.budgetUsd > 0)) return err(invalid('预算上限须大于 0'));
        const created = await createWorkflowRun(
          port,
          {
            id: deps.ids.next(),
            workflow: request.workflow,
            title: def.runTitle(p.value),
            params: p.value as Readonly<Record<string, unknown>>,
            mode: request.mode,
            budgetUsd: request.budgetUsd,
            steps: def.steps.map((s) => s.key),
          },
          ctx(),
        );
        return created.ok ? ok(viewOf(created.value)) : err(repo(created.error));
      });
    },

    /** 这部作品的全部运行（最近的在前），带各步与状态。 */
    listWorkflows(): Promise<Result<WorkflowView[], AppError>> {
      return withPort(async (port) => {
        const runs = await listWorkflowRuns(port);
        if (!runs.ok) return err(repo(runs.error));
        const views: WorkflowView[] = [];
        for (const r of runs.value) {
          const data = await load(port, r.id);
          if (!data.ok) return data;
          views.push(viewOf(data.value));
        }
        return ok(views);
      });
    },

    workflowRun(runId: string): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        const data = await load(port, runId);
        return data.ok ? ok(viewOf(data.value)) : data;
      });
    },

    /**
     * 一步一步推进，直到需要作者（等作者、可能过时、须作者动手）、出错、预算用完、取消或做完。
     * 返回停在哪里与原因的一句话。
     */
    advanceWorkflow(runId: string, env: AdvanceEnv = {}): Promise<Result<AdvanceOutcome, AppError>> {
      return withPort(async (port) => {
        const price = await pricing();
        let data = await load(port, runId);
        for (;;) {
          if (!data.ok) return data;
          const view = viewOf(data.value);
          const stop = (summary: string) => ok({ view, summary });
          if (data.value.run.abandoned) return stop('这次运行已经放弃');
          if (env.signal?.aborted === true) return stop('已停下');
          const next = nextAction(data.value.steps);
          const label = (idx: number) => `第 ${idx + 1} 步“${view.steps[idx]?.label ?? ''}”`;
          switch (next.kind) {
            case 'finished':
              return stop(`${view.title}已全部做完`);
            case 'busy':
              return stop(`${label(next.idx)}正在进行`);
            case 'wait':
              return stop(`停在${label(next.idx)}，等你处理：${view.steps[next.idx]?.note ?? ''}`);
            case 'stale':
              return stop(`${label(next.idx)}可能过时（它前面的步骤重做或撤回过）：重做这一步，或保留它的结果`);
            case 'failed':
              return stop(`${label(next.idx)}出错：${view.steps[next.idx]?.note ?? ''}`);
            case 'run':
              break;
          }
          const budget = data.value.run.budgetUsd;
          if (budget !== null && view.spent.cost >= budget) return stop(`已用 $${view.spent.cost.toFixed(3)}，达到预算上限 $${budget}，停在${label(next.idx)}之前`);
          data = await runStep(port, data.value, next.idx, env, price?.prices);
          if (data.ok) env.onStep?.(viewOf(data.value));
        }
      });
    },

    /** 修改等作者处理的草稿（按这一步的结构校验）。 */
    editWorkflowStep(runId: string, idx: number, output: unknown): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        const data = await load(port, runId);
        if (!data.ok) return data;
        const def = defOf(data.value.run.workflow);
        const spec = def?.steps[idx];
        const row = data.value.steps[idx];
        if (spec === undefined || row === undefined) return err({ code: 'not_found' });
        if (row.status !== 'awaiting_author' || spec.kind !== 'draft') return err(invalid('这一步现在不能修改'));
        const parsed = spec.parse(output);
        if (!parsed.ok) return err(invalid(`修改后的结果不完整：${parsed.error}`));
        const saved = await updateWorkflowSteps(port, runId, [{ step: row, patch: { output: parsed.value, edited: true } }], ctx());
        return saved.ok ? ok(viewOf(saved.value)) : err(repo(saved.error));
      });
    },

    /** 采用等作者处理的一步（草稿写进作品，或做须作者动手的那件事）；会覆盖内容的步骤，作者点采用即确认。 */
    adoptWorkflowStep(runId: string, idx: number, env: AdvanceEnv = {}): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        const data = await load(port, runId);
        if (!data.ok) return data;
        if (data.value.run.abandoned) return err(invalid('这次运行已经放弃'));
        const def = defOf(data.value.run.workflow);
        if (def === null) return err(invalid(`不认得的工作流“${data.value.run.workflow}”`));
        const check = transition(data.value.steps, { type: 'adopt', idx });
        if (!check.ok) return err(invalid(check.error));
        const adopted = await adoptStep(port, def, data.value, idx, env);
        if (!adopted.ok) return adopted;
        const again = await load(port, runId);
        if (!again.ok) return again;
        const saved = await apply(port, again.value, { type: 'adopt', idx }, { [idx]: { note: adopted.value.note, changes: adopted.value.changes } });
        return saved.ok ? ok(viewOf(saved.value)) : saved;
      });
    },

    skipWorkflowStep: (runId: string, idx: number) => act(runId, { type: 'skip', idx }, { [idx]: { note: '已跳过' } }),
    redoWorkflowStep: (runId: string, idx: number) => act(runId, { type: 'redo', idx }, { [idx]: { note: '' } }),
    keepWorkflowStep: (runId: string, idx: number) => act(runId, { type: 'keep', idx }),

    /**
     * 撤回一次采用：经 AI 助手的撤销把作品改回采用之前（之后又改过的项不动并写明），这一步回到等作者，草稿还在。
     * 只有草稿步骤可以撤回；写章节的步骤请在各章“回退写手写入”。
     */
    withdrawWorkflowStep(runId: string, idx: number): Promise<Result<{ readonly view: WorkflowView; readonly note: string }, AppError>> {
      return withPort(async (port) => {
        const data = await load(port, runId);
        if (!data.ok) return data;
        const def = defOf(data.value.run.workflow);
        const row = data.value.steps[idx];
        if (def?.steps[idx]?.kind !== 'draft' || row === undefined) return err(invalid('只有采用过的草稿可以撤回'));
        const check = transition(data.value.steps, { type: 'withdraw', idx });
        if (!check.ok) return err(invalid(check.error));
        const undone = await tracker.undo(row.changes ?? []);
        if (!undone.ok) return undone;
        const { undone: back, skipped } = undone.value;
        const note = `撤回了采用${back.length > 0 ? `：${back.slice(0, 6).join('、')}${back.length > 6 ? '等' : ''}` : ''}${skipped.length > 0 ? `；没有改回：${skipped.slice(0, 6).join('；')}` : ''}`;
        const again = await load(port, runId);
        if (!again.ok) return again;
        const saved = await apply(port, again.value, { type: 'withdraw', idx }, { [idx]: { note, changes: null } });
        return saved.ok ? ok({ view: viewOf(saved.value), note }) : saved;
      });
    },

    /** 放弃这次运行：不再推进，记录与已经写进作品的内容都保留。 */
    abandonWorkflow(runId: string): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        const data = await load(port, runId);
        if (!data.ok) return data;
        if (data.value.steps.some((s) => s.status === 'running')) return err(invalid('还有一步在进行：先停下'));
        const abandoned = await abandonWorkflowRun(port, data.value.run, ctx());
        if (!abandoned.ok) return err(repo(abandoned.error));
        return ok(viewOf({ run: abandoned.value, steps: data.value.steps }));
      });
    },
  };
}

export type WorkflowUseCases = ReturnType<typeof workflowUseCases>;

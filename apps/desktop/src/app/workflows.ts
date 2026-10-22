// 写作工作流（需求 B78，施工文档 M6-01）：作者选一个工作流，软件按固定的步骤依次做，每步的结果存在作品里，
// 可以看、改、采用；可以停下、关掉应用后接着做、重做或跳过某一步，采用过的一步可以撤回。
// 这里是命令表（每个工作流一项：参数、预计用量与步骤）与执行器；步骤的状态转换在 packages/writing（纯函数）。
// 步骤只调用现有的用例，所以锁定设定、写入前快照、版本守卫与段落来源照常生效。
import { costOf, type CallOptions, type LlmUsage, type Prices } from '@fudiao/llm';
import { BenchmarkBookOutput, BenchmarkCompareOutput, BookSeedOutput, PlanDraftOutput, VolumeOutlineOutput } from '@fudiao/prompts';
import { err, ok, type Result, type WorkflowMode } from '@fudiao/shared';
import {
  abandonWorkflowRun,
  createWorkflowRun,
  getWorkflowRun,
  listChapterPlans,
  listWorkflowRuns,
  setWorkflowStepUsage,
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
import {
  bookVolumesContentTokens,
  planContentTokens,
  VOLUME_MODES,
  type AppliedDraft,
  type BookVolumesRequest,
  type PlanDraft,
  type PlanDraftRequest,
  type PlanningView,
  type VolumeMode,
  type VolumeOutline,
  type VolumeOutlineRequest,
} from './planning';
import { AuditSuspect, type LocatedSuspect } from './book-audit';
import type { OpeningDiagnosis, OpeningSurvey } from './opening';
import { CastDraft } from './cast-completion';
import { MIN_SAMPLE_CHARS, mergeSamples, type BenchmarkAnalysis, type BenchmarkBookInputForm, type BenchmarkCompare } from './benchmark';
import type { BenchmarkSampleInput } from '@fudiao/store';
import type { SkillStage } from '@fudiao/shared';
import type { CastGap } from '@fudiao/writing';
import { foreshadowAudit, type ForeshadowFinding } from '@fudiao/writing';
import { chapterLengths, type Chapter } from '@fudiao/store';
import type { AppDeps } from './ports';
import { seedContentTokens, type BookSeed, type BookSeedRequest, type QuickBookStatus } from './quick-book';
import { segmentContentTokens } from './writer';
import { THINKING_ALLOWANCE } from './thinking';

/** 工作流的键。新增工作流时在这里加一项，命令表的类型要求它有定义。 */
export const WORKFLOW_KEYS = ['quick_book', 'book_audit', 'next_volume', 'opening_polish', 'cast_completion', 'benchmark'] as const;
/** 要作者先导入材料、AI 助手不能直接发起的工作流（扫榜拆书要粘贴或导入榜单与样章）。 */
export const AUTHOR_STARTED_WORKFLOWS = ['benchmark'] as const;
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
   * ok 为是否全部写完；summary 是怎样结束的一句话；cancelled 为被停下（成书进度的“停下”、助手的 stop_background），这一步记为中断而不是出错。
   */
  writeChapters(chapterIds: readonly string[], review: boolean, options: CallOptions): Promise<HookOutcome>;
  /** 依次审核这些章（状态层经依次审核做，与成书进度、助手的后台审核同一时间只有一批）。ok 为是否全部审完。 */
  reviewChapters(chapterIds: readonly string[], options: CallOptions): Promise<HookOutcome>;
};

export type HookOutcome = { readonly ok: boolean; readonly summary: string; readonly cancelled?: boolean };

/** 钩子没有做完：被停下记为中断（继续时接着做），其余记为出错。 */
const hookFailure = (done: HookOutcome): AppError => (done.cancelled === true ? { code: 'interrupted', detail: done.summary } : invalid(done.summary));

/** 一步里的一件事（整理记忆、核对疑点、拆解一本）没有做成：这一步记为中断，继续时接着做同一次，做成的调用不再请求。 */
const interrupted = (detail: string): AppError => ({ code: 'interrupted', detail });

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
  readonly runId: string;
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
  /**
   * 采用（draft 写进作品；manual 是作者动手的那件事）。返回给作者看的一句话；写进作品后要记下什么
   * （例如新建的那一卷的标识）时连同改过的结果一起返回，存回这一步。
   */
  readonly adopt?: (ctx: StepContext<P>, output: O) => Promise<Result<Adopted<O>, AppError>>;
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
  readonly adopt?: (ctx: StepContext<P>, output: unknown) => Promise<Result<Adopted<unknown>, AppError>>;
  readonly confirm?: (ctx: StepContext<P>, output: unknown) => Promise<string | null>;
  readonly skipIf?: (ctx: StepContext<P>) => Promise<string | null>;
};

/** 采用的结果：一句话，或一句话加存回这一步的结果。 */
type Adopted<O> = string | { readonly note: string; readonly output: O };

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
  /** 这次运行要走哪些步（按键，顺序即执行顺序）；省略时走全部。一键成书按章数决定是一次拆完还是先卷纲再逐卷拆。 */
  readonly stepsFor?: (params: P) => readonly string[];
};

/** 去掉参数类型的工作流：参数在每次执行时按定义校验，命令表里各工作流的参数类型因此可以不同。 */
type AnyWorkflow = {
  readonly title: string;
  readonly description: string;
  readonly parseParams: (value: unknown) => Result<unknown, string>;
  readonly runTitle: (params: unknown) => string;
  readonly estimate: (params: unknown, book: BookSize) => WorkflowEstimate;
  readonly steps: readonly Step<unknown>[];
  readonly stepsFor: (params: unknown) => readonly string[];
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
    stepsFor: (v) => typed(v, (p) => def.stepsFor?.(p) ?? def.steps.map((s) => s.key), def.steps.map((s) => s.key)),
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
/** 一键成书的章数上限（连载规模）。 */
export const MAX_BOOK_CHAPTERS = 2_000;
/** 一次调用最多拆多少章的计划：更多的章数先定全书卷纲，再逐卷拆，每卷不超过这个数。 */
export const PLAN_CHAPTERS_PER_CALL = 30;
/** 自动分卷时每卷约多少章。 */
export const AUTO_CHAPTERS_PER_VOLUME = 20;

type VolumeChoice = { readonly chapters: number; readonly volumeMode: VolumeMode; readonly volumeCount: number | null };

/** 各卷的章数：平均分，前面的卷多一章。 */
export function distributeChapters(chapters: number, volumes: number): number[] {
  const count = Math.max(1, Math.min(volumes, chapters));
  const base = Math.floor(chapters / count);
  const extra = chapters % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** 分卷方式与章数搭不搭：不分卷与单卷最多 PLAN_CHAPTERS_PER_CALL 章；指定卷数时每卷不超过它。给作者看的问题，没有问题时为 null。 */
export function quickBookVolumeIssue(p: VolumeChoice): string | null {
  const least = Math.ceil(p.chapters / PLAN_CHAPTERS_PER_CALL);
  if (p.volumeMode === 'none') return p.chapters > PLAN_CHAPTERS_PER_CALL ? `不分卷最多 ${PLAN_CHAPTERS_PER_CALL} 章：${p.chapters} 章请选“自动分卷”或指定卷数（至少 ${least} 卷）` : null;
  if (p.volumeMode !== 'fixed') return null;
  const count = p.volumeCount ?? 0;
  if (count < 1) return '请填卷数';
  if (count > p.chapters) return '卷数不能多于章数';
  if (Math.ceil(p.chapters / count) > PLAN_CHAPTERS_PER_CALL) return `每卷最多 ${PLAN_CHAPTERS_PER_CALL} 章：${p.chapters} 章至少分 ${least} 卷`;
  return null;
}

/** 怎样拆章节计划：章数不多时一次拆完（分卷方式交给模板），否则先定全书卷纲、再按各卷的章数逐卷拆。 */
export type QuickBookPlanning = { readonly kind: 'single' } | { readonly kind: 'volumes'; readonly chapters: readonly number[] };
export function quickBookPlanning(p: VolumeChoice): QuickBookPlanning {
  if (p.chapters <= PLAN_CHAPTERS_PER_CALL) return { kind: 'single' };
  const count = p.volumeMode === 'fixed' ? Math.max(1, p.volumeCount ?? 1) : Math.ceil(p.chapters / AUTO_CHAPTERS_PER_VOLUME);
  return { kind: 'volumes', chapters: distributeChapters(p.chapters, count) };
}

export const QuickBookParams = z
  .object({
    idea: z.string(),
    genre: z.string(),
    chapters: z.number().int().min(1).max(MAX_BOOK_CHAPTERS),
    wordsPerChapter: z.number().int().min(500).max(20_000),
    /** 分卷方式与卷数（fixed 时用）。早先的运行没有这两项，按自动分卷。 */
    volumeMode: z.enum(VOLUME_MODES).default('auto'),
    volumeCount: z.number().int().min(1).max(200).nullable().default(null),
  })
  .superRefine((p, ctx) => {
    const issue = quickBookVolumeIssue(p);
    if (issue !== null) ctx.addIssue({ code: 'custom', message: issue, path: ['volumeCount'] });
  });
export type QuickBookParams = z.infer<typeof QuickBookParams>;

/** 全书体检的参数：范围（章节标识，null 为从头、到尾）与要不要重新审核已经审过的章节。 */
export const BookAuditParams = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  rereview: z.boolean(),
});
export type BookAuditParams = z.infer<typeof BookAuditParams>;

/** 续写一卷的参数：章数、每章字数与给这一卷的要求。 */
export const NextVolumeParams = z.object({
  chapters: z.number().int().min(1).max(100),
  wordsPerChapter: z.number().int().min(500).max(20_000),
  instruction: z.string(),
});
export type NextVolumeParams = z.infer<typeof NextVolumeParams>;

/** 开篇打磨的参数：诊断最前面的几章。 */
export const OpeningParams = z.object({ chapters: z.number().int().min(1).max(10) });
export type OpeningParams = z.infer<typeof OpeningParams>;

/** 扫榜拆书的参数：作者自己的想法（可为空）与导入了几条。榜单与样章不在参数里（参数随作品导出，样章不导出）。 */
export const BenchmarkParams = z.object({ idea: z.string(), entries: z.number().int().min(1) });
export type BenchmarkParams = z.infer<typeof BenchmarkParams>;

/** 人物补全没有参数。 */
export const CastParams = z.object({});
export type CastParams = z.infer<typeof CastParams>;

type ParamsOf = {
  readonly quick_book: QuickBookParams;
  readonly book_audit: BookAuditParams;
  readonly next_volume: NextVolumeParams;
  readonly opening_polish: OpeningParams;
  readonly cast_completion: CastParams;
  readonly benchmark: BenchmarkParams;
};

/** 工作流用到的现有用例（由应用服务提供）。 */
export type WorkflowHost = {
  reloadWork(): Promise<Result<{ readonly project: { readonly outline: string }; readonly volumes: readonly { readonly id: string; readonly title: string }[] }, AppError>>;
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
  saveContinuityIssues(chapterIds: readonly string[], located: readonly LocatedSuspect[], append?: readonly string[]): Promise<Result<number, AppError>>;
  draftVolumeOutline(request: VolumeOutlineRequest, options?: CallOptions): Promise<Result<VolumeOutline, AppError>>;
  applyVolumeOutline(outline: VolumeOutline): Promise<Result<{ readonly volume: { readonly id: string; readonly title: string }; readonly characters: number; readonly foreshadows: number }, AppError>>;
  draftVolumePlans(
    request: PlanDraftRequest & {
      readonly volumeId: string;
      readonly payoffs?: readonly string[];
      readonly bookVolumes?: readonly { readonly title: string; readonly summary: string }[];
      readonly laterVolumes?: boolean;
    },
    options?: CallOptions,
  ): Promise<Result<PlanDraft, AppError>>;
  draftBookVolumes(request: BookVolumesRequest, options?: CallOptions): Promise<Result<{ readonly volumes: readonly VolumeOutline[] }, AppError>>;
  applyBookVolumes(volumes: readonly VolumeOutline[]): Promise<Result<{ readonly volumes: readonly { readonly id: string; readonly title: string }[]; readonly characters: number; readonly foreshadows: number }, AppError>>;
  applyVolumeDraft(draft: PlanDraft, volumeId: string): Promise<Result<AppliedDraft, AppError>>;
  openingSurvey(count: number): Promise<Result<OpeningSurvey, AppError>>;
  diagnoseOpening(survey: OpeningSurvey, index: number, stepKey: string, options?: CallOptions): Promise<Result<OpeningDiagnosis, AppError>>;
  castSurvey(): Promise<Result<readonly CastGap[], AppError>>;
  draftCastCompletion(gaps: readonly CastGap[], stepKey: string, options?: CallOptions): Promise<Result<CastDraft, AppError>>;
  applyCastCompletion(draft: CastDraft): Promise<Result<{ readonly created: number; readonly updated: number; readonly relations: number; readonly skipped: readonly string[] }, AppError>>;
  saveBenchmarkSamples(runId: string, rows: readonly BenchmarkSampleInput[]): Promise<Result<number, AppError>>;
  benchmarkBooks(runId: string): Promise<Result<readonly { readonly idx: number; readonly title: string; readonly tags: string; readonly words: string; readonly chars: number }[], AppError>>;
  analyzeBook(runId: string, idx: number, stepKey: string, options?: CallOptions): Promise<Result<{ readonly analysis: BenchmarkAnalysis; readonly trimmed: number }, AppError>>;
  compareBooks(
    runId: string,
    rank: readonly { readonly title: string; readonly tags: string; readonly words: string }[],
    analyses: readonly { readonly title: string; readonly analysis: BenchmarkAnalysis }[],
    idea: string,
    stepKey: string,
    options?: CallOptions,
  ): Promise<Result<{ readonly compare: BenchmarkCompare; readonly trimmed: number }, AppError>>;
  clearBenchmark(runId: string): Promise<Result<number, AppError>>;
  addCustomSkill(name: string, instruction: string, description?: string, key?: string, stages?: readonly SkillStage[]): Promise<Result<unknown, AppError>>;
};

/** 中文正文每字约合的 Token 数（估算用，偏保守）。 */
const TOKENS_PER_CHAR = 1.5;
/**
 * 每次调用另计的思考 Token（先思考的模型思考计入输出）。M6-08 的真实试用（DeepSeek flash）里各工作流平均每次调用输出约 5,700，
 * 一键成书约 7,400，按各步正文估算的输出只有实际的三到五成；加上这一项后预计不再低于实际。
 */
const THINKING_TOKENS_PER_CALL = 6_000;

/**
 * 一键成书的一步要写的内容最多约多少 Token（不含思考）：骨架随章数，计划每章约 1,200，写手一段最多整章的目标字数。
 * 调用器会把每次请求的输出上限压到模型登记的最大输出，登记值比它小的模型写不完这一步。
 */
const quickBookOutputNeed = (p: QuickBookParams) => {
  const planning = quickBookPlanning(p);
  const perCall = planning.kind === 'single' ? p.chapters : Math.max(...planning.chapters);
  const outline = planning.kind === 'single' ? 0 : bookVolumesContentTokens(planning.chapters.length);
  return Math.max(seedContentTokens(p.chapters), planContentTokens(perCall), outline, segmentContentTokens(p.wordsPerChapter));
};

function quickBook(host: WorkflowHost, project: () => SqlPort | null): WorkflowDef<QuickBookParams> {
  return {
    title: '一键成书',
    description: '一句话的想法 → 大纲与人物 → 章节计划 → 写手写完并审核 → 导出',
    params: QuickBookParams,
    runTitle: (p) => `一键成书：${p.idea.trim() === '' ? '按已有大纲' : p.idea.trim().slice(0, 20)}`,
    // 章数不多时一次拆完章节计划；长篇先定全书卷纲，再按各卷的章数逐卷拆。
    stepsFor: (p) => (quickBookPlanning(p).kind === 'single' ? ['model', 'seed', 'plan', 'write', 'export'] : ['model', 'seed', 'volumes', 'volumePlans', 'write', 'export']),
    estimate(p) {
      const words = p.chapters * p.wordsPerChapter;
      const segments = p.chapters * Math.max(1, Math.ceil(p.wordsPerChapter / 1_500));
      const planning = quickBookPlanning(p);
      // 骨架一次；计划一次拆完，或全书卷纲一次加每卷一次；每章分段写、整理记忆、审核。
      const volumes = planning.kind === 'single' ? 0 : planning.chapters.length;
      const planCalls = planning.kind === 'single' ? 1 : 1 + volumes;
      return {
        calls: 1 + planCalls + segments + p.chapters * 2,
        inputTokens: Math.round(3_000 + 6_000 * planCalls + segments * 9_000 + p.chapters * 2 * 6_000 + words * TOKENS_PER_CHAR * 2),
        outputTokens: Math.round(2_000 + p.chapters * 150 + volumes * 700 + p.chapters * 800 + words * TOKENS_PER_CHAR + p.chapters * (1_500 + 3_000)),
      };
    },
    steps: [
      step<QuickBookParams, { readonly model: string }>({
        key: 'model',
        label: '检查模型',
        kind: 'check',
        output: z.object({ model: z.string() }),
        async run({ params }) {
          const status = await host.quickBookStatus();
          if (!status.ok) return status;
          const { model } = status.value;
          if (!model.ready) return err(invalid(`${model.problem ?? '默认模型不能用'}：请在“模型服务”里设置默认模型并运行能力自检`));
          // 登记的最大输出不够这一步要写的内容时在花钱之前就停下；没有登记能力的模型按保守的 4,096 计，先思考的模型思考也计入输出。
          const need = quickBookOutputNeed(params);
          const max = model.maxOutputTokens;
          const n = (x: number) => x.toLocaleString('en-US');
          if (max !== null && max < need) {
            return err(
              invalid(
                `“${model.name ?? ''}”登记的最大输出只有 ${n(max)} Token，不够这个工作流的一步要写的约 ${n(need)} Token：请在“模型服务”的“能力与价格”里把最大输出改成服务实际支持的数值（中转站的 DeepSeek 可以“采用内置的能力与价格”），或换一个模型`,
              ),
            );
          }
          const tight = max !== null && max < need + THINKING_ALLOWANCE ? `；登记的最大输出 ${n(max)} Token 只够写内容，先思考的模型思考也计入输出，被截断时请在“能力与价格”里调高` : '';
          return ok({ output: { model: model.name ?? '' }, note: `默认模型：${model.name ?? ''}${tight}` });
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
          const draft = await host.draftPlans({ chapterCount: params.chapters, wordsPerChapter: params.wordsPerChapter, stepKey, volumeMode: params.volumeMode, volumeCount: params.volumeCount }, options);
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
      step<QuickBookParams, BookVolumesStep>({
        key: 'volumes',
        label: '全书卷纲',
        kind: 'draft',
        output: BookVolumesStep,
        async run({ params, stepKey, options, onProgress }) {
          const planning = quickBookPlanning(params);
          const counts = planning.kind === 'volumes' ? planning.chapters : [params.chapters];
          onProgress(`正在把全书分成 ${counts.length} 卷：卷名、主线、新人物与伏笔`);
          const drafted = await host.draftBookVolumes({ volumes: counts, stepKey }, options);
          if (!drafted.ok) return drafted;
          return ok({ output: { volumes: [...drafted.value.volumes], chapters: [...counts], volumeIds: null }, note: `${counts.length} 卷：${drafted.value.volumes.map((v) => v.title).join('、')}` });
        },
        async adopt(_ctx, outline) {
          const applied = await host.applyBookVolumes(outline.volumes);
          if (!applied.ok) return applied;
          return ok({
            note: `已新建 ${applied.value.volumes.length} 卷，新人物 ${applied.value.characters} 个，新伏笔 ${applied.value.foreshadows} 条`,
            output: { ...outline, volumeIds: applied.value.volumes.map((v) => v.id) },
          });
        },
      }),
      step<QuickBookParams, z.infer<typeof VolumePlansReport>>({
        key: 'volumePlans',
        label: '逐卷拆章',
        kind: 'act',
        output: VolumePlansReport,
        async run({ params, stepKey, options, onProgress, output }) {
          const parsed = BookVolumesStep.safeParse(output('volumes'));
          const ids = parsed.success ? parsed.data.volumeIds : null;
          if (!parsed.success || ids === null) return err(invalid('先采用全书卷纲：各卷还没有建'));
          const outline = parsed.data;
          const view = await host.planningView();
          if (!view.ok) return view;
          const bookVolumes = outline.volumes.map((v) => ({ title: v.title, summary: v.summary }));
          const done: { readonly volumeId: string; readonly chapters: number }[] = [];
          let skipped = 0;
          // 按顺序逐卷拆：后一卷的前文是前一卷的章节。中断后接着做时，已经有了足够章节计划的卷不再拆。
          for (const [i, volumeId] of ids.entries()) {
            const volume = outline.volumes[i];
            const count = outline.chapters[i] ?? 0;
            if (volume === undefined || count <= 0) continue;
            const planned = view.value.chapters.filter((c) => c.chapter.volumeId === volumeId && c.plan !== null).length;
            if (planned >= count) {
              skipped += 1;
              done.push({ volumeId, chapters: planned });
              continue;
            }
            onProgress(`正在给第 ${i + 1} / ${ids.length} 卷“${volume.title}”拆 ${count} 章的章节计划`);
            const draft = await host.draftVolumePlans(
              { volumeId, payoffs: volume.payoffs, chapterCount: count, wordsPerChapter: params.wordsPerChapter, stepKey: `${stepKey}:${i}`, bookVolumes, laterVolumes: i < ids.length - 1 },
              options,
            );
            if (!draft.ok) {
              if (options.signal?.aborted === true) return draft;
              return err(interrupted(`“${volume.title}”的章节计划没有拆成：${describeError(draft.error)}${done.length > 0 ? `（前 ${done.length} 卷已拆好，继续时接着拆）` : ''}`));
            }
            const applied = await host.applyVolumeDraft(draft.value, volumeId);
            if (!applied.ok) return err(interrupted(`“${volume.title}”的章节计划没有写进作品：${describeError(applied.error)}`));
            done.push({ volumeId, chapters: draft.value.chapters.length });
          }
          const total = done.reduce((n, v) => n + v.chapters, 0);
          return ok({ output: { volumes: done, skipped }, note: `${done.length} 卷共 ${total} 章的计划已写进作品${skipped > 0 ? `（${skipped} 卷之前已拆好）` : ''}` });
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
          if (!written.ok) return err(hookFailure(written));
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

/** 扫榜拆书估算时每本样章按多少字算（样章最多给 15,000 字）。 */
const BENCHMARK_CHARS_FOR_ESTIMATE = 12_000;

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
            if (!built.ok) return err(interrupted(`《${c.chapter.title}》的长篇记忆没有整理成：${describeError(built.error)}${done.length > 0 ? `（已整理 ${done.length} 章，继续时接着整理）` : ''}`));
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
          if (!done.ok) return err(hookFailure(done));
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
          // 有没核对成的先不写入：继续时接着做同一次，核对成的调用不再请求，也不会把这些章旧的问题换掉。
          if (failed > 0) return err(interrupted(`${failed} 处疑点没有核对成（调用失败），已核对的 ${located.length} 处保留；点“继续”再试没核对成的`));
          // 范围的首章：它前面的章节不在范围里，那一对章节这次没有查，旧的跨章问题不换；一章之内的疑点（前后同一章）定位出的问题补进去。
          // 范围从全书第一章起时它前面没有章节，照常换。
          const all = await host.auditChapters(null, null);
          if (!all.ok) return all;
          const head = chapters.value[0];
          const partial = head !== undefined && all.value[0]?.id !== head.id;
          const saved = await host.saveContinuityIssues(
            chapters.value.slice(partial ? 1 : 0).map((c) => c.id),
            located,
            partial ? [head.id] : [],
          );
          if (!saved.ok) return saved;
          const unconfirmed = located.filter((l) => l.issues.length === 0).length;
          const dropped = located.reduce((n, l) => n + l.dropped, 0);
          return ok({
            output: { issues: saved.value, unconfirmed, dropped, failed },
            note: `${suspects.length === 0 ? '没有要核对的疑点' : `核对了 ${suspects.length} 处疑点，定位出 ${saved.value} 个问题`}${unconfirmed > 0 ? `；${unconfirmed} 处读了原文没有发现矛盾` : ''}`,
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

/** 续写一卷前补齐长篇记忆的章数：卷纲只读最近几章。 */
const NEXT_VOLUME_MEMORY_CHAPTERS = 10;
/** 本卷体检时带上前一卷的最后几章，查卷与卷之间接不接得上。 */
const VOLUME_BOUNDARY_CHAPTERS = 2;

const VolumeAuditReport = z.object({ suspects: z.number().int(), issues: z.number().int(), failed: z.number().int() });

/** 卷纲这一步的结果：模型给的卷纲，采用后记下新建的那一卷的标识（作者之后改卷名也找得到）。 */
const VolumeOutlineStep = VolumeOutlineOutput.extend({ volumeId: z.string().nullable().default(null) });
type VolumeOutlineStep = z.infer<typeof VolumeOutlineStep>;

/** 一键成书“全书卷纲”这一步的结果：各卷的卷纲与章数（作者可改），采用后记下新建各卷的标识。 */
export const BookVolumesStep = z.object({
  volumes: z.array(VolumeOutlineOutput),
  chapters: z.array(z.number().int().min(1)),
  volumeIds: z.array(z.string()).nullable().default(null),
});
export type BookVolumesStep = z.infer<typeof BookVolumesStep>;
/** 全书卷纲步骤的草稿（界面编辑用）；不是卷纲或不合格时为 null。 */
export const bookVolumesOf = (step: Pick<WorkflowStepView, 'output'>): BookVolumesStep | null => {
  const parsed = BookVolumesStep.safeParse(step.output);
  return parsed.success ? parsed.data : null;
};
/** “逐卷拆章”这一步的结果：各卷写进作品的章数。 */
const VolumePlansReport = z.object({ volumes: z.array(z.object({ volumeId: z.string(), chapters: z.number().int() })), skipped: z.number().int() });

function nextVolume(host: WorkflowHost): WorkflowDef<NextVolumeParams> {
  /** 采用卷纲时新建的那一卷：按记下的标识找；没有记下（旧的运行）时按卷名找最后一个同名的。 */
  const volumeOf = async (outline: unknown): Promise<Result<{ readonly id: string; readonly title: string; readonly payoffs: readonly string[] }, AppError>> => {
    const parsed = VolumeOutlineStep.safeParse(outline);
    if (!parsed.success) return err(invalid('先采用卷纲：这一卷还没有建'));
    const work = await host.reloadWork();
    if (!work.ok) return work;
    const found = work.value.volumes.find((v) => v.id === parsed.data.volumeId) ?? (parsed.data.volumeId === null ? work.value.volumes.filter((v) => v.title === parsed.data.title.trim()).at(-1) : undefined);
    if (found !== undefined) return ok({ ...found, payoffs: parsed.data.payoffs });
    return err(invalid(parsed.data.volumeId === null ? '先采用卷纲：这一卷还没有建' : `卷纲建的那一卷“${parsed.data.title.trim()}”已经删掉了：撤回“卷纲”的采用后再采用一次`));
  };
  const volumeChapters = async (volumeId: string) => {
    const view = await host.planningView();
    return view.ok ? ok(view.value.chapters.filter((c) => c.chapter.volumeId === volumeId)) : view;
  };
  return {
    title: '续写一卷',
    description: '补齐最近几章的长篇记忆 → 下一卷的卷纲 → 本卷章节计划 → 写手写完并审核 → 本卷体检',
    params: NextVolumeParams,
    runTitle: (p) => `续写一卷：${p.chapters} 章`,
    estimate(p) {
      const words = p.chapters * p.wordsPerChapter;
      const segments = p.chapters * Math.max(1, Math.ceil(p.wordsPerChapter / 1_500));
      const suspects = Math.min(10, Math.ceil(p.chapters / 2));
      return {
        calls: 2 + segments + p.chapters * 2 + 1 + suspects,
        inputTokens: Math.round(8_000 + 8_000 + segments * 9_000 + p.chapters * 2 * 6_000 + words * TOKENS_PER_CHAR * 2 + 4_000 + suspects * (p.wordsPerChapter * TOKENS_PER_CHAR * 2 + 2_000)),
        outputTokens: Math.round(3_000 + p.chapters * 800 + words * TOKENS_PER_CHAR + p.chapters * (1_500 + 3_000) + 3_000 + suspects * 1_500),
      };
    },
    steps: [
      step<NextVolumeParams, { readonly chapters: readonly string[] }>({
        key: 'memory',
        label: '补齐长篇记忆',
        kind: 'act',
        output: z.object({ chapters: z.array(z.string()) }),
        async run({ options, onProgress }) {
          const view = await host.planningView();
          if (!view.ok) return view;
          const recent = view.value.chapters.filter((c) => c.hasText).slice(-NEXT_VOLUME_MEMORY_CHAPTERS);
          if (recent.length === 0) return err(invalid('还没有写好的章节：续写一卷要接着前文写，先写几章，或用一键成书从头开始'));
          const todo = recent.filter((c) => c.memory === null || c.memory.status === 'stale');
          const done: string[] = [];
          for (const [i, c] of todo.entries()) {
            onProgress(`整理长篇记忆：第 ${i + 1} / ${todo.length} 章《${c.chapter.title}》`);
            const built = await host.buildMemory(c.chapter.id, options);
            if (!built.ok) return err(interrupted(`《${c.chapter.title}》的长篇记忆没有整理成：${describeError(built.error)}${done.length > 0 ? `（已整理 ${done.length} 章，继续时接着整理）` : ''}`));
            done.push(c.chapter.id);
          }
          return ok({ output: { chapters: done }, note: done.length === 0 ? '最近几章的长篇记忆都是最新的' : `整理了 ${done.length} 章的长篇记忆` });
        },
      }),
      step<NextVolumeParams, VolumeOutlineStep>({
        key: 'outline',
        label: '卷纲',
        kind: 'draft',
        output: VolumeOutlineStep,
        async run({ params, stepKey, options, onProgress }) {
          onProgress('正在规划下一卷：卷名、主线、新人物与伏笔');
          const outline = await host.draftVolumeOutline({ chapterCount: params.chapters, instruction: params.instruction, stepKey }, options);
          if (!outline.ok) return outline;
          return ok({ output: { ...outline.value, volumeId: null }, note: `${outline.value.title}：${outline.value.summary}` });
        },
        async adopt(_ctx, outline) {
          const applied = await host.applyVolumeOutline(outline);
          if (!applied.ok) return applied;
          return ok({
            note: `已新建“${applied.value.volume.title}”，新人物 ${applied.value.characters} 个，新伏笔 ${applied.value.foreshadows} 条`,
            output: { ...outline, volumeId: applied.value.volume.id },
          });
        },
      }),
      step<NextVolumeParams, PlanDraft>({
        key: 'plan',
        label: '本卷章节计划',
        kind: 'draft',
        output: PlanDraftOutput,
        async run({ params, stepKey, options, onProgress, output }) {
          const volume = await volumeOf(output('outline'));
          if (!volume.ok) return volume;
          onProgress(`正在给“${volume.value.title}”拆 ${params.chapters} 章的章节计划`);
          // 卷纲挑出的本卷要回收的伏笔传给拆章，两步才不会各说各的。
          const draft = await host.draftVolumePlans({ volumeId: volume.value.id, payoffs: volume.value.payoffs, chapterCount: params.chapters, wordsPerChapter: params.wordsPerChapter, stepKey }, options);
          if (!draft.ok) return draft;
          return ok({ output: draft.value, note: `“${volume.value.title}”${draft.value.chapters.length} 章的计划` });
        },
        async adopt({ output }, draft) {
          const volume = await volumeOf(output('outline'));
          if (!volume.ok) return volume;
          const applied = await host.applyVolumeDraft(draft, volume.value.id);
          if (!applied.ok) return applied;
          const missing = applied.value.unmatchedCast;
          return ok(`已在“${volume.value.title}”里新建 ${draft.chapters.length} 章并写上计划${missing.length > 0 ? `；这些人物还没有人物卡片：${missing.join('、')}` : ''}`);
        },
      }),
      step<NextVolumeParams, { readonly chapters: readonly string[]; readonly summary: string }>({
        key: 'write',
        label: '写完并审核',
        kind: 'act',
        output: z.object({ chapters: z.array(z.string()), summary: z.string() }),
        async run({ hooks, options, onProgress, output }) {
          const volume = await volumeOf(output('outline'));
          if (!volume.ok) return volume;
          const chapters = await volumeChapters(volume.value.id);
          if (!chapters.ok) return chapters;
          const todo = chapters.value.filter((c) => c.plan !== null && (c.plan.status === 'todo' || c.plan.status === 'writing'));
          if (todo.length === 0) return ok({ output: { chapters: [], summary: '' }, note: '这一卷没有待写的章节' });
          onProgress(`写手依次写“${volume.value.title}”的 ${todo.length} 章，每章写完整理长篇记忆并审核`);
          const ids = todo.map((c) => c.chapter.id);
          const written = await hooks.writeChapters(ids, true, options);
          if (!written.ok) return err(hookFailure(written));
          return ok({ output: { chapters: ids, summary: written.summary }, note: written.summary });
        },
      }),
      step<NextVolumeParams, z.infer<typeof VolumeAuditReport>>({
        key: 'audit',
        label: '本卷体检',
        kind: 'act',
        output: VolumeAuditReport,
        async run({ stepKey, options, onProgress, output }) {
          const volume = await volumeOf(output('outline'));
          if (!volume.ok) return volume;
          const view = await host.planningView();
          if (!view.ok) return view;
          const written = view.value.chapters.filter((c) => c.hasText);
          const first = written.findIndex((c) => c.chapter.volumeId === volume.value.id);
          if (first < 0) return ok({ output: { suspects: 0, issues: 0, failed: 0 }, note: '这一卷还没有写好的章节，没有体检' });
          const inVolume = written.filter((c) => c.chapter.volumeId === volume.value.id).map((c) => c.chapter.id);
          const range = [...written.slice(Math.max(0, first - VOLUME_BOUNDARY_CHAPTERS), first).map((c) => c.chapter.id), ...inVolume];
          onProgress(`由长篇记忆找“${volume.value.title}”里跨章的疑点`);
          const drafted = await host.draftSuspects(range, `${stepKey}:suspects`, options);
          if (!drafted.ok) return drafted;
          const suspects = drafted.value.suspects.filter((s) => inVolume.includes(s.laterId));
          const located: LocatedSuspect[] = [];
          let failed = 0;
          for (const [i, s] of suspects.entries()) {
            onProgress(`核对第 ${i + 1} / ${suspects.length} 处疑点`);
            const one = await host.locateSuspect(s, `${stepKey}:${i}`, options);
            if (!one.ok) {
              if (options.signal?.aborted === true) return one;
              failed += 1;
              continue;
            }
            located.push(one.value);
          }
          if (failed > 0) return err(interrupted(`${failed} 处疑点没有核对成（调用失败），已核对的 ${located.length} 处保留；点“继续”再试没核对成的`));
          const saved = await host.saveContinuityIssues(inVolume, located);
          if (!saved.ok) return saved;
          return ok({
            output: { suspects: suspects.length, issues: saved.value, failed },
            note: suspects.length === 0 ? '本卷没有找到跨章的疑点' : `核对了 ${suspects.length} 处疑点，定位出 ${saved.value} 个问题（列在各章的“审核”里）`,
          });
        },
      }),
    ],
  };
}

const Metrics = z.object({ words: z.number(), protagonistAt: z.number().nullable(), dialogueRatio: z.number(), namesInOpening: z.number(), longestParagraph: z.number() });
const Survey = z.object({
  protagonist: z.object({ id: z.string(), name: z.string() }).nullable(),
  chapters: z.array(z.object({ chapterId: z.string(), title: z.string(), metrics: Metrics })),
});
const IssueKey = z.object({ paragraphId: z.string(), kind: z.string(), description: z.string() });
// found、ignored 在 M6-08 之后才记下；之前的运行没有，对比时只比条数。
const Diagnosis = z.object({
  chapters: z.array(z.object({ chapterId: z.string(), title: z.string(), issues: z.number().int(), found: z.array(IssueKey).optional(), ignored: z.array(IssueKey).optional() })),
  dropped: z.number().int(),
});
type IssueKey = z.infer<typeof IssueKey>;
/** 同一条问题：同一段落、同一种类；段落换了（例如被改写拆合）时说明相同也算。 */
const sameIssue = (a: IssueKey, b: IssueKey) => a.kind === b.kind && (a.paragraphId === b.paragraphId || a.description === b.description);

/**
 * 开篇的前后对比（M6-08 第 7 项）：诊断出的问题复诊时不再出现的算解决（作者忽略的单算），复诊里诊断时没有的算新提。
 */
export function openingIssueChanges(before: readonly IssueKey[], after: readonly IssueKey[], ignored: readonly IssueKey[]): { readonly resolved: number; readonly ignored: number; readonly kept: number; readonly added: number } {
  const kept = before.filter((b) => after.some((a) => sameIssue(a, b)));
  const gone = before.filter((b) => !kept.includes(b));
  const skipped = gone.filter((b) => ignored.some((i) => sameIssue(i, b))).length;
  return { resolved: gone.length - skipped, ignored: skipped, kept: kept.length, added: after.filter((a) => !before.some((b) => sameIssue(a, b))).length };
}
const OpeningCompare = z.object({
  rows: z.array(
    z.object({
      chapterId: z.string(),
      title: z.string(),
      before: z.object({ issues: z.number().int(), metrics: Metrics }),
      after: z.object({ issues: z.number().int(), metrics: Metrics }),
      /** 解决、忽略、仍在与新提的条数；之前的运行没有记下问题时为空。 */
      changes: z.object({ resolved: z.number().int(), ignored: z.number().int(), kept: z.number().int(), added: z.number().int() }).optional(),
    }),
  ),
});
export type OpeningCompare = z.infer<typeof OpeningCompare>;

function openingPolish(host: WorkflowHost): WorkflowDef<OpeningParams> {
  /** 逐章诊断，每章一个步骤键：中断后接着做时，诊断过的不再请求。 */
  const diagnose = async (survey: OpeningSurvey, stepKey: string, options: CallOptions, onProgress: (note: string) => void): Promise<Result<StepResult<z.infer<typeof Diagnosis>>, AppError>> => {
    const rows: z.infer<typeof Diagnosis>['chapters'] = [];
    let dropped = 0;
    for (const [i, c] of survey.chapters.entries()) {
      onProgress(`按开篇的要求诊断第 ${i + 1} / ${survey.chapters.length} 章《${c.title}》`);
      const done = await host.diagnoseOpening(survey, i, `${stepKey}:${i}`, options);
      if (!done.ok) return options.signal?.aborted === true ? done : err(interrupted(`《${c.title}》没有诊断成：${describeError(done.error)}${rows.length > 0 ? `（已诊断 ${rows.length} 章，继续时接着诊断）` : ''}`));
      rows.push({ chapterId: c.chapterId, title: c.title, issues: done.value.issues, found: [...done.value.found], ignored: [...done.value.ignored] });
      dropped += done.value.dropped;
    }
    const total = rows.reduce((n, r) => n + r.issues, 0);
    return ok({ output: { chapters: rows, dropped }, note: `前 ${rows.length} 章诊断出 ${total} 个问题，列在各章的“审核”里${dropped > 0 ? `（${dropped} 条定位不到原文，已丢弃）` : ''}` });
  };
  const describe = (s: OpeningSurvey) => {
    const first = s.chapters[0];
    const at = first?.metrics.protagonistAt;
    return `${s.protagonist === null ? '没有推断出主角（还没有人物卡片，或人物没有在正文里出现）' : `主角：${s.protagonist.name}`}${first === undefined || s.protagonist === null ? '' : at === null ? `；《${first.title}》里主角没有出现` : `；《${first.title}》主角在第 ${at} 字之后出场`}`;
  };
  return {
    title: '开篇打磨',
    description: '算出开篇的数字 → 按开篇的要求逐章诊断 → 你处理问题（可交给写手修订）→ 复诊 → 对比前后',
    params: OpeningParams,
    runTitle: (p) => `开篇打磨：前 ${p.chapters} 章`,
    estimate(p, book) {
      const n = Math.min(p.chapters, Math.max(book.written, 1));
      const chapterTokens = (book.words > 0 ? book.words / Math.max(book.written, 1) : AUDIT_WORDS_PER_CHAPTER) * TOKENS_PER_CHAR;
      return { calls: n * 2, inputTokens: Math.round(n * 2 * (chapterTokens + 3_000)), outputTokens: n * 2 * 2_500 };
    },
    steps: [
      step<OpeningParams, OpeningSurvey>({
        key: 'metrics',
        label: '开篇的数字',
        kind: 'check',
        output: Survey,
        async run({ params }) {
          const survey = await host.openingSurvey(params.chapters);
          if (!survey.ok) return survey;
          return ok({ output: survey.value, note: describe(survey.value) });
        },
      }),
      step<OpeningParams, z.infer<typeof Diagnosis>>({
        key: 'diagnose',
        label: '逐章诊断',
        kind: 'act',
        output: Diagnosis,
        async run({ stepKey, options, onProgress, output }) {
          const survey = Survey.safeParse(output('metrics'));
          if (!survey.success) return err(invalid('先算出开篇的数字'));
          return diagnose(survey.data, stepKey, options, onProgress);
        },
      }),
      step<OpeningParams, { readonly done: boolean }>({
        key: 'handle',
        label: '处理问题',
        kind: 'manual',
        output: z.object({ done: z.boolean() }),
        run: () => Promise.resolve(ok({ output: { done: false }, note: '在各章的“审核”里逐条处理：忽略、自己改，或交给写手修订；处理完点“处理完了，复诊”' })),
        adopt: () => Promise.resolve(ok('处理完了，接着复诊')),
      }),
      step<OpeningParams, z.infer<typeof Diagnosis>>({
        key: 'recheck',
        label: '复诊',
        kind: 'act',
        output: Diagnosis,
        async run({ params, stepKey, options, onProgress }) {
          // 正文改过，重新算数字再诊断。
          const survey = await host.openingSurvey(params.chapters);
          if (!survey.ok) return survey;
          return diagnose(survey.value, stepKey, options, onProgress);
        },
      }),
      step<OpeningParams, OpeningCompare>({
        key: 'compare',
        label: '对比前后',
        kind: 'check',
        output: OpeningCompare,
        async run({ params, output }) {
          const before = Survey.safeParse(output('metrics'));
          const first = Diagnosis.safeParse(output('diagnose'));
          const second = Diagnosis.safeParse(output('recheck'));
          const now = await host.openingSurvey(params.chapters);
          if (!now.ok) return now;
          const rows = now.value.chapters.flatMap((c) => {
            const was = before.success ? before.data.chapters.find((x) => x.chapterId === c.chapterId) : undefined;
            if (was === undefined) return [];
            const one = first.success ? first.data.chapters.find((x) => x.chapterId === c.chapterId) : undefined;
            const two = second.success ? second.data.chapters.find((x) => x.chapterId === c.chapterId) : undefined;
            const changes = one?.found === undefined || two?.found === undefined ? undefined : openingIssueChanges(one.found, two.found, two.ignored ?? []);
            return [{ chapterId: c.chapterId, title: c.title, before: { issues: one?.issues ?? 0, metrics: was.metrics }, after: { issues: two?.issues ?? 0, metrics: c.metrics }, ...(changes === undefined ? {} : { changes }) }];
          });
          const b = rows.reduce((n, r) => n + r.before.issues, 0);
          const a = rows.reduce((n, r) => n + r.after.issues, 0);
          const sum = (k: 'resolved' | 'ignored' | 'added') => rows.reduce((n, r) => n + (r.changes?.[k] ?? 0), 0);
          const detail = rows.every((r) => r.changes !== undefined) ? `：解决 ${sum('resolved')} 个${sum('ignored') > 0 ? `、忽略 ${sum('ignored')} 个` : ''}，复诊新提 ${sum('added')} 个` : '';
          return ok({ output: { rows }, note: `开篇问题从 ${b} 个变为 ${a} 个${detail}` });
        },
      }),
    ],
  };
}

const Gaps = z.object({
  gaps: z.array(z.object({ id: z.string(), name: z.string(), noDescription: z.boolean(), noRelation: z.boolean(), firstChapterId: z.string().nullable(), chapters: z.number().int() })),
});

function castCompletion(host: WorkflowHost): WorkflowDef<CastParams> {
  return {
    title: '人物补全',
    description: '补齐长篇记忆 → 找出缺口 → 人物小传与关系的草稿 → 你逐项勾选后采用（只增不改）',
    params: CastParams,
    runTitle: () => '人物补全',
    estimate(_p, book) {
      const n = Math.max(book.written, 1);
      const chapterTokens = (book.words > 0 ? book.words / n : AUDIT_WORDS_PER_CHAPTER) * TOKENS_PER_CHAR;
      return { calls: n + 1, inputTokens: Math.round(n * (chapterTokens + 2_000) + Math.min(n * 300, 45_000) + 4_000), outputTokens: n * 1_500 + 6_000 };
    },
    steps: [
      step<CastParams, { readonly chapters: readonly string[] }>({
        key: 'memory',
        label: '补齐长篇记忆',
        kind: 'act',
        output: z.object({ chapters: z.array(z.string()) }),
        async run({ options, onProgress }) {
          const view = await host.planningView();
          if (!view.ok) return view;
          const written = view.value.chapters.filter((c) => c.hasText);
          if (written.length === 0) return err(invalid('还没有写好的章节：人物补全要从正文的长篇记忆里找'));
          const todo = written.filter((c) => c.memory === null || c.memory.status === 'stale');
          const done: string[] = [];
          for (const [i, c] of todo.entries()) {
            onProgress(`整理长篇记忆：第 ${i + 1} / ${todo.length} 章《${c.chapter.title}》`);
            const built = await host.buildMemory(c.chapter.id, options);
            if (!built.ok) return err(interrupted(`《${c.chapter.title}》的长篇记忆没有整理成：${describeError(built.error)}${done.length > 0 ? `（已整理 ${done.length} 章，继续时接着整理）` : ''}`));
            done.push(c.chapter.id);
          }
          return ok({ output: { chapters: done }, note: done.length === 0 ? `${written.length} 章的长篇记忆都是最新的` : `整理了 ${done.length} 章的长篇记忆` });
        },
      }),
      step<CastParams, z.infer<typeof Gaps>>({
        key: 'gaps',
        label: '找出缺口',
        kind: 'check',
        output: Gaps,
        async run() {
          const gaps = await host.castSurvey();
          if (!gaps.ok) return gaps;
          const noDescription = gaps.value.filter((g) => g.noDescription).length;
          const noRelation = gaps.value.filter((g) => g.noRelation).length;
          return ok({ output: { gaps: [...gaps.value] }, note: gaps.value.length === 0 ? '已有的人物卡片都有说明，出场的人物都有关系；下一步看正文里有没有还没建卡的人物' : `说明为空的人物 ${noDescription} 个，出场却没有关系的 ${noRelation} 个` });
        },
      }),
      step<CastParams, CastDraft>({
        key: 'draft',
        label: '小传与关系',
        kind: 'draft',
        output: CastDraft,
        async run({ stepKey, options, onProgress, output }) {
          const gaps = Gaps.safeParse(output('gaps'));
          onProgress('正在读各章的长篇记忆，写人物小传与关系');
          const draft = await host.draftCastCompletion(gaps.success ? gaps.data.gaps : [], stepKey, options);
          if (!draft.ok) return draft;
          const fresh = draft.value.characters.filter((c) => c.entityId === null).length;
          const n = draft.value.characters.length + draft.value.relationships.length;
          return ok({
            output: draft.value,
            note: n === 0 ? '没有要补的人物与关系' : `新人物 ${fresh} 个、补小传 ${draft.value.characters.length - fresh} 个、关系 ${draft.value.relationships.length} 条；不要的取消勾选再采用`,
            settled: n === 0,
          });
        },
        async adopt(_c, draft) {
          const applied = await host.applyCastCompletion(draft);
          if (!applied.ok) return applied;
          const { created, updated, relations, skipped } = applied.value;
          return ok(`新建人物 ${created} 个，补充说明 ${updated} 个，新建关系 ${relations} 条${skipped.length > 0 ? `；没有采用：${skipped.slice(0, 4).join('；')}` : ''}`);
        },
      }),
    ],
  };
}

const BenchmarkImport = z.object({ books: z.array(z.object({ idx: z.number().int(), title: z.string(), tags: z.string(), words: z.string(), chars: z.number().int() })) });
const BenchmarkAnalyses = z.object({ analyses: z.array(z.object({ idx: z.number().int(), title: z.string(), analysis: BenchmarkBookOutput, trimmed: z.number().int() })) });
const BenchmarkResult = BenchmarkCompareOutput.extend({ trimmed: z.number().int() });

function benchmark(host: WorkflowHost): WorkflowDef<BenchmarkParams> {
  return {
    title: '扫榜拆书',
    description: '粘贴或导入榜单与样章 → 逐本拆出结构与技法 → 横向对比与开书方向 → 存为规划技能 → 删除样章原文',
    params: BenchmarkParams,
    runTitle: (p) => `扫榜拆书：${p.entries} 本${p.idea.trim() === '' ? '' : `（${p.idea.trim().slice(0, 12)}）`}`,
    estimate(p) {
      const books = Math.max(1, Math.min(p.entries, 10));
      return { calls: books + 1, inputTokens: Math.round(books * (BENCHMARK_CHARS_FOR_ESTIMATE * TOKENS_PER_CHAR + 1_500) + 8_000), outputTokens: books * 2_500 + 3_500 };
    },
    steps: [
      step<BenchmarkParams, z.infer<typeof BenchmarkImport>>({
        key: 'import',
        label: '榜单与样章',
        kind: 'check',
        output: BenchmarkImport,
        async run({ runId }) {
          const books = await host.benchmarkBooks(runId);
          if (!books.ok) return books;
          const withText = books.value.filter((b) => b.chars >= MIN_SAMPLE_CHARS);
          if (withText.length === 0) return err(invalid('样章已经删掉了，或一本也没有样章：重新开始一次扫榜拆书'));
          return ok({ output: { books: [...books.value] }, note: `榜单 ${books.value.length} 条，其中 ${withText.length} 本有样章（共 ${withText.reduce((n, b) => n + b.chars, 0).toLocaleString('en-US')} 字）` });
        },
      }),
      step<BenchmarkParams, z.infer<typeof BenchmarkAnalyses>>({
        key: 'analyze',
        label: '逐本拆解',
        kind: 'act',
        output: BenchmarkAnalyses,
        async run({ runId, stepKey, options, onProgress, output }) {
          const imported = BenchmarkImport.safeParse(output('import'));
          const books = imported.success ? imported.data.books.filter((b) => b.chars >= MIN_SAMPLE_CHARS) : [];
          const analyses: z.infer<typeof BenchmarkAnalyses>['analyses'] = [];
          for (const [i, b] of books.entries()) {
            onProgress(`拆解第 ${i + 1} / ${books.length} 本《${b.title}》`);
            // 每本一个步骤键：中断后接着做时，拆过的不再请求。
            const done = await host.analyzeBook(runId, b.idx, `${stepKey}:${b.idx}`, options);
            if (!done.ok) return options.signal?.aborted === true ? done : err(interrupted(`《${b.title}》没有拆解成：${describeError(done.error)}${analyses.length > 0 ? `（已拆解 ${analyses.length} 本，继续时接着拆）` : ''}`));
            analyses.push({ idx: b.idx, title: b.title, analysis: done.value.analysis, trimmed: done.value.trimmed });
          }
          const trimmed = analyses.reduce((n, a) => n + a.trimmed, 0);
          return ok({ output: { analyses }, note: `拆解了 ${analyses.length} 本${trimmed > 0 ? `；${trimmed} 处与样章相同的长段文字已截短` : ''}` });
        },
      }),
      step<BenchmarkParams, z.infer<typeof BenchmarkResult>>({
        key: 'compare',
        label: '对标分析',
        kind: 'draft',
        output: BenchmarkResult,
        async run({ runId, params, stepKey, options, onProgress, output }) {
          const parsed = BenchmarkAnalyses.safeParse(output('analyze'));
          if (!parsed.success || parsed.data.analyses.length === 0) return err(invalid('先拆解至少一本'));
          const imported = BenchmarkImport.safeParse(output('import'));
          onProgress('横向对比几本的结构与技法，找空位与开书方向');
          const done = await host.compareBooks(
            runId,
            (imported.success ? imported.data.books : []).map((b) => ({ title: b.title, tags: b.tags, words: b.words })),
            parsed.data.analyses.map((a) => ({ title: a.title, analysis: a.analysis })),
            params.idea,
            stepKey,
            options,
          );
          if (!done.ok) return done;
          // 样章原文到这里用完（B79“用完即删”）：对比一结束就删，不等作者采用或再点“继续”；后面的“删除样章原文”一步只作兜底。
          const cleared = await host.clearBenchmark(runId);
          if (!cleared.ok) return cleared;
          return ok({ output: { ...done.value.compare, trimmed: done.value.trimmed }, note: `共性 ${done.value.compare.common.length} 条、空位 ${done.value.compare.gaps.length} 条、开书方向 ${done.value.compare.directions.length} 个；样章原文已从作品库删除；采用后存为一项规划技能` });
        },
        async adopt(_c, result) {
          if (result.skill.trim() === '') return err(invalid('对标分析里没有给规划用的指令：可以先改一改再采用'));
          const added = await host.addCustomSkill('对标分析', result.skill.trim(), '扫榜拆书得出的开局、卖点、节奏与人物配置的要求，生成大纲与章节计划时参考', '', ['planning']);
          if (!added.ok) return added;
          return ok('已存为规划技能“对标分析”（在“写作技能”里可以修改或停用）');
        },
      }),
      step<BenchmarkParams, { readonly cleared: number }>({
        key: 'clear',
        label: '删除样章原文',
        kind: 'check',
        output: z.object({ cleared: z.number().int() }),
        async run({ runId }) {
          const cleared = await host.clearBenchmark(runId);
          if (!cleared.ok) return cleared;
          return ok({ output: { cleared: cleared.value }, note: `样章原文${cleared.value > 0 ? '已从作品库删除' : '已经删除'}；拆解与对标分析只留结构与技法` });
        },
      }),
    ],
  };
}

export const benchmarkAnalysesOf = (step: Pick<WorkflowStepView, 'output'>) => {
  const parsed = BenchmarkAnalyses.safeParse(step.output);
  return parsed.success ? parsed.data.analyses : null;
};
export const benchmarkResultOf = (step: Pick<WorkflowStepView, 'output'>) => {
  const parsed = BenchmarkResult.safeParse(step.output);
  return parsed.success ? parsed.data : null;
};

export const castDraftOf = (step: Pick<WorkflowStepView, 'output'>): CastDraft | null => {
  const parsed = CastDraft.safeParse(step.output);
  return parsed.success ? parsed.data : null;
};

export const openingCompareOf = (step: Pick<WorkflowStepView, 'output'>): OpeningCompare | null => {
  const parsed = OpeningCompare.safeParse(step.output);
  return parsed.success ? parsed.data : null;
};
export const diagnosisOf = (step: Pick<WorkflowStepView, 'output'>) => {
  const parsed = Diagnosis.safeParse(step.output);
  return parsed.success ? parsed.data : null;
};

export const volumeOutlineOf = (step: Pick<WorkflowStepView, 'output'>): VolumeOutline | null => {
  const parsed = VolumeOutlineOutput.safeParse(step.output);
  return parsed.success ? parsed.data : null;
};

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
    next_volume: nextVolume(host),
    opening_polish: openingPolish(host),
    cast_completion: castCompletion(host),
    benchmark: benchmark(host),
  };
  const ERASED: { readonly [K in WorkflowKey]: AnyWorkflow } = { quick_book: erase(WORKFLOWS.quick_book), book_audit: erase(WORKFLOWS.book_audit), next_volume: erase(WORKFLOWS.next_volume), opening_polish: erase(WORKFLOWS.opening_polish),
    cast_completion: erase(WORKFLOWS.cast_completion),
    benchmark: erase(WORKFLOWS.benchmark),
  };
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

  /** 第 idx 步的定义：按这一步的键找（一次运行的步骤可以是定义的一部分，序号与定义不一定对齐）。 */
  const specAt = (def: AnyWorkflow, data: WorkflowRunWithSteps, idx: number): Step<unknown> | undefined => {
    const key = data.steps[idx]?.key;
    return key === undefined ? undefined : def.steps.find((x) => x.key === key);
  };

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

  /**
   * 执行一步时的控制：预算上限与这一步之前已用的费用（达到上限后这一步不再开始新的调用，进行中的照常做完）；
   * 用量每收到一次就写回作品库（不带版本守卫），中途崩溃时已发生的费用不丢。
   */
  type StepControl = {
    readonly budget: number | null;
    readonly spentBefore: number;
    /** 这一步的用量使总费用达到上限。 */
    readonly onBudget: () => void;
    /** 下一次调用开始前问：达到上限时给出原因。 */
    readonly beforeCall: () => string | null;
    readonly port: SqlPort;
  };

  function contextFor(def: AnyWorkflow, data: WorkflowRunWithSteps, idx: number, env: AdvanceEnv, usage: { value: StepUsage }, prices: Prices | undefined, control?: StepControl): StepContext<unknown> {
    const s = data.steps[idx]!;
    const options: CallOptions = {
      ...(env.signal !== undefined && { signal: env.signal }),
      ...(control !== undefined && { beforeCall: control.beforeCall }),
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
        if (control === undefined) return;
        void setWorkflowStepUsage(control.port, data.run.id, idx, usage.value, ctx());
        if (control.budget !== null && control.spentBefore + usage.value.cost >= control.budget) control.onBudget();
      },
    };
    return {
      runId: data.run.id,
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

  /**
   * 采用一步：draft 写进作品并记下改动（撤回用），manual 做作者要做的那件事。返回给作者看的一句话、改动与要存回的结果。
   * 动作品之前先以版本守卫在这一步上记一笔：两处同时采用（成书页与 AI 助手、“一路做完”与作者）时后到的在动作品之前就失败，
   * 草稿不会写进作品两遍。
   */
  async function adoptStep(port: SqlPort, def: AnyWorkflow, data: WorkflowRunWithSteps, idx: number, env: AdvanceEnv): Promise<Result<{ readonly note: string; readonly changes: readonly unknown[] | null; readonly output?: unknown }, AppError>> {
    const spec = specAt(def, data, idx);
    const row = data.steps[idx];
    if (spec?.adopt === undefined || row === undefined) return err(invalid('这一步没有要采用的结果'));
    const claimed = await updateWorkflowSteps(port, data.run.id, [{ step: row, patch: {} }], ctx());
    if (!claimed.ok) return err(claimed.error.code === 'conflict' ? invalid('这一步刚被采用或改过（可能是 AI 助手或“一路做完”）：重新打开成书页再看') : repo(claimed.error));
    const before = spec.kind === 'draft' ? await tracker.capture() : null;
    const adopted = await spec.adopt(contextFor(def, data, idx, env, { value: EMPTY_USAGE }, undefined), row.output);
    if (!adopted.ok) {
      // 采用到一半失败（例如作者同时改了某条伏笔）：已经写进作品的部分按差别改回，不留下半套章节或人物；之后又改过的不动并写明。
      const now = before === null ? null : await tracker.capture();
      if (before === null || now === null) return adopted;
      const partial = tracker.diff(before, now);
      if (partial.length === 0) return adopted;
      const undone = await tracker.undo(partial);
      const note = undone.ok ? `；已写入的部分已改回${undone.value.skipped.length > 0 ? `（没有改回：${undone.value.skipped.slice(0, 3).join('；')}）` : ''}` : '；已写入的部分没有改回成';
      return err(invalid(`${describeError(adopted.error)}${note}`));
    }
    const after = before === null ? null : await tracker.capture();
    const changes = before === null || after === null ? null : tracker.diff(before, after);
    if (typeof adopted.value === 'string') return ok({ note: adopted.value, changes });
    const output = spec.parse(adopted.value.output);
    if (!output.ok) return err(invalid(`采用后的结果不完整：${output.error}`));
    return ok({ note: adopted.value.note, changes, output: output.value });
  }

  /** 采用后写回这一步：状态、说明、改动，以及采用时改过的结果。 */
  const adoptPatch = (adopted: { readonly note: string; readonly changes: readonly unknown[] | null; readonly output?: unknown }): StepPatch => ({
    note: adopted.note,
    changes: adopted.changes,
    ...(adopted.output !== undefined && { output: adopted.output }),
  });

  /**
   * 执行结束后写回这一步：先重新读取（执行期间用量写回不改版本，但作者可能放弃了运行、助手可能动过这一步）；
   * 版本不符时再读一次重试，不让这一步因为一次冲突留在“进行中”。
   */
  async function applyAfterRun(port: SqlPort, runId: string, event: StepEvent, extra: Readonly<Record<number, StepPatch>>): Promise<Result<WorkflowRunWithSteps, AppError>> {
    for (let attempt = 0; ; attempt++) {
      const current = await load(port, runId);
      if (!current.ok) return current;
      const saved = await apply(port, current.value, event, extra);
      if (saved.ok || attempt > 0 || saved.error.code !== 'repo' || saved.error.error.code !== 'conflict') return saved;
    }
  }

  /** 执行第 idx 步（它已是下一步）：开始 → 执行 → 产出（或出错、中断）；“一路做完”时草稿直接采用。 */
  async function runStep(port: SqlPort, data: WorkflowRunWithSteps, idx: number, env: AdvanceEnv, prices: Prices | undefined): Promise<Result<WorkflowRunWithSteps, AppError>> {
    const def = defOf(data.run.workflow);
    if (def === null) return err(invalid(`不认得的工作流“${data.run.workflow}”`));
    const spec = specAt(def, data, idx);
    if (spec === undefined) return err(invalid('这次运行的步骤与工作流的定义对不上'));
    const skip = spec.skipIf === undefined ? null : await spec.skipIf(contextFor(def, data, idx, env, { value: EMPTY_USAGE }, prices));
    if (skip !== null) return apply(port, data, { type: 'skip', idx }, { [idx]: { note: skip } });
    const started = await apply(port, data, { type: 'start', idx }, { [idx]: { startedAt: deps.clock.now(), finishedAt: null, note: '' } });
    if (!started.ok) return started;
    env.onStep?.(viewOf(started.value));
    const usage = { value: started.value.steps[idx]?.usage ?? EMPTY_USAGE };
    // 预算（B78）：这一步里每次调用的用量都和上限比较，达到后不再开始新的调用（写章节的一步占去大半费用，不能只在步与步之间看）；
    // 进行中的调用照常做完、结果照常记下，一步只剩这一次调用时这一步照常完成。
    const budget = started.value.run.budgetUsd;
    const spentBefore = viewOf(started.value).spent.cost - usage.value.cost;
    let budgetHit = false;
    const control: StepControl = {
      budget,
      spentBefore,
      onBudget: () => {
        budgetHit = true;
      },
      beforeCall: () => (budgetHit ? `已用 $${(spentBefore + usage.value.cost).toFixed(3)}，达到预算上限 $${budget ?? 0}` : null),
      port,
    };
    const c = contextFor(def, started.value, idx, env, usage, prices, control);
    let result: Result<StepResult<unknown>, AppError>;
    try {
      result = await spec.run(c);
    } catch (e) {
      // 用例以 Result 表达预期错误；这里只兜住意外的异常，这一步记为出错，不让推进停在“进行中”。
      result = err(invalid(`意外的错误：${e instanceof Error ? e.message : String(e)}`));
    }
    const finished = { finishedAt: deps.clock.now(), usage: usage.value };
    if (!result.ok) {
      const stopped = env.signal?.aborted === true;
      const note = stopped
        ? '已停下，继续时接着做这一步'
        : budgetHit
          ? `已用 $${(spentBefore + usage.value.cost).toFixed(3)}，达到预算上限 $${budget ?? 0}，停在这一步中途；提高上限后继续`
          : describeError(result.error);
      return applyAfterRun(port, data.run.id, { type: stopped || budgetHit || result.error.code === 'interrupted' ? 'interrupt' : 'fail', idx }, { [idx]: { ...finished, note } });
    }
    const output = result.value.output;
    if (spec.kind === 'manual') return applyAfterRun(port, data.run.id, { type: 'produced', idx, waitForAuthor: true }, { [idx]: { ...finished, output, note: result.value.note } });
    if (spec.kind !== 'draft' || result.value.settled === true) return applyAfterRun(port, data.run.id, { type: 'produced', idx, waitForAuthor: false }, { [idx]: { ...finished, output, note: result.value.note } });
    const confirmNote = spec.confirm === undefined ? null : await spec.confirm(c, output);
    const produced = await applyAfterRun(port, data.run.id, { type: 'produced', idx, waitForAuthor: true }, { [idx]: { ...finished, output, edited: false, changes: null, note: confirmNote ?? result.value.note } });
    if (!produced.ok || produced.value.run.mode !== 'auto' || confirmNote !== null) return produced;
    // 一路做完：草稿直接采用；采用不成时停在这一步，草稿还在。
    const adopted = await adoptStep(port, def, produced.value, idx, env);
    const again = await load(port, data.run.id);
    if (!again.ok) return again;
    if (!adopted.ok) {
      const s = again.value.steps[idx]!;
      const noted = await updateWorkflowSteps(port, data.run.id, [{ step: s, patch: { note: `没有采用成：${describeError(adopted.error)}` } }], ctx());
      return noted.ok ? ok(noted.value) : err(repo(noted.error));
    }
    return apply(port, again.value, { type: 'adopt', idx }, { [idx]: adoptPatch(adopted.value) });
  }

  function withPort<T>(f: (port: SqlPort) => Promise<Result<T, AppError>>): Promise<Result<T, AppError>> {
    const port = project();
    return port === null ? Promise.resolve(err({ code: 'no_work' })) : f(port);
  }

  /** 作者对一步的操作：按状态机改状态，extra 为一并写的字段。 */
  /** 作品现在的规模（估算用）。 */
  async function currentSize(): Promise<BookSize> {
    const view = await host.planningView();
    const port = project();
    const lengths = port === null ? null : await chapterLengths(port);
    const words = lengths?.ok === true ? lengths.value.reduce((n, c) => n + c.length, 0) : 0;
    return view.ok ? { chapters: view.value.chapters.length, written: view.value.chapters.filter((c) => c.hasText).length, words } : { chapters: 0, written: 0, words: 0 };
  }

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

    /**
     * 开始前的预计用量与费用（按默认模型的价格；价格未知时费用为 null）。
     * assumed 是假定的作品规模：试用脚本（tools/workflow-eval）在章节写出来之前估算后面的工作流时用；不给时按作品现状。
     */
    async quoteWorkflow(workflow: WorkflowKey, params: unknown, assumed?: BookSize): Promise<Result<WorkflowQuote, AppError>> {
      const def = ERASED[workflow];
      const p = def.parseParams(params);
      if (!p.ok) return err(invalid(p.error));
      const book = assumed ?? (await currentSize());
      const base = def.estimate(p.value, book);
      const estimate = { ...base, outputTokens: base.outputTokens + base.calls * THINKING_TOKENS_PER_CALL };
      const price = await pricing();
      const cost = costOf({ inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, price?.prices);
      return ok({ ...estimate, costUsd: cost, model: price?.model ?? null });
    },

    /** 新建一次运行（步骤都为待做）；推进由调用方在后台进行。 */
    startWorkflow(request: StartWorkflowRequest): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        if (request.workflow === 'benchmark') return err(invalid('扫榜拆书要先在成书页粘贴或导入榜单与样章'));
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
            steps: def.stepsFor(p.value),
          },
          ctx(),
        );
        return created.ok ? ok(viewOf(created.value)) : err(repo(created.error));
      });
    },

    /**
     * 开始一次扫榜拆书：榜单（粘贴的文字）与样章（书名与原文）存进本机的样章表，不进运行的参数；
     * 至少一本样章不少于 200 字。推进由调用方在后台进行。
     */
    startBenchmark(request: { readonly rankText: string; readonly books: readonly BenchmarkBookInputForm[]; readonly idea: string; readonly mode: WorkflowMode; readonly budgetUsd: number | null }): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        const rows = mergeSamples(request.rankText, request.books);
        if (rows.length === 0) return err(invalid('先粘贴榜单，或至少导入一本对标作品的样章'));
        if (!rows.some((r) => r.text.trim().length >= MIN_SAMPLE_CHARS)) return err(invalid(`至少粘贴或导入一本对标作品的样章（不少于 ${MIN_SAMPLE_CHARS} 字）`));
        const def = ERASED.benchmark;
        const created = await createWorkflowRun(
          port,
          { id: deps.ids.next(), workflow: 'benchmark', title: def.runTitle({ idea: request.idea, entries: rows.length }), params: { idea: request.idea, entries: rows.length }, mode: request.mode, budgetUsd: request.budgetUsd, steps: def.steps.map((s) => s.key) },
          ctx(),
        );
        if (!created.ok) return err(repo(created.error));
        const saved = await host.saveBenchmarkSamples(created.value.run.id, rows);
        if (!saved.ok) {
          await abandonWorkflowRun(port, created.value.run, ctx());
          return saved;
        }
        return ok(viewOf(created.value));
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
          if (!data.ok) return data;
          env.onStep?.(viewOf(data.value));
          // 这一步没做完就停了（作者停下、预算用完、其中几件事没做成）：不接着做，说明停在哪里；继续时接着做同一次。
          const after = data.value.steps[next.idx];
          if (after?.status === 'interrupted') return ok({ view: viewOf(data.value), summary: `停在${label(next.idx)}中途：${after.note}` });
        }
      });
    },

    /** 修改等作者处理的草稿（按这一步的结构校验）。 */
    editWorkflowStep(runId: string, idx: number, output: unknown): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        const data = await load(port, runId);
        if (!data.ok) return data;
        const def = defOf(data.value.run.workflow);
        const spec = def === null ? undefined : specAt(def, data.value, idx);
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
        const saved = await apply(port, again.value, { type: 'adopt', idx }, { [idx]: adoptPatch(adopted.value) });
        return saved.ok ? ok(viewOf(saved.value)) : saved;
      });
    },

    /** 等作者处理的一步采用前要作者确认的说明（会覆盖或删除作品内容）；不需要确认、或这一步不在等作者时为 null。 */
    stepConfirmNote(runId: string, idx: number): Promise<Result<string | null, AppError>> {
      return withPort(async (port) => {
        const data = await load(port, runId);
        if (!data.ok) return data;
        const def = defOf(data.value.run.workflow);
        const spec = def === null ? undefined : specAt(def, data.value, idx);
        const row = data.value.steps[idx];
        if (def === null || spec === undefined || row === undefined) return err({ code: 'not_found' });
        if (row.status !== 'awaiting_author' || spec.confirm === undefined) return ok(null);
        return ok(await spec.confirm(contextFor(def, data.value, idx, {}, { value: EMPTY_USAGE }, undefined), row.output));
      });
    },

    skipWorkflowStep: (runId: string, idx: number) => act(runId, { type: 'skip', idx }, { [idx]: { note: '已跳过' } }),
    /** 重做一步。已经采用进作品的草稿先撤回再重做：不然撤回的记录会被新的结果冲掉，再采用时又在旧内容上叠一遍（例如建出两卷）。 */
    redoWorkflowStep(runId: string, idx: number): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        const data = await load(port, runId);
        if (!data.ok) return data;
        const row = data.value.steps[idx];
        const def = defOf(data.value.run.workflow);
        const spec = def === null ? undefined : specAt(def, data.value, idx);
        if (row?.status === 'done' && spec?.kind === 'draft' && row.changes !== null) return err(invalid('这一步的草稿已经采用进作品：先“撤回这次采用”，再重做'));
        return act(runId, { type: 'redo', idx }, { [idx]: { note: '' } });
      });
    },
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
        if (def === null || specAt(def, data.value, idx)?.kind !== 'draft' || row === undefined) return err(invalid('只有采用过的草稿可以撤回'));
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

    /**
     * 放弃这次运行：不再推进，记录与已经写进作品的内容都保留。调用方（状态层）保证它没有在后台推进；
     * 还标着进行中的一步（写回失败时留下的）改为中断，不让这次运行放弃不了。
     */
    abandonWorkflow(runId: string): Promise<Result<WorkflowView, AppError>> {
      return withPort(async (port) => {
        let data = await load(port, runId);
        if (!data.ok) return data;
        const running = data.value.steps.findIndex((s) => s.status === 'running');
        if (running >= 0) {
          data = await apply(port, data.value, { type: 'interrupt', idx: running }, { [running]: { finishedAt: deps.clock.now(), note: '放弃时还在进行' } });
          if (!data.ok) return data;
        }
        // 扫榜拆书的样章是别人的作品：先删掉再放弃，删不成时这次运行还能再放弃一次。
        if (data.value.run.workflow === 'benchmark') {
          const cleared = await host.clearBenchmark(runId);
          if (!cleared.ok) return cleared;
        }
        const abandoned = await abandonWorkflowRun(port, data.value.run, ctx());
        if (!abandoned.ok) return err(repo(abandoned.error));
        return ok(viewOf({ run: abandoned.value, steps: data.value.steps }));
      });
    },
  };
}

export type WorkflowUseCases = ReturnType<typeof workflowUseCases>;

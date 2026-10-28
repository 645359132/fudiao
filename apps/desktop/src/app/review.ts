// 审核代理的用例（需求 B64，施工文档第五章“写手与审核”）。
// 先做程序检查（packages/writing，纯函数），再做模型审核；模型用标签指代段落与依据，
// 定位不到原文、依据不存在的问题丢弃。问题是派生结论（硬性规则 21）：记录段落版本与调用记录，段落改过后标为过期。
// 作者可以忽略、标为已修改，或交给写手修订：写手只改问题所在的段落，写入前保存快照。
// 一键交给写手修订（B64 补充）：一章或几章里待处理的问题逐条走同一个修订用例，前一条改了段落后后面的问题重新定位。
import { costOf, type CallOptions, type Prices } from '@fudiao/llm';
import { createEntityMatcher } from '@fudiao/editor';
import { ChapterReviewOutput, renderChapterReview, renderWriterRevise } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  applyRangeReplace,
  countPendingIssues,
  createSnapshot,
  findCallByRequestHash,
  getChapterPlan,
  getIssue,
  getProject,
  listChapterMemories,
  listChapters,
  listChaptersWithText,
  listEntities,
  listFacts,
  listForeshadows,
  listIssues,
  listParagraphs,
  listPendingIssueSizes,
  planRangeReplace,
  reanchorIssue,
  replacePendingIssues,
  reviewStaleIssues,
  setIssueStatus,
  setPlanStatus,
  type Chapter,
  type ChapterPlan,
  type Entity,
  type Fact,
  type Foreshadow,
  type IssueEvidence,
  type IssueSeverity,
  type IssueSource,
  type RepoError,
  type ReviewIssue,
  type SavedParagraph,
  type SqlPort,
} from '@fudiao/store';
import {
  dropHandled,
  effectiveAvoidPhrases,
  foreshadowsForChapter,
  factApplies,
  normalizePunctuation,
  paragraphLabel,
  relocateIssue,
  resolveModelIssues,
  runProgramChecks,
  splitParagraphs,
  type PlanItem,
  type ProgramIssue,
} from '@fudiao/writing';
import { describeError, type AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import { THINKING_TOKENS_PER_CALL, TOKENS_PER_CHAR } from './thinking';
import type { AppDeps } from './ports';

/** 带给审核的设定与事实的上限；出场人物优先，其余按在正文中出现的次数。 */
export const MAX_REVIEW_ENTITIES = 40;
export const MAX_REVIEW_FACTS = 40;
/** 前文梗概最多带多少字，超出时先去掉最远的章节。 */
export const REVIEW_MEMORY_CHARS = 6000;
/** 审核的输出上限：每条问题约一百字，另留出思考的余量。 */
export const REVIEW_OUTPUT_TOKENS = 8_000 + THINKING_ALLOWANCE;

const ENTITY_KIND: Readonly<Record<Entity['kind'], string>> = { character: '人物', location: '地点', organization: '组织', item: '物品', rule: '世界规则' };

/** 审核问题与它的依据（已写成文字，给作者看，也交给写手修订）。 */
export type ReviewIssueView = ReviewIssue & { readonly evidenceText: readonly string[] };

export type ReviewOutcome = {
  /** 这一章现在待处理的问题，严重的在前。 */
  readonly issues: readonly ReviewIssueView[];
  /** 模型审核是否完成；没有完成时 reason 写明原因，程序检查的问题仍然保留。 */
  readonly modelReviewed: boolean;
  readonly reason: string | null;
  /** 模型提出、但定位不到原文或依据不存在而丢弃的问题数。 */
  readonly dropped: number;
};

/**
 * 连续处理多章（写手依次写完并审核、依次审核、写作工作流）时，模型审核没有完成（例如思考用满输出上限被截断）先重试的次数。
 * 仍没完成时这一章记为“审核没有完成”，接着处理后面的章节（作者决定，2026-10-20，M6-08 试用之后）。
 */
export const REVIEW_RETRIES = 1;

/**
 * 审核一章，模型审核没有完成时重试（取消时不重试）。返回最后一次的结果；complete 为模型审核是否完成，
 * 没完成时 reason 写明原因（取消、调用失败或模型审核没有完成），由调用方记下后接着做。
 */
export async function reviewWithRetry(
  review: () => Promise<Result<ReviewOutcome, AppError>>,
  signal?: AbortSignal,
): Promise<{ readonly result: Result<ReviewOutcome, AppError>; readonly complete: boolean; readonly reason: string | null; readonly retries: number }> {
  for (let retries = 0; ; retries++) {
    const result = await review();
    if (result.ok && result.value.modelReviewed) return { result, complete: true, reason: null, retries };
    const reason = result.ok ? (result.value.reason ?? '模型审核没有完成') : describeError(result.error);
    // 调用失败（网络中断已由调用器重试过）与取消不再重试。
    if (!result.ok || signal?.aborted === true || retries >= REVIEW_RETRIES) return { result, complete: false, reason, retries };
  }
}

/** sent：这一次交给写手的问题（目标问题与同一段上一并修订的），状态已记为“已交写手修订”。 */
export type RevisionOutcome = { readonly chapterId: string; readonly issues: readonly ReviewIssueView[]; readonly paragraphs: readonly SavedParagraph[]; readonly sent: readonly ReviewIssueView[] };

/** 一键交给写手修订的范围：哪几章（null 为全书有待处理问题的章节），修哪些严重程度（null 为全部）。 */
export type RevisionScope = { readonly chapterIds: readonly string[] | null; readonly severities: readonly IssueSeverity[] | null };

/** 一键修订开始前的预计（书一级先给作者看、确认后才开始）。 */
export type RevisionQuote = {
  /** 范围内各章待处理的问题按严重程度的条数（不论筛选），界面据此显示每种各有几条。 */
  readonly bySeverity: Readonly<Record<IssueSeverity, number>>;
  /** 筛选后的条数与涉及的章节（按书中顺序）。 */
  readonly issues: number;
  readonly chapterIds: readonly string[];
  /** 其中针对整章的问题：不交给写手，会跳过。 */
  readonly wholeChapter: number;
  /** 预计调用次数与用量（同一段上有引文的问题一次修订）；费用按默认模型的价格，价格未知时为 null。 */
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly model: string | null;
};

export type RevisionProgress = {
  readonly chapterId: string;
  /** 正在处理第几章（从 0 起）与一共几章。 */
  readonly chapterIndex: number;
  readonly chapters: number;
  /** 已处理（修订了、跳过或失败）的条数与一共几条。 */
  readonly done: number;
  readonly total: number;
  readonly revised: number;
  readonly skipped: number;
  readonly failed: number;
};

export type BatchRevisionEvents = CallOptions & {
  readonly onProgress?: (progress: RevisionProgress) => void;
  /** 开始处理一章前：界面保存这一章正在编辑的正文、把它标为只读；返回 false 时这一章跳过。 */
  readonly beforeChapter?: (chapterId: string) => Promise<boolean>;
  /** 一章处理完；wrote 为写手改过这一章的正文。 */
  readonly afterChapter?: (chapterId: string, wrote: boolean) => Promise<void>;
};

/** 跳过或失败的一条：在哪一章、什么问题、为什么。 */
export type RevisionNote = { readonly chapterId: string; readonly issueId: string; readonly description: string; readonly reason: string };

export type BatchRevisionOutcome = {
  /** 范围里一共几条、写手修订了几条（含同一段一并修订的）、写手改了几段。 */
  readonly total: number;
  readonly revised: number;
  readonly calls: number;
  /** 不在范围里、随同一段一并修订的问题（例如只修严重的问题时，同一段上的轻微问题）。 */
  readonly alongside: number;
  readonly skipped: readonly RevisionNote[];
  readonly failed: readonly RevisionNote[];
  /** 停下时还没轮到的条数。 */
  readonly untouched: number;
  readonly cancelled: boolean;
  /** 连续几条以同样的原因失败而停下时的原因；没有时为 null。 */
  readonly halted: string | null;
  /** 写手改过正文的章节与改之前存的快照（每章一份：恢复它就回到这一次修订之前）。 */
  readonly chapters: readonly { readonly chapterId: string; readonly title: string; readonly snapshotId: string; readonly revised: number }[];
  /** 一句话：修订了几条、跳过几条、失败几条和原因。 */
  readonly summary: string;
};

/**
 * 连续几条以同样的原因失败就停下：例如模型的最大输出太小，每一条都被截断、每一条都要付费；
 * 或者没有可用的模型。不同的原因交替出现时照常接着做。
 */
export const MAX_SAME_FAILURES = 3;
/** 估算一次修订的用量：提示词里段落以外的部分（要求、规避表达、依据）约多少字，每条问题的说明约多少字。 */
const REVISE_PROMPT_CHARS = 900;
const REVISE_ISSUE_CHARS = 120;

/**
 * 针对整章的问题：程序检查给出、没有引文（计划中的人物没有出场、伏笔到期没有回收、破折号太密等），写手改一段解决不了，
 * 一键修订时跳过（单条“交给写手修订”照旧可以点）。
 */
const wholeChapter = (source: IssueSource, quote: string) => source === 'program' && quote === '';
const WHOLE_CHAPTER = '针对整章的问题（例如计划中的人物没有出场、伏笔到期没有回收），改一段解决不了，留给作者处理';

/** 原因按条数归并，多的在前，最多列三种。 */
function reasons(notes: readonly RevisionNote[]): string {
  const count = new Map<string, number>();
  for (const n of notes) count.set(n.reason, (count.get(n.reason) ?? 0) + 1);
  const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 3).map(([reason, n]) => `${reason} ${n} 条`);
  return `${shown.join('；')}${sorted.length > 3 ? '；等' : ''}`;
}

function revisionSummary(o: Omit<BatchRevisionOutcome, 'summary'>): string {
  if (o.total === 0) return '范围里没有待处理的审核问题';
  const parts = [`修订了 ${o.revised} 条（写手改了 ${o.calls} 段${o.alongside > 0 ? `，同一段上另有 ${o.alongside} 条一并修订` : ''}）`];
  if (o.skipped.length > 0) parts.push(`跳过 ${o.skipped.length} 条（${reasons(o.skipped)}）`);
  if (o.failed.length > 0) parts.push(`失败 ${o.failed.length} 条（${reasons(o.failed)}）`);
  const end =
    o.halted !== null
      ? `；连续 ${MAX_SAME_FAILURES} 条因为同一个原因失败，停下了，还有 ${o.untouched} 条没有处理`
      : o.cancelled
        ? `；中途停下了，还有 ${o.untouched} 条没有处理`
        : '';
  return `交给写手修订 ${o.total} 条：${parts.join('，')}${end}${o.chapters.length > 0 ? '。每章改之前的正文存为了快照（版本快照里的“写手写入”）' : ''}`;
}

/** 在一章的写手锁里做 f（写手写章与修订共用，见 writer.ts）；没有给出时直接做。 */
export type ChapterLockFn = <T>(chapterId: string, f: () => Promise<Result<T, AppError>>) => Promise<Result<T, AppError>>;

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });
const HANDLED = ['ignored', 'fixed', 'sent_to_writer'] as const;

type Materials = {
  readonly title: string;
  readonly avoidPhrases: readonly string[];
  readonly chapter: Chapter;
  readonly chapters: readonly Chapter[];
  readonly order: ReadonlyMap<string, number>;
  readonly plan: ChapterPlan | null;
  readonly planItem: PlanItem;
  readonly paragraphs: readonly SavedParagraph[];
  readonly entities: readonly Entity[];
  readonly facts: readonly Fact[];
  readonly foreshadows: readonly Foreshadow[];
};

export function reviewUseCases(
  deps: AppDeps,
  session: () => { readonly port: SqlPort; readonly path: string } | null,
  runner: ReturnType<typeof modelRunner>,
  extra: {
    /** 一键修订时每一章在这把锁里做（服务层给出写手锁）。 */
    readonly lock?: ChapterLockFn;
    /** 默认模型与价格（一键修订的预计费用）。 */
    readonly pricing?: () => Promise<{ readonly model: string; readonly prices: Prices | undefined } | null>;
  } = {},
) {
  const ctx = () => ({ now: deps.clock.now() });
  const lock: ChapterLockFn = extra.lock ?? ((_chapterId, f) => f());

  async function materials(port: SqlPort, chapterId: string): Promise<Result<Materials, AppError>> {
    const [work, chapters, plan, paragraphs, entities, facts, foreshadows] = await Promise.all([
      getProject(port),
      listChapters(port, 'normal'),
      getChapterPlan(port, chapterId),
      listParagraphs(port, chapterId),
      listEntities(port),
      listFacts(port),
      listForeshadows(port),
    ]);
    if (!work.ok) return err(repo(work.error));
    if (!chapters.ok) return err(repo(chapters.error));
    if (!plan.ok) return err(repo(plan.error));
    if (!paragraphs.ok) return err(repo(paragraphs.error));
    if (!entities.ok) return err(repo(entities.error));
    if (!facts.ok) return err(repo(facts.error));
    if (!foreshadows.ok) return err(repo(foreshadows.error));
    const chapter = chapters.value.find((c) => c.id === chapterId);
    if (chapter === undefined) return err(repo({ code: 'not_found' }));
    return ok({
      title: work.value?.title ?? '',
      avoidPhrases: effectiveAvoidPhrases(work.value?.avoidPhrases ?? null),
      chapter,
      chapters: chapters.value,
      order: new Map(chapters.value.map((c, i) => [c.id, i])),
      plan: plan.value,
      // 作者手写、没有计划的章节也能审核：没有要埋要收的伏笔，账本中未回收的伏笔仍不得说破。
      planItem: plan.value ?? { chapterId, castIds: [], foreshadowPlant: [], foreshadowPayoff: [], status: 'todo' },
      paragraphs: paragraphs.value,
      entities: entities.value,
      facts: facts.value,
      foreshadows: foreshadows.value,
    });
  }

  /** 依据写成文字；已经删掉的条目略去。elsewhere 是依据里另一章的段落（跨章连贯检查）。 */
  function evidenceText(
    evidence: readonly IssueEvidence[],
    m: Pick<Materials, 'entities' | 'facts' | 'foreshadows' | 'paragraphs'> & { readonly chapters?: readonly Chapter[] },
    elsewhere: ReadonlyMap<string, SavedParagraph> = new Map(),
  ): string[] {
    return evidence.flatMap((e) => {
      switch (e.type) {
        case 'entity': {
          const entity = m.entities.find((x) => x.id === e.id);
          return entity === undefined ? [] : [`设定 ${entity.name}${entity.description.trim() === '' ? '' : `：${entity.description.trim()}`}`];
        }
        case 'fact': {
          const fact = m.facts.find((x) => x.id === e.id);
          return fact === undefined ? [] : [`事实：${fact.content}`];
        }
        case 'foreshadow': {
          const f = m.foreshadows.find((x) => x.id === e.id);
          return f === undefined ? [] : [`伏笔 ${f.title}：${f.content}${f.reveal.trim() === '' ? '' : `（揭晓的内容：${f.reveal.trim()}）`}`];
        }
        case 'paragraph': {
          const clip = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);
          // 带章节的依据可能就在本章（一章之内的连贯问题），这时按本章段落写。
          const other = e.chapterId === undefined ? undefined : elsewhere.get(e.id);
          if (other !== undefined) {
            const title = m.chapters?.find((c) => c.id === e.chapterId)?.title ?? '前文';
            return [`《${title}》的段落：${clip(other.text)}`];
          }
          const p = m.paragraphs.find((x) => x.id === e.id);
          return p === undefined ? [] : [`本章段落：${clip(p.text)}`];
        }
        case 'plan':
          return ['章节计划'];
      }
    });
  }

  async function pendingView(
    port: SqlPort,
    chapterId: string,
    m: Pick<Materials, 'entities' | 'facts' | 'foreshadows' | 'paragraphs'> & { readonly chapters?: readonly Chapter[] },
  ): Promise<Result<ReviewIssueView[], AppError>> {
    const stale = await reviewStaleIssues(port, chapterId, ctx());
    if (!stale.ok) return err(repo(stale.error));
    const pending = await listIssues(port, chapterId);
    if (!pending.ok) return err(repo(pending.error));
    // 依据里另一章的段落：按章读出文字。
    const elsewhere = new Map<string, SavedParagraph>();
    const others = [...new Set(pending.value.flatMap((i) => i.evidence.flatMap((e) => (e.chapterId !== undefined && e.chapterId !== chapterId ? [e.chapterId] : []))))];
    for (const other of others) {
      const paragraphs = await listParagraphs(port, other);
      if (!paragraphs.ok) return err(repo(paragraphs.error));
      for (const p of paragraphs.value) elsewhere.set(p.id, p);
    }
    return ok(pending.value.map((i) => ({ ...i, evidenceText: evidenceText(i.evidence, m, elsewhere) })));
  }

  /** 程序检查（不调用模型），去掉作者处理过的问题后，换掉这一章仍待处理的程序问题。返回这一次的问题。 */
  async function refreshProgramIssues(port: SqlPort, m: Materials): Promise<Result<{ program: ProgramIssue[]; handled: ReviewIssue[] }, AppError>> {
    const chapterId = m.chapter.id;
    const handled = await listIssues(port, chapterId, HANDLED);
    if (!handled.ok) return err(repo(handled.error));
    const program = dropHandled(
      runProgramChecks({
        chapterId,
        paragraphs: m.paragraphs.filter((p) => p.text.trim() !== ''),
        avoidPhrases: m.avoidPhrases,
        mustNotReveal: foreshadowsForChapter(m.planItem, m.foreshadows, m.order).mustNotReveal,
        foreshadows: m.foreshadows,
        order: m.order,
        cast: m.entities.filter((e) => m.planItem.castIds.includes(e.id)),
      }),
      handled.value,
    );
    const saved = await replacePendingIssues(port, chapterId, 'program', program.map(toInput(chapterId, 'program', null)), ctx());
    return saved.ok ? ok({ program, handled: handled.value }) : err(repo(saved.error));
  }

  /**
   * 交给写手修订一条问题（单条与一键修订共用）。snapshot 在写入正文之前调用：单条每次存一份快照，
   * 一键修订每章只在第一次写入前存一份（之后同一章的修订不再存，恢复那一份就回到这一次修订之前）。
   */
  async function reviseOne(issueId: string, options: CallOptions, snapshot: (chapterId: string) => Promise<Result<unknown, AppError>>): Promise<Result<RevisionOutcome, AppError>> {
    const s = session();
    if (s === null) return err({ code: 'no_work' });
    const { port } = s;
    const found = await getIssue(port, issueId);
    if (!found.ok) return err(repo(found.error));
    if (found.value === null) return err(repo({ code: 'not_found' }));
    const chapterId = found.value.chapterId;
    const loaded = await materials(port, chapterId);
    if (!loaded.ok) return loaded;
    const m = loaded.value;
    const draft = await deps.drafts.read(s.path, chapterId);
    if (draft.ok && draft.value !== null) return err(settings(`“${m.chapter.title}”有未保存的修改：请先保存，写手不会覆盖你的修改`));
    const pending = await pendingView(port, chapterId, m);
    if (!pending.ok) return pending;
    const target = pending.value.find((i) => i.id === issueId);
    if (target === undefined) return err(settings('这条问题已经处理过，或它所在的段落已经改过'));
    const at = m.paragraphs.findIndex((p) => p.id === target.anchor.paragraphId);
    const paragraph = m.paragraphs[at];
    if (paragraph === undefined) return err(settings('找不到这条问题所在的段落'));
    const group = pending.value.filter((i) => i.id === target.id || (i.anchor.paragraphId === paragraph.id && i.anchor.quote !== ''));

    const fs = foreshadowsForChapter(m.planItem, m.foreshadows, m.order);
    const prompt = renderWriterRevise({
      title: m.title,
      chapterTitle: m.chapter.title,
      avoidPhrases: m.avoidPhrases,
      evidence: [...new Set(group.flatMap((i) => i.evidenceText).filter((t) => t !== '章节计划' && !t.startsWith('本章段落：')))],
      mustNotReveal: fs.mustNotReveal.map((f) => f.reveal.trim()),
      before: m.paragraphs[at - 1]?.text ?? '',
      paragraph: paragraph.text,
      after: m.paragraphs[at + 1]?.text ?? '',
      issues: group.map((i) => ({ quote: i.anchor.quote, description: i.description, suggestion: i.suggestion })),
    });
    if (!prompt.ok) return err(settings(prompt.error));
    const result = await runner.text({ prompt: prompt.value, maxOutputTokens: paragraph.text.length * 2 + THINKING_ALLOWANCE, effort: 'medium' }, options);
    if (!result.ok) return result;
    if (result.value.outcome === 'cancelled') return err(settings('已取消'));
    if (result.value.outcome === 'refused') return err(settings(`模型拒绝了这次修订${result.value.refusal?.explanation ? `：${result.value.refusal.explanation}` : ''}`));
    if (result.value.outcome === 'truncated') return err(settings('修订的输出被截断，没有写入；可以在模型服务中调高这个模型的最大输出，或换一个模型'));
    const revised = splitParagraphs(normalizePunctuation(result.value.text)).join('\n');
    if (revised === '') return err(settings('模型没有写出修订后的文字'));
    if (revised === paragraph.text) return err(settings('写手没有改动这一段；可以自己修改，或忽略这条问题'));

    const whole = { from: { paragraphId: paragraph.id, offset: 0 }, to: { paragraphId: paragraph.id, offset: paragraph.text.length } };
    const plan = planRangeReplace(m.paragraphs, whole, { text: revised, ai: [{ start: 0, end: revised.length }], unedited: true }, () => deps.ids.next());
    if (!plan.ok) return err(settings(plan.error));
    const saved = await snapshot(chapterId);
    if (!saved.ok) return saved;
    const applied = await applyRangeReplace(port, chapterId, plan.value, ctx());
    if (!applied.ok) return applied.error.code === 'conflict' ? err(settings('这一段在修订过程中被修改，写手没有写入；请重新审核')) : err(repo(applied.error));
    for (const issue of group) {
      const sent = await setIssueStatus(port, issue, 'sent_to_writer', ctx());
      if (!sent.ok && sent.error.code !== 'conflict') return err(repo(sent.error));
    }
    const after = await listParagraphs(port, chapterId);
    if (!after.ok) return err(repo(after.error));
    const rechecked = await refreshProgramIssues(port, { ...m, paragraphs: after.value });
    if (!rechecked.ok) return rechecked;
    const issues = await pendingView(port, chapterId, { ...m, paragraphs: after.value });
    return issues.ok ? ok({ chapterId, issues: issues.value, paragraphs: after.value, sent: group }) : issues;
  }

  /** 单条修订：每次写入前存一份快照。 */
  const snapshotEach = async (chapterId: string): Promise<Result<unknown, AppError>> => {
    const s = session();
    if (s === null) return err({ code: 'no_work' });
    const created = await createSnapshot(s.port, { id: deps.ids.next(), chapterId, reason: 'writer' }, ctx());
    return created.ok ? created : err(repo(created.error));
  };

  /**
   * 一键修订轮到一条问题时找到要交给写手的那一条：还待处理就是它；前一条修订改了段落而过期的，在现在的正文里重新定位
   * （引文还在就把它锚到现在的段落；程序检查重新标出了同一处就用新的那一条）。返回问题的标识，或者跳过的原因。
   */
  async function locateForRevision(port: SqlPort, chapterId: string, issue: ReviewIssue): Promise<Result<string, string>> {
    const stale = await reviewStaleIssues(port, chapterId, ctx());
    if (!stale.ok) return err('读不出这一章的审核问题');
    const pending = await listIssues(port, chapterId);
    if (!pending.ok) return err('读不出这一章的审核问题');
    if (pending.value.some((p) => p.id === issue.id)) return ok(issue.id);
    const current = await getIssue(port, issue.id);
    if (!current.ok) return err('读不出这条问题');
    if (current.value === null) return err('这条问题已经不在了');
    if (current.value.status !== 'stale') return err(current.value.status === 'sent_to_writer' ? '已经交给写手修订过' : '作者已经处理过');
    const paragraphs = await listParagraphs(port, chapterId);
    if (!paragraphs.ok) return err('读不出这一章的正文');
    // 依据是带版本的段落（跨章连贯问题）：那一段改过了，问题的依据就过期了，不能照旧交给写手。
    const versions = new Map(paragraphs.value.map((p) => [p.id, p.version]));
    const others = new Set(issue.evidence.flatMap((e) => (e.type === 'paragraph' && e.version !== undefined && e.chapterId !== undefined && !versions.has(e.id) ? [e.chapterId] : [])));
    for (const other of others) {
      const elsewhere = await listParagraphs(port, other);
      if (elsewhere.ok) for (const p of elsewhere.value) versions.set(p.id, p.version);
    }
    if (issue.evidence.some((e) => e.type === 'paragraph' && e.version !== undefined && versions.get(e.id) !== e.version)) return err('依据的段落改过了，这条问题的依据已经过期');
    const where = relocateIssue({ kind: issue.kind, anchor: issue.anchor, description: issue.description, regenerated: issue.source === 'program' }, paragraphs.value, pending.value);
    if (where.kind === 'pending') return ok(where.id);
    if (where.kind === 'gone') return err(where.reason);
    const moved = await reanchorIssue(port, current.value, where.anchor, ctx());
    return moved.ok ? ok(issue.id) : err('重新定位时没有写成，请重新审核这一章');
  }

  const toInput = (chapterId: string, source: 'program' | 'model', llmCallId: string | null) => (i: ProgramIssue) => ({
    id: deps.ids.next(),
    chapterId,
    kind: i.kind,
    severity: i.severity,
    anchor: i.anchor,
    evidence: i.evidence,
    description: i.description,
    suggestion: i.suggestion,
    source,
    llmCallId,
  });

  return {
    /** 一条问题所在的章节（AI 助手交给写手修订前先存快照用）；找不到时为 null。 */
    async issueChapterId(issueId: string): Promise<Result<string | null, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const found = await getIssue(s.port, issueId);
      return found.ok ? ok(found.value?.chapterId ?? null) : err(repo(found.error));
    },

    /** 这一章待处理的问题；先把段落改过的问题标为过期。 */
    async reviewIssues(chapterId: string): Promise<Result<ReviewIssueView[], AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const m = await materials(s.port, chapterId);
      return m.ok ? pendingView(s.port, chapterId, m.value) : m;
    },

    /**
     * 审核一章（写手所写与作者手写均可）。重新审核时，仍待处理的旧问题换成这一次的；作者处理过的问题不再提出。
     * 模型审核没有完成（没有模型、调用失败、取消）时，程序检查的问题仍然保存，结果中写明原因。
     */
    async reviewChapter(chapterId: string, options: CallOptions = {}): Promise<Result<ReviewOutcome, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const { port } = s;
      const loaded = await materials(port, chapterId);
      if (!loaded.ok) return loaded;
      const m = loaded.value;
      const paragraphs = m.paragraphs.filter((p) => p.text.trim() !== '');
      if (paragraphs.length === 0) return err(settings(`“${m.chapter.title}”还没有正文，没有可以审核的内容`));
      const draft = await deps.drafts.read(s.path, chapterId);
      if (draft.ok && draft.value !== null) return err(settings(`“${m.chapter.title}”有未保存的修改：请先保存，审核读的是已保存的正文`));

      const cast = m.entities.filter((e) => m.planItem.castIds.includes(e.id));
      const fs = foreshadowsForChapter(m.planItem, m.foreshadows, m.order);
      const checked = await refreshProgramIssues(port, m);
      if (!checked.ok) return checked;
      const { program, handled } = checked.value;
      const finish = async (modelReviewed: boolean, reason: string | null, dropped: number): Promise<Result<ReviewOutcome, AppError>> => {
        const issues = await pendingView(port, chapterId, m);
        return issues.ok ? ok({ issues: issues.value, modelReviewed, reason, dropped }) : issues;
      };

      // 设定：出场人物在前，其余按在正文中出现的次数；事实：已确认、适用于本章、与这些设定有关。
      const text = paragraphs.map((p) => p.text).join('\n');
      const mentions = new Map<string, number>();
      for (const hit of createEntityMatcher(m.entities.map((e) => ({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases }))).find(text)) {
        mentions.set(hit.entityId, (mentions.get(hit.entityId) ?? 0) + 1);
      }
      const castIds = new Set(cast.map((c) => c.id));
      const others = m.entities.filter((e) => !castIds.has(e.id) && mentions.has(e.id)).sort((a, b) => (mentions.get(b.id) ?? 0) - (mentions.get(a.id) ?? 0));
      const entities = [...cast, ...others].slice(0, MAX_REVIEW_ENTITIES);
      const entityIds = new Set(entities.map((e) => e.id));
      const index = m.order.get(chapterId) ?? 0;
      const facts = m.facts
        .filter((f) => f.status === 'confirmed' && factApplies(f, index, m.order) && (f.subjectIds.some((id) => entityIds.has(id)) || (f.holderId !== null && entityIds.has(f.holderId))))
        .slice(0, MAX_REVIEW_FACTS);
      const nameOf = new Map(m.entities.map((e) => [e.id, e.name]));
      const factText = (f: Fact) => {
        const holder = f.holderId === null ? undefined : nameOf.get(f.holderId);
        if (holder === undefined || f.kind === 'world') return f.content;
        return `（${holder}${f.kind === 'belief' ? '的认知' : '的说法'}）${f.content}`;
      };

      const [memories, withText] = await Promise.all([listChapterMemories(port), listChaptersWithText(port)]);
      if (!memories.ok) return err(repo(memories.error));
      if (!withText.ok) return err(repo(withText.error));
      const hasText = new Set(withText.value);
      const memoryOf = new Map(memories.value.filter((x) => hasText.has(x.chapterId)).map((x) => [x.chapterId, x]));
      const stateOf = new Map<string, string>();
      const earlier: { title: string; summary: string }[] = [];
      let used = 0;
      for (const c of m.chapters.slice(0, index)) for (const [id, state] of Object.entries(memoryOf.get(c.id)?.castState ?? {})) stateOf.set(id, state);
      for (const c of m.chapters.slice(0, index).reverse()) {
        const summary = (memoryOf.get(c.id)?.summary ?? c.summary).trim();
        if (summary === '') continue;
        if (used + summary.length > REVIEW_MEMORY_CHARS) break;
        used += summary.length;
        earlier.unshift({ title: c.title, summary });
      }

      const roles: { readonly f: Foreshadow; readonly role: string }[] = [
        ...fs.toPlant.map((f) => ({ f, role: '本章要埋' })),
        ...fs.toPayoff.map((f) => ({ f, role: '本章要回收' })),
        ...fs.mustNotReveal.filter((f) => !fs.toPlant.some((x) => x.id === f.id)).map((f) => ({ f, role: '不得说破' })),
      ];
      const evidence = new Map<string, IssueEvidence>();
      const labelled = <T extends { readonly id: string }>(prefix: string, type: IssueEvidence['type'], items: readonly T[]) =>
        items.map((item, i) => {
          const label = `${prefix}${i + 1}`;
          evidence.set(label, { type, id: item.id });
          return { label, item };
        });
      const entityRefs = labelled('E', 'entity', entities);
      const factRefs = labelled('F', 'fact', facts);
      const foreshadowRefs = labelled('S', 'foreshadow', roles.map((r) => ({ id: r.f.id, ...r })));
      if (m.plan !== null) evidence.set('plan', { type: 'plan', id: chapterId });

      const prompt = renderChapterReview({
        title: m.title,
        chapterTitle: m.chapter.title,
        entities: entityRefs.map(({ label, item }) => ({
          label,
          name: item.name,
          kind: ENTITY_KIND[item.kind],
          locked: item.locked,
          description: [item.description.trim(), ...item.attributes.map((a) => `${a.label}：${a.value}`)].filter((x) => x !== '').join('；'),
          state: stateOf.get(item.id) ?? '',
        })),
        facts: factRefs.map(({ label, item }) => ({ label, content: factText(item) })),
        memories: earlier,
        plan: m.plan === null ? null : { goal: m.plan.goal, treatment: m.plan.treatment, cast: cast.map((c) => c.name), beats: m.plan.beats },
        foreshadows: foreshadowRefs.map(({ label, item }) => ({
          label,
          title: item.f.title,
          role: item.role,
          content: item.f.content,
          // 要埋的伏笔同样不得说破，揭晓的内容一并给出。
          reveal: item.f.reveal,
        })),
        paragraphs: paragraphs.map((p, i) => ({ label: paragraphLabel(i), text: p.text })),
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: REVIEW_OUTPUT_TOKENS, effort: 'medium' }, ChapterReviewOutput, options);
      if (!result.ok) return finish(false, result.error.code === 'settings' ? result.error.detail : '调用模型失败', 0);

      const clip = (text: string) => (text.trim().length > 16 ? `${text.trim().slice(0, 16)}……` : text.trim());
      const names = new Map([
        ...entityRefs.map(({ label, item }) => [label, item.name] as const),
        ...factRefs.map(({ label, item }) => [label, `事实“${clip(item.content)}”`] as const),
        ...foreshadowRefs.map(({ label, item }) => [label, `伏笔“${item.f.title}”`] as const),
      ]);
      const resolved = resolveModelIssues(result.value.value.issues, { paragraphs, evidence, names });
      // 程序检查已经指出的同一处问题不再重复。
      const model = dropHandled(dropHandled(resolved.issues, handled), program);
      const hash = result.value.attempts.at(-1)?.requestHash;
      const call = hash === undefined ? null : await findCallByRequestHash(port, hash);
      const callId = call?.ok === true ? (call.value?.id ?? null) : null;
      const savedModel = await replacePendingIssues(port, chapterId, 'model', model.map(toInput(chapterId, 'model', callId)), ctx());
      if (!savedModel.ok) return err(repo(savedModel.error));
      if (m.plan?.status === 'written') {
        const reviewed = await setPlanStatus(port, m.plan, 'reviewed', ctx());
        if (!reviewed.ok && reviewed.error.code !== 'conflict') return err(repo(reviewed.error));
      }
      return finish(true, null, resolved.dropped.filter((d) => d.reason !== 'duplicate').length);
    },

    /** 作者处理一条问题：忽略，或标为已经自己改好。 */
    async resolveIssue(issueId: string, status: 'ignored' | 'fixed'): Promise<Result<ReviewIssueView[], AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const issue = await getIssue(s.port, issueId);
      if (!issue.ok) return err(repo(issue.error));
      if (issue.value === null) return err(repo({ code: 'not_found' }));
      // 已经不在待处理里的（处理过，或正文改过后重新标出、换了标识）不再改，说清楚，免得以为处理了。
      if (issue.value.status !== 'pending') return err(settings('这条问题已经不在待处理里：处理过了，或正文改过后重新标出、换了标识'));
      const done = await setIssueStatus(s.port, issue.value, status, ctx());
      if (!done.ok) return err(repo(done.error));
      const m = await materials(s.port, issue.value.chapterId);
      return m.ok ? pendingView(s.port, issue.value.chapterId, m.value) : m;
    },

    /**
     * 交给写手修订：写手只改问题所在的那一段，写入前保存快照。这一段上其他指到具体文字的待处理问题一并交给它；
     * 针对整章、只是锚在这一段上的问题（例如计划中的人物没有出场）不算在内。
     * 修订后的段落记为 AI 生成，交出去的问题记为“已交写手修订”；随后重做程序检查，没改掉的规避词等会重新提出。
     */
    reviseIssue(issueId: string, options: CallOptions = {}): Promise<Result<RevisionOutcome, AppError>> {
      return reviseOne(issueId, options, snapshotEach);
    },

    /** 一键修订开始前的预计：范围里的条数（各严重程度）、涉及的章节、调用次数、用量与费用。只读，不调用模型。 */
    async quoteRevision(scope: RevisionScope): Promise<Result<RevisionQuote, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const [chapters, sizes] = await Promise.all([listChapters(s.port, 'normal'), listPendingIssueSizes(s.port)]);
      if (!chapters.ok) return err(repo(chapters.error));
      if (!sizes.ok) return err(repo(sizes.error));
      const order = new Map(chapters.value.map((c, i) => [c.id, i]));
      const wanted = scope.chapterIds === null ? null : new Set(scope.chapterIds);
      const inChapters = sizes.value.filter((i) => order.has(i.chapterId) && (wanted === null || wanted.has(i.chapterId)));
      const bySeverity: Record<IssueSeverity, number> = { high: 0, medium: 0, low: 0 };
      for (const i of inChapters) bySeverity[i.severity] += 1;
      const chosen = inChapters.filter((i) => scope.severities === null || scope.severities.includes(i.severity));
      // 同一段上有引文的问题一次修订；没有引文的（针对整段）各修一次；针对整章的跳过。
      const calls: { length: number; issues: number }[] = [];
      const byParagraph = new Map<string, { length: number; issues: number }>();
      for (const i of chosen) {
        if (wholeChapter(i.source, i.quote)) continue;
        const same = i.quote === '' ? undefined : byParagraph.get(i.paragraphId);
        if (same !== undefined) {
          same.issues += 1;
          continue;
        }
        const fresh = { length: i.length, issues: 1 };
        if (i.quote !== '') byParagraph.set(i.paragraphId, fresh);
        calls.push(fresh);
      }
      const inputTokens = Math.round(calls.reduce((n, c) => n + (REVISE_PROMPT_CHARS + 3 * c.length + REVISE_ISSUE_CHARS * c.issues) * TOKENS_PER_CHAR, 0));
      const outputTokens = Math.round(calls.reduce((n, c) => n + c.length * TOKENS_PER_CHAR + THINKING_TOKENS_PER_CALL, 0));
      const price = (await extra.pricing?.()) ?? null;
      return ok({
        bySeverity,
        issues: chosen.length,
        chapterIds: [...new Set(chosen.map((i) => i.chapterId))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
        wholeChapter: chosen.filter((i) => wholeChapter(i.source, i.quote)).length,
        calls: calls.length,
        inputTokens,
        outputTokens,
        costUsd: calls.length === 0 ? 0 : costOf({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, price?.prices),
        model: price?.model ?? null,
      });
    },

    /**
     * 一键交给写手修订（B64 补充）：按书中顺序逐章、逐条（严重的在前）交给写手，每条走与单条相同的修订。
     * 一章在写手锁里做完（写手正在写的章节跳过），第一次写入前存一份快照，段落来源照常记为 AI 生成。
     * 同一段上有引文的问题一次修订；前一条修订改了段落后，后面的问题在现在的正文里重新定位，定位不到或依据过期的跳过并写明原因。
     * 一条失败不挡住其余（连续 MAX_SAME_FAILURES 条同样的原因失败时停下）；取消后正在修订的那一条不写入，后面的不再做。
     */
    async reviseIssues(scope: RevisionScope, events: BatchRevisionEvents = {}): Promise<Result<BatchRevisionOutcome, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const { port } = s;
      const { signal, onEvent, beforeCall } = events;
      const call: CallOptions = { ...(signal !== undefined && { signal }), ...(onEvent !== undefined && { onEvent }), ...(beforeCall !== undefined && { beforeCall }) };
      const [chapters, counts] = await Promise.all([listChapters(port, 'normal'), countPendingIssues(port)]);
      if (!chapters.ok) return err(repo(chapters.error));
      if (!counts.ok) return err(repo(counts.error));
      const wanted = scope.chapterIds === null ? null : new Set(scope.chapterIds);
      // 开始时列出范围里待处理的问题（先把段落改过的标为过期），之后按这份清单逐条处理。
      const queue: { readonly chapter: Chapter; readonly issues: readonly ReviewIssue[] }[] = [];
      for (const chapter of chapters.value) {
        if ((wanted !== null && !wanted.has(chapter.id)) || (counts.value.get(chapter.id) ?? 0) === 0) continue;
        const stale = await reviewStaleIssues(port, chapter.id, ctx());
        if (!stale.ok) return err(repo(stale.error));
        const pending = await listIssues(port, chapter.id);
        if (!pending.ok) return err(repo(pending.error));
        const issues = pending.value.filter((i) => scope.severities === null || scope.severities.includes(i.severity));
        if (issues.length > 0) queue.push({ chapter, issues });
      }
      const total = queue.reduce((n, q) => n + q.issues.length, 0);
      const skipped: RevisionNote[] = [];
      const failed: RevisionNote[] = [];
      const touched: { chapterId: string; title: string; snapshotId: string; revised: number }[] = [];
      let revised = 0;
      let alongside = 0;
      let calls = 0;
      let untouched = 0;
      let halted: string | null = null;
      let streak = { reason: '', count: 0 };
      const stopped = () => signal?.aborted === true || halted !== null;
      const note = (chapter: Chapter, issue: ReviewIssue, reason: string): RevisionNote => ({ chapterId: chapter.id, issueId: issue.id, description: issue.description, reason });
      const progress = (chapterIndex: number, chapterId: string) =>
        events.onProgress?.({ chapterId, chapterIndex, chapters: queue.length, done: revised + skipped.length + failed.length, total, revised, skipped: skipped.length, failed: failed.length });

      for (const [index, { chapter, issues }] of queue.entries()) {
        if (stopped()) {
          untouched += issues.length;
          continue;
        }
        progress(index, chapter.id);
        if (events.beforeChapter !== undefined && !(await events.beforeChapter(chapter.id))) {
          skipped.push(...issues.map((i) => note(chapter, i, '这一章正在编辑的正文没有保存成功')));
          continue;
        }
        let snapshotId: string | null = null;
        let count = 0;
        const done = await lock(chapter.id, async (): Promise<Result<void, AppError>> => {
          const draft = await deps.drafts.read(s.path, chapter.id);
          if (draft.ok && draft.value !== null) {
            skipped.push(...issues.map((i) => note(chapter, i, '这一章有未保存的修改（写手不覆盖你的修改）')));
            return ok(undefined);
          }
          const once = async (chapterId: string): Promise<Result<unknown, AppError>> => {
            if (snapshotId !== null) return ok(undefined);
            const created = await createSnapshot(port, { id: deps.ids.next(), chapterId, reason: 'writer' }, ctx());
            if (!created.ok) return err(repo(created.error));
            snapshotId = created.value.id;
            return ok(undefined);
          };
          const settled = new Set<string>();
          const failedHere = new Set<string>();
          for (const [at, issue] of issues.entries()) {
            if (stopped()) {
              untouched += issues.slice(at).filter((i) => !settled.has(i.id)).length;
              break;
            }
            if (settled.has(issue.id)) continue;
            if (wholeChapter(issue.source, issue.anchor.quote)) {
              skipped.push(note(chapter, issue, WHOLE_CHAPTER));
              settled.add(issue.id);
              progress(index, chapter.id);
              continue;
            }
            const target = await locateForRevision(port, chapter.id, issue);
            if (!target.ok) {
              skipped.push(note(chapter, issue, target.error));
              settled.add(issue.id);
              progress(index, chapter.id);
              continue;
            }
            const result = await reviseOne(target.value, call, once);
            if (!result.ok) {
              // 被停下：这一条没有写入，与后面的一起算作没有处理。
              if (signal?.aborted === true) {
                untouched += issues.slice(at).filter((i) => !settled.has(i.id)).length;
                break;
              }
              const reason = describeError(result.error);
              failed.push(note(chapter, issue, reason));
              settled.add(issue.id);
              failedHere.add(issue.id);
              streak = streak.reason === reason ? { reason, count: streak.count + 1 } : { reason, count: 1 };
              if (streak.count >= MAX_SAME_FAILURES) halted = reason;
              progress(index, chapter.id);
              continue;
            }
            streak = { reason: '', count: 0 };
            calls += 1;
            // 交出去的问题对回清单：目标（可能是程序检查重新标出的新标识）与同一段上一并修订的；对不上的是范围以外的问题。
            for (const sent of result.value.sent) {
              const open = (i: ReviewIssue) => !settled.has(i.id) || failedHere.has(i.id);
              const original = sent.id === target.value && open(issue) ? issue : issues.find((i) => open(i) && (i.id === sent.id || dropHandled([i], [sent]).length === 0));
              if (original === undefined) {
                alongside += 1;
                continue;
              }
              // 先前失败的一条随同一段的修订改掉了：改记为修订了。
              if (failedHere.delete(original.id)) failed.splice(failed.findIndex((f) => f.issueId === original.id), 1);
              settled.add(original.id);
              revised += 1;
              count += 1;
            }
            progress(index, chapter.id);
          }
          return ok(undefined);
        });
        if (!done.ok) skipped.push(...issues.map((i) => note(chapter, i, describeError(done.error))));
        if (snapshotId !== null) touched.push({ chapterId: chapter.id, title: chapter.title, snapshotId, revised: count });
        await events.afterChapter?.(chapter.id, snapshotId !== null);
      }
      const outcome = { total, revised, calls, alongside, skipped, failed, untouched, cancelled: signal?.aborted === true, halted, chapters: touched };
      return ok({ ...outcome, summary: revisionSummary(outcome) });
    },
  };
}

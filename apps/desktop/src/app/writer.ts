// 写手成章的用例（需求 B59、B60，施工文档第五章“写手与审核”）。
// 按章节计划的情节点分段写：每段一次调用；写完一段就接在章末，并在同一事务中更新计划里的进度。
// 写第一段之前保存“写手写入”快照，作者可以一键回退；写入的段落记为 AI 生成（硬性规则 21）。
// 每段的步骤键是“章节 + 这次写作的标识 + 段号”：中断后续写时，已写入的段跳过，已完成但没写入的调用复用记录，不重复计费。
// 输出被截断的段不写入：停下说明，续写时这一段换一个步骤键（加“重写次数”），不复用截断的结果。
import type { CallOptions } from '@fudiao/llm';
import { renderSceneCoverage, renderWriterChapter, SceneCoverageOutput } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  appendWrittenSegment,
  createSnapshot,
  findCompletedCall,
  getChapterPlan,
  listChapters,
  listParagraphs,
  rollbackWriterRun,
  setPlanStatus,
  startWriterRun,
  type Chapter,
  type ChapterPlan,
  type RepoError,
  type SavedParagraph,
  type SqlPort,
} from '@fudiao/store';
import { normalizePunctuation, planSegments, planSegmentsAfter, splitParagraphs } from '@fudiao/writing';
import { gatherChapterMaterials } from './chapter-materials';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, unusableCall, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';
import { rhythmText } from './style-ledger';
import { skillsForStage } from './writing-skills';

/** 带给写手的上文长度（字）：上一章的结尾与本章已写的结尾。 */
export const TAIL_CHARS = 1500;

/** 写手一段要写的内容最多约多少 Token：目标字数的两倍。 */
export const segmentContentTokens = (words: number) => words * 2;
/** 每段的输出上限：内容之外另留出思考的余量。 */
const segmentOutputTokens = (words: number) => segmentContentTokens(words) + THINKING_ALLOWANCE;
/** 判断推演正文写出了哪些情节点（B86）的输出上限：几个序号，另留思考的余量。 */
const COVERAGE_OUTPUT_TOKENS = 500 + THINKING_ALLOWANCE;

export type WriterOutcome = {
  /** written：本章写完；cancelled：作者取消；stopped：中途停下（原因见 reason），已写入的段保留，可以续写。 */
  readonly status: 'written' | 'cancelled' | 'stopped';
  readonly reason: string | null;
  readonly plan: ChapterPlan;
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
};

export type WriterEvents = CallOptions & {
  /** 一段写入正文后调用。 */
  readonly onSegment?: (done: number, total: number) => void;
};

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });
const tail = (text: string) => (text.length <= TAIL_CHARS ? text : text.slice(-TAIL_CHARS));
const body = (paragraphs: readonly SavedParagraph[]) => paragraphs.map((p) => p.text).join('\n');

/** 截断过或回复是空的段落另起步骤键：第一次用原键，之后依次加“:r1”“:r2”……，直到一个没有这种记录的键。 */
export async function retryableStepKey(port: SqlPort, base: string): Promise<Result<string, RepoError>> {
  for (let attempt = 0; ; attempt++) {
    const key = attempt === 0 ? base : `${base}:r${attempt}`;
    const found = await findCompletedCall(port, key);
    if (!found.ok) return found;
    if (found.value === null || !unusableCall(found.value)) return ok(key);
  }
}

/** 一段的回复是空的时自动重试几次（有的模型偶尔把输出都用在思考上、一个字也不写，再问一次通常就好）。 */
const EMPTY_RETRIES = 1;

export function writerUseCases(deps: AppDeps, session: () => { readonly port: SqlPort; readonly path: string } | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });
  // 正在写的章节。同一章同时只能有一个写手：作者在成书进度里点了“依次写完”，AI 助手又被要求写同一章时，
  // 两个写手会互相当成“作者改了本章”而停下。写作期间也不能回退这一章。
  const writing = new Set<string>();

  /** 本章不随分段变化的材料：作品、技能、人物（各自知道的事与在不在场）、事实、伏笔、前文梗概与上一章的结尾。 */
  async function materials(port: SqlPort, chapter: Chapter, chapters: readonly Chapter[], plan: ChapterPlan) {
    /**
     * 写手此刻正在写的章节（例如 AI 助手在后台修订它）：它的正文还不是完整的一章，不当作上一章的结尾。
     * 写手停下后作者自己写完的章节计划仍停在“写作中”，所以看的是此刻在不在写，不看计划的状态。
     */
    const unfinished = (id: string) => writing.has(id);
    const [skills, gathered] = await Promise.all([skillsForStage(port, 'writing', deps), gatherChapterMaterials(port, { chapter, chapters, plan, unfinished })]);
    if (!skills.ok) return err(repo(skills.error));
    if (!gathered.ok) return gathered;
    const m = gathered.value;

    const index = chapters.findIndex((c) => c.id === chapter.id);
    const previous = chapters[index - 1];
    let previousEnding = '';
    if (previous !== undefined && !unfinished(previous.id)) {
      const before = await listParagraphs(port, previous.id);
      if (!before.ok) return err(repo(before.error));
      previousEnding = tail(body(before.value));
    }

    return ok({
      title: m.title,
      genre: m.genre,
      chapterTitle: m.chapterTitle,
      ...(m.volume !== null && { volume: m.volume }),
      goal: m.goal,
      treatment: m.treatment,
      skills: skills.value.map((s) => ({ name: s.name, description: s.description, text: s.text })),
      avoidPhrases: m.avoidPhrases,
      // 各人物知道的事与不在场的章（认知层）：人物只依据自己知道的说话与行动；外貌等属性照着写（B87）。
      cast: m.cast.map((c) => ({ name: c.name, description: c.description, attributes: c.attributes, state: c.state, knows: c.knows, absent: c.absent.map((a) => `${a.title}（${a.summary}）`) })),
      relations: m.relations,
      facts: m.worldFacts,
      memories: m.memories,
      toPlant: m.toPlant,
      toPayoff: m.toPayoff,
      mustNotReveal: m.mustNotReveal,
      openThreads: m.openThreads,
      previousEnding,
      // 节奏目标与最近几章的风格账本（B87）。
      ...(rhythmText(m.rhythm) !== undefined && { rhythm: rhythmText(m.rhythm) }),
      style: { lines: m.style.lines, overused: m.style.overused, endings: m.style.endings },
    });
  }

  const cases = {
    /**
     * 写一章（或接着写）：计划必须已有；已经写完的章节要先回退才能重写。
     * 这一章有未保存的草稿时不写（先保存或丢弃），写作过程中这一章被改动则停下，不覆盖作者的修改。
     */
    async writeChapter(chapterId: string, events: WriterEvents = {}): Promise<Result<WriterOutcome, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const { port } = s;
      const chapters = await listChapters(port, 'normal');
      if (!chapters.ok) return err(repo(chapters.error));
      const chapter = chapters.value.find((c) => c.id === chapterId);
      if (chapter === undefined) return err(repo({ code: 'not_found' }));
      const loaded = await getChapterPlan(port, chapterId);
      if (!loaded.ok) return err(repo(loaded.error));
      if (loaded.value === null) return err(settings(`“${chapter.title}”还没有章节计划：先在“计划”中写好本章的目标与情节点`));
      let plan = loaded.value;
      if (plan.status === 'written' || plan.status === 'reviewed') return err(settings(`“${chapter.title}”已经写过；要重写请先回退到写手写入前`));
      const draft = await deps.drafts.read(s.path, chapterId);
      if (draft.ok && draft.value !== null) return err(settings(`“${chapter.title}”有未保存的修改：请先打开这一章保存或丢弃，写手不会覆盖你的修改`));

      let paragraphs = await listParagraphs(port, chapterId);
      if (!paragraphs.ok) return err(repo(paragraphs.error));

      if (plan.progress === null) {
        const snapshot = await createSnapshot(port, { id: deps.ids.next(), chapterId, reason: 'writer' }, ctx());
        if (!snapshot.ok) return err(repo(snapshot.error));
        const segments = planSegments(plan.beats, plan.targetWords);
        const started = await startWriterRun(
          port,
          plan,
          { runId: deps.ids.next(), segments: segments.segments.map((b) => [...b]), words: [...segments.words], done: 0, snapshotId: snapshot.value.id },
          ctx(),
        );
        if (!started.ok) return err(repo(started.error));
        plan = started.value;
      }
      const progress = plan.progress;
      if (progress === null) return err(settings('写手的进度记录缺失'));
      const fixed = await materials(port, chapter, chapters.value, plan);
      if (!fixed.ok) return fixed;

      const total = progress.segments.length;
      const outcome = (status: WriterOutcome['status'], reason: string | null): Result<WriterOutcome, AppError> =>
        ok({ status, reason, plan, segmentsDone: plan.progress?.done ?? 0, segmentsTotal: total });

      const aborted = () => events.signal?.aborted === true;
      for (let i = progress.done; i < total; i++) {
        if (aborted()) return outcome('cancelled', null);
        const prompt = renderWriterChapter({
          ...fixed.value,
          beatsBefore: progress.segments.slice(0, i).flat(),
          beatsNow: progress.segments[i] ?? [],
          beatsAfter: progress.segments.slice(i + 1).flat(),
          written: tail(body(paragraphs.value)),
          words: progress.words[i] ?? 1500,
          isLast: i === total - 1,
        });
        if (!prompt.ok) return err(settings(prompt.error));
        let texts: string[] = [];
        let spent: number | null = null;
        for (let attempt = 0; attempt <= EMPTY_RETRIES && texts.length === 0; attempt++) {
          if (attempt > 0 && aborted()) return outcome('cancelled', null);
          const stepKey = await retryableStepKey(port, `writer:${chapterId}:${progress.runId}:${i}`);
          if (!stepKey.ok) return err(repo(stepKey.error));
          // 这一段调用过、却没写进正文（例如写入时冲突）时，接着写复用那次的结果；前文在这期间变了（例如前面的章节写完、整理了记忆），对不上就重新调用。
          const result = await runner.text({ prompt: prompt.value, maxOutputTokens: segmentOutputTokens(progress.words[i] ?? 1500), effort: 'high', stepKey: stepKey.value, recallOnChange: true }, events);
          if (!result.ok) return outcome(aborted() ? 'cancelled' : 'stopped', result.error.code === 'settings' ? result.error.detail : '调用模型失败');
          if (result.value.outcome === 'cancelled') return outcome('cancelled', null);
          if (result.value.outcome === 'refused') return outcome('stopped', `模型拒绝了这一段${result.value.refusal?.explanation ? `：${result.value.refusal.explanation}` : ''}`);
          if (result.value.outcome === 'truncated') {
            return outcome('stopped', `第 ${i + 1} 段的输出被截断，没有写入；可以在模型服务中调高这个模型的最大输出，或换一个模型，再接着写（这一段会重新写）`);
          }
          // 写手的输出先规范标点（B74），再按行切成段落。
          texts = splitParagraphs(normalizePunctuation(result.value.text));
          spent = result.value.usage?.outputTokens ?? null;
        }
        if (texts.length === 0) {
          const thinking = spent !== null && spent > 0 ? `输出的 ${spent.toLocaleString('en-US')} 个 Token 都用在了思考上，` : '';
          return outcome('stopped', `第 ${i + 1} 段模型回了空的回复（${thinking}没有写出正文），重试一次仍是空的；可以接着写（这一段会重新写），总是这样时换一个模型`);
        }

        const written = await appendWrittenSegment(port, { plan, paragraphs: paragraphs.value, texts, newId: () => deps.ids.next() }, ctx());
        if (!written.ok) {
          if (written.error.code === 'conflict') return outcome('stopped', `“${chapter.title}”在写作过程中被修改，写手已停下；已写入的 ${plan.progress?.done ?? 0} 段保留，可以接着写`);
          return err(repo(written.error));
        }
        plan = written.value.plan;
        paragraphs = ok(written.value.paragraphs);
        events.onSegment?.(plan.progress?.done ?? i + 1, total);
      }
      return outcome('written', null);
    },

    /**
     * 本章已有正文写到了这些情节点（推演成章采纳的正文，B85）：写手从其余的情节点接着写。先存“写手写入”快照
     * （一键回退回到采纳后的样子），进度的第一段是已写出的情节点、记为已写，之后 writeChapter 从第二段接着写；
     * 情节点都已写出时不开写作，计划直接标为已写。已有进度（中断后继续）时不重建，只返回剩余的段数。
     */
    async startWriterAfter(chapterId: string, writtenBeats: readonly string[], options: { readonly snapshotId?: string } = {}): Promise<Result<{ readonly remaining: number }, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const { port } = s;
      const loaded = await getChapterPlan(port, chapterId);
      if (!loaded.ok) return err(repo(loaded.error));
      const plan = loaded.value;
      if (plan === null) return err(settings('这一章还没有章节计划：先在“计划”中写好本章的目标与情节点'));
      if (plan.status === 'written' || plan.status === 'reviewed') return err(settings('这一章已经写过；要重写请先回退到写手写入前'));
      const progress = plan.progress;
      if (progress !== null) return ok({ remaining: progress.segments.length - progress.done });
      const draft = await deps.drafts.read(s.path, chapterId);
      if (draft.ok && draft.value !== null) return err(settings('这一章有未保存的修改：请先打开这一章保存或丢弃'));
      const segments = planSegmentsAfter(plan.beats, writtenBeats, plan.targetWords);
      const remaining = segments.segments.length - segments.done;
      if (remaining === 0) {
        const written = await setPlanStatus(port, plan, 'written', ctx());
        return written.ok ? ok({ remaining: 0 }) : err(repo(written.error));
      }
      // 推演整书（B86）给出写入推演正文之前存的快照：写手运行沿用它，“回退写手写入”回到推演正文写入之前。
      let snapshotId = options.snapshotId ?? null;
      if (snapshotId === null) {
        const snapshot = await createSnapshot(port, { id: deps.ids.next(), chapterId, reason: 'writer' }, ctx());
        if (!snapshot.ok) return err(repo(snapshot.error));
        snapshotId = snapshot.value.id;
      }
      const started = await startWriterRun(
        port,
        plan,
        { runId: deps.ids.next(), segments: segments.segments.map((b) => [...b]), words: [...segments.words], done: segments.done, snapshotId },
        ctx(),
      );
      if (!started.ok) return err(repo(started.error));
      return ok({ remaining });
    },

    /**
     * 推演整书（B86）：推演写成的正文已写进这一章，问模型它写出了本章计划里的哪些情节点，写手从其余的接着写。
     * 对不上的序号丢弃；没有计划或没有情节点时为空。
     */
    async beatsCovered(chapterId: string, text: string, stepKey: string, options: CallOptions = {}): Promise<Result<readonly string[], AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const plan = await getChapterPlan(s.port, chapterId);
      if (!plan.ok) return err(repo(plan.error));
      const beats = plan.value?.beats ?? [];
      if (plan.value === null || beats.length === 0) return ok([]);
      const prompt = renderSceneCoverage({ goal: plan.value.goal, beats, text });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: COVERAGE_OUTPUT_TOKENS, effort: 'low', stepKey }, SceneCoverageOutput, options);
      if (!result.ok) return result;
      const covered = new Set(result.value.value.covered);
      return ok(beats.filter((_, i) => covered.has(i + 1)));
    },

    /** 回退到写手写入前：恢复“写手写入”快照（现稿先存为恢复前快照），清除进度，计划回到待写。 */
    async rollbackWriter(chapterId: string): Promise<Result<ChapterPlan, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const plan = await getChapterPlan(s.port, chapterId);
      if (!plan.ok) return err(repo(plan.error));
      const progress = plan.value?.progress ?? null;
      if (plan.value === null || progress === null) return err(settings('这一章没有写手写入的记录'));
      // 恢复正文与清除进度在同一事务中（rollbackWriterRun），之后才删草稿。
      const reset = await rollbackWriterRun(s.port, plan.value, { snapshotId: progress.snapshotId, backupId: deps.ids.next() }, ctx());
      if (!reset.ok) return err(repo(reset.error));
      await deps.drafts.remove(s.path, chapterId);
      return reset;
    },
  };

  const busy = (chapterId: string) => (writing.has(chapterId) ? err(settings('写手正在写这一章：等它写完，或在“任务”里停下以后再说')) : null);
  /** 在这一章的写手锁里做 f：写手写章与写手修订共用，同一章同时只有一个在改正文。 */
  async function locked<T>(chapterId: string, f: () => Promise<Result<T, AppError>>): Promise<Result<T, AppError>> {
    const refused = busy(chapterId);
    if (refused !== null) return refused;
    writing.add(chapterId);
    try {
      return await f();
    } finally {
      writing.delete(chapterId);
    }
  }
  return {
    ...cases,
    writeChapter: (chapterId: string, events: WriterEvents = {}): Promise<Result<WriterOutcome, AppError>> => locked(chapterId, () => cases.writeChapter(chapterId, events)),
    startWriterAfter: (chapterId: string, writtenBeats: readonly string[], options?: { readonly snapshotId?: string }) => locked(chapterId, () => cases.startWriterAfter(chapterId, writtenBeats, options)),
    withWriterLock: locked,
    /** 写手此刻是不是正在写这一章（按章节建推演场景时，前文梗概据此标“还没写完”）。 */
    isWriting: (chapterId: string) => writing.has(chapterId),
    async rollbackWriter(chapterId: string): Promise<Result<ChapterPlan, AppError>> {
      return busy(chapterId) ?? cases.rollbackWriter(chapterId);
    },
    /**
     * 恢复快照前的检查：写手正在写这一章，或写到一半（进度没写完）时不恢复——恢复后“接着写”会从第 k 段续写，
     * 前面已写的段却已不在正文里，章节仍会标为写完。要恢复先回退到写手写入前，或接着写完。
     */
    async restoreRefused(chapterId: string): Promise<AppError | null> {
      const refused = busy(chapterId);
      if (refused !== null) return refused.error;
      const s = session();
      if (s === null) return { code: 'no_work' };
      const plan = await getChapterPlan(s.port, chapterId);
      if (!plan.ok) return repo(plan.error);
      const progress = plan.value?.progress ?? null;
      if (plan.value?.status === 'writing' && progress !== null && progress.done < progress.segments.length) {
        return settings('写手把这一章写到一半：先回退到写手写入前，或接着写完，再恢复快照');
      }
      return null;
    },
    /** 正在由写手写作的章节（AI 助手的现状里列出）。 */
    writingChapters: (): readonly string[] => [...writing],
  };
}

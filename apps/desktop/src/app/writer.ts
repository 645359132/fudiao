// 写手成章的用例（需求 B59、B60，施工文档第五章“写手与审核”）。
// 按章节计划的情节点分段写：每段一次调用；写完一段就接在章末，并在同一事务中更新计划里的进度。
// 写第一段之前保存“写手写入”快照，作者可以一键回退；写入的段落记为 AI 生成（硬性规则 21）。
// 每段的步骤键是“章节 + 这次写作的标识 + 段号”：中断后续写时，已写入的段跳过，已完成但没写入的调用复用记录，不重复计费。
import type { CallOptions } from '@fudiao/llm';
import { BUILTIN_SKILLS, renderWriterChapter } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  appendWrittenSegment,
  createSnapshot,
  getChapterPlan,
  getProject,
  listChapterMemories,
  listChapters,
  listChaptersWithText,
  listEntities,
  listFacts,
  listForeshadows,
  listParagraphs,
  ensureBuiltinSkills,
  resetWriterRun,
  restoreSnapshot,
  startWriterRun,
  type Chapter,
  type ChapterPlan,
  type RepoError,
  type SavedParagraph,
  type SqlPort,
} from '@fudiao/store';
import { composeSkills, effectiveAvoidPhrases, foreshadowsForChapter, planSegments, splitParagraphs } from '@fudiao/writing';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';

/** 带给写手的上文长度（字）：上一章的结尾与本章已写的结尾。 */
export const TAIL_CHARS = 1500;
/** 前文梗概最多带多少字，超出时先去掉最远的章节。 */
export const MEMORY_CHARS = 6000;
/** 相关事实最多带多少条。 */
export const MAX_FACTS = 30;

/** 每段的输出上限：目标字数的两倍，另留出思考的余量。 */
const segmentOutputTokens = (words: number) => words * 2 + THINKING_ALLOWANCE;

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

export function writerUseCases(deps: AppDeps, session: () => { readonly port: SqlPort; readonly path: string } | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });

  /** 本章不随分段变化的材料：作品、技能、人物、事实、伏笔、前文梗概与上一章的结尾。 */
  async function materials(port: SqlPort, chapter: Chapter, chapters: readonly Chapter[], plan: ChapterPlan) {
    const [work, skills, entities, facts, foreshadows, memories, withText] = await Promise.all([
      getProject(port),
      // 作品还没打开过“写作技能”页时，内置技能在这里登记（全部启用）。
      ensureBuiltinSkills(port, BUILTIN_SKILLS.map(({ key, name, version }) => ({ key, name, version })), () => deps.ids.next(), ctx()),
      listEntities(port),
      listFacts(port),
      listForeshadows(port),
      listChapterMemories(port),
      listChaptersWithText(port),
    ]);
    if (!work.ok) return err(repo(work.error));
    if (!skills.ok) return err(repo(skills.error));
    if (!entities.ok) return err(repo(entities.error));
    if (!facts.ok) return err(repo(facts.error));
    if (!foreshadows.ok) return err(repo(foreshadows.error));
    if (!memories.ok) return err(repo(memories.error));
    if (!withText.ok) return err(repo(withText.error));

    const order = new Map(chapters.map((c, i) => [c.id, i]));
    const index = order.get(chapter.id) ?? 0;
    const cast = entities.value.filter((e) => plan.castIds.includes(e.id));
    const castIds = new Set(cast.map((c) => c.id));
    const fs = foreshadowsForChapter(plan, foreshadows.value, order);

    // 前文梗概：优先用长篇记忆（待复核的也用，它仍是最接近正文的梗概），没有时用作者写的章节梗概；从近到远选入，超出预算时去掉最远的。
    // 正文已经清空（例如回退之后）的章节，留下的记忆不再对应任何正文，不用。
    const hasText = new Set(withText.value);
    const memoryOf = new Map(memories.value.filter((m) => hasText.has(m.chapterId)).map((m) => [m.chapterId, m]));
    const earlier: { title: string; summary: string }[] = [];
    let used = 0;
    for (const c of chapters.slice(0, index).reverse()) {
      const summary = (memoryOf.get(c.id)?.summary ?? c.summary).trim();
      if (summary === '') continue;
      if (used + summary.length > MEMORY_CHARS) break;
      used += summary.length;
      earlier.unshift({ title: c.title, summary });
    }

    // 人物最近的状态与伏笔在前文中的进展，取自前面各章的长篇记忆（从远到近，后面的覆盖前面的）。
    const stateOf = new Map<string, string>();
    const progressOf = new Map<string, string[]>();
    for (const c of chapters.slice(0, index)) {
      const memory = memoryOf.get(c.id);
      if (memory === undefined) continue;
      for (const [id, state] of Object.entries(memory.castState)) stateOf.set(id, state);
      for (const [id, progress] of Object.entries(memory.foreshadowProgress)) progressOf.set(id, [...(progressOf.get(id) ?? []), `${c.title}：${progress}`]);
    }

    const previous = chapters[index - 1];
    let previousEnding = '';
    if (previous !== undefined) {
      const before = await listParagraphs(port, previous.id);
      if (!before.ok) return err(repo(before.error));
      previousEnding = tail(body(before.value));
    }

    return ok({
      title: work.value?.title ?? '',
      genre: work.value?.genre ?? '',
      chapterTitle: chapter.title,
      goal: plan.goal,
      treatment: plan.treatment,
      skills: composeSkills(skills.value, BUILTIN_SKILLS).map((s) => ({ name: s.name, description: s.description, text: s.text })),
      avoidPhrases: effectiveAvoidPhrases(work.value?.avoidPhrases ?? null),
      cast: cast.map((c) => ({ name: c.name, description: c.description, state: stateOf.get(c.id) ?? '' })),
      facts: facts.value
        .filter((f) => {
          if (f.status !== 'confirmed') return false;
          // 只用适用于本章的事实（与上下文、审核相同）：后面章节才成立的事、已经不再成立的事都不给写手。
          const from = f.validFromChapterId === null ? undefined : order.get(f.validFromChapterId);
          const to = f.validToChapterId === null ? undefined : order.get(f.validToChapterId);
          if ((from !== undefined && from > index) || (to !== undefined && to < index)) return false;
          return f.subjectIds.some((id) => castIds.has(id)) || (f.holderId !== null && castIds.has(f.holderId));
        })
        .slice(0, MAX_FACTS)
        .map((f) => f.content),
      memories: earlier,
      toPlant: fs.toPlant.map((f) => ({ title: f.title, content: f.content })),
      toPayoff: fs.toPayoff.map((f) => ({ title: f.title, content: f.content, reveal: f.reveal, progress: progressOf.get(f.id) ?? [] })),
      mustNotReveal: fs.mustNotReveal.map((f) => f.reveal.trim()),
      previousEnding,
    });
  }

  return {
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
        const result = await runner.text(
          { prompt: prompt.value, maxOutputTokens: segmentOutputTokens(progress.words[i] ?? 1500), effort: 'high', stepKey: `writer:${chapterId}:${progress.runId}:${i}` },
          events,
        );
        if (!result.ok) return outcome(aborted() ? 'cancelled' : 'stopped', result.error.code === 'settings' ? result.error.detail : '调用模型失败');
        if (result.value.outcome === 'cancelled') return outcome('cancelled', null);
        if (result.value.outcome === 'refused') return outcome('stopped', `模型拒绝了这一段${result.value.refusal?.explanation ? `：${result.value.refusal.explanation}` : ''}`);
        const texts = splitParagraphs(result.value.text);
        if (texts.length === 0) return outcome('stopped', '模型没有写出文字');

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

    /** 回退到写手写入前：恢复“写手写入”快照（现稿先存为恢复前快照），清除进度，计划回到待写。 */
    async rollbackWriter(chapterId: string): Promise<Result<ChapterPlan, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const plan = await getChapterPlan(s.port, chapterId);
      if (!plan.ok) return err(repo(plan.error));
      const progress = plan.value?.progress ?? null;
      if (plan.value === null || progress === null) return err(settings('这一章没有写手写入的记录'));
      const restored = await restoreSnapshot(s.port, { snapshotId: progress.snapshotId, backupId: deps.ids.next() }, ctx());
      if (!restored.ok) return err(repo(restored.error));
      await deps.drafts.remove(s.path, chapterId);
      const reset = await resetWriterRun(s.port, plan.value, ctx());
      return reset.ok ? reset : err(repo(reset.error));
    },
  };
}

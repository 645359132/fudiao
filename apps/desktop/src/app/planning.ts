// 章节计划与伏笔账本的用例（需求 B63、B65，施工文档第五章“写手与审核”）。
// 计划草稿由模型从作品大纲拆出，只是草稿：作者看过、修改后“采用”，才写入章节计划与伏笔账本。
import type { CallOptions } from '@fudiao/llm';
import { PlanDraftOutput, renderPlanDraft, type PlanDraftData } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  createChapter,
  createVolume,
  countPendingIssues,
  moveChapter,
  updateVolume,
  listVolumes,
  createForeshadow,
  deleteChapterPlan,
  deleteForeshadow,
  getChapterPlan,
  getProject,
  listChapterMemories,
  listChapterPlans,
  listChaptersWithText,
  listChapters,
  listEntities,
  listForeshadows,
  reviewStaleMemories,
  saveChapterPlan,
  updateForeshadow,
  type Chapter,
  type ChapterMemory,
  type ChapterPlan,
  type Entity,
  type Foreshadow,
  type ForeshadowFields,
  type PlanFields,
  type RepoError,
  type SqlPort,
} from '@fudiao/store';
import { checkPlan, suggestForeshadowStatus, type ForeshadowSuggestion, type PlanProblem } from '@fudiao/writing';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';
import { skillsForStage } from './writing-skills';

export type PlanChapterView = {
  readonly chapter: Chapter;
  readonly plan: ChapterPlan | null;
  readonly problems: readonly PlanProblem[];
  /** 长篇记忆（B66）；正文在生成记忆后改过时状态为待复核。 */
  readonly memory: ChapterMemory | null;
  readonly hasText: boolean;
  /** 待处理的审核问题数（B64）。 */
  readonly pendingIssues: number;
};

export type PlanningView = {
  readonly outline: string;
  readonly chapters: readonly PlanChapterView[];
  readonly foreshadows: readonly Foreshadow[];
  /**
   * 账本状态的建议（B63）：埋设或回收的章节已经写完，账本还没有跟上。progress 是那一章的长篇记忆里这条伏笔的进展，没有时为 null。
   * 作者确认后才改账本。
   */
  readonly foreshadowSuggestions: readonly (ForeshadowSuggestion & { readonly progress: string | null })[];
  /** 可以选作出场人物的设定（人物类）。 */
  readonly characters: readonly Entity[];
};

/** 计划草稿；分卷字段可以省略（不分卷）。 */
export type PlanDraft = PlanDraftData;

/** stepKey：写作工作流里调用时的步骤键，中断后再做同一次时复用已完成的调用。 */
export type PlanDraftRequest = { readonly chapterCount: number; readonly wordsPerChapter: number; readonly stepKey?: string };

/** 采用草稿的结果：草稿中写了、但人物设定里找不到的名字（没有建设定，作者可以自己补）。 */
export type AppliedDraft = { readonly view: PlanningView; readonly unmatchedCast: readonly string[] };

const repo = (error: RepoError): AppError => ({ code: 'repo', error });

/** 计划草稿的输出上限：每章约 400 字的计划，留出思考的余量。 */
const draftOutputTokens = (chapters: number) => chapters * 1_200 + THINKING_ALLOWANCE;

export function planningUseCases(deps: AppDeps, project: () => SqlPort | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });

  async function view(port: SqlPort): Promise<Result<PlanningView, AppError>> {
    // 先标出需要复核的记忆，列出的状态因此总是最新的。
    const reviewed = await reviewStaleMemories(port, ctx());
    if (!reviewed.ok) return err(repo(reviewed.error));
    const [work, chapters, plans, foreshadows, entities, memories, withText, issues] = await Promise.all([
      getProject(port),
      listChapters(port, 'normal'),
      listChapterPlans(port),
      listForeshadows(port),
      listEntities(port),
      listChapterMemories(port),
      listChaptersWithText(port),
      countPendingIssues(port),
    ]);
    if (!issues.ok) return err(repo(issues.error));
    if (!memories.ok) return err(repo(memories.error));
    if (!withText.ok) return err(repo(withText.error));
    if (!work.ok) return err(repo(work.error));
    if (!chapters.ok) return err(repo(chapters.error));
    if (!plans.ok) return err(repo(plans.error));
    if (!foreshadows.ok) return err(repo(foreshadows.error));
    if (!entities.ok) return err(repo(entities.error));
    const order = new Map(chapters.value.map((c, i) => [c.id, i]));
    const byChapter = new Map(plans.value.map((p) => [p.chapterId, p]));
    const memoryOf = new Map(memories.value.map((m) => [m.chapterId, m]));
    const hasText = new Set(withText.value);
    return ok({
      outline: work.value?.outline ?? '',
      chapters: chapters.value.map((chapter) => {
        const plan = byChapter.get(chapter.id) ?? null;
        return {
          chapter,
          plan,
          problems: plan === null ? [] : checkPlan(plan, foreshadows.value, order),
          memory: memoryOf.get(chapter.id) ?? null,
          hasText: hasText.has(chapter.id),
          pendingIssues: issues.value.get(chapter.id) ?? 0,
        };
      }),
      foreshadows: foreshadows.value,
      foreshadowSuggestions: suggestForeshadowStatus(foreshadows.value, plans.value).map((s) => ({
        ...s,
        progress: memoryOf.get(s.chapterId)?.foreshadowProgress[s.foreshadowId] ?? null,
      })),
      characters: entities.value.filter((e) => e.kind === 'character'),
    });
  }

  async function change(f: (port: SqlPort) => Promise<Result<unknown, RepoError>>): Promise<Result<PlanningView, AppError>> {
    const port = project();
    if (port === null) return err({ code: 'no_work' });
    const done = await f(port);
    return done.ok ? view(port) : err(repo(done.error));
  }

  /**
   * 草稿里的卷（B68）对应到作品里的卷：按卷名找已有的，没有的按草稿的顺序在最后新建并写上梗概；
   * 已有的卷没有简介时补上草稿的梗概。返回卷名到卷的标识；草稿不分卷时为空。
   */
  async function placeVolumes(port: SqlPort, draft: PlanDraft): Promise<Result<Map<string, string>, AppError>> {
    const titles = [...new Set([...(draft.volumes ?? []).map((v) => v.title.trim()), ...draft.chapters.map((c) => (c.volume ?? '').trim())])].filter((t) => t !== '');
    const map = new Map<string, string>();
    if (titles.length === 0) return ok(map);
    const existing = await listVolumes(port);
    if (!existing.ok) return err(repo(existing.error));
    for (const title of titles) {
      const summary = (draft.volumes ?? []).find((v) => v.title.trim() === title)?.summary.trim() ?? '';
      const known = existing.value.find((v) => v.title.trim() === title);
      if (known !== undefined) {
        map.set(title, known.id);
        if (known.summary.trim() === '' && summary !== '') {
          const filled = await updateVolume(port, known.id, known.version, { title: known.title, summary }, ctx());
          if (!filled.ok) return err(repo(filled.error));
        }
        continue;
      }
      const created = await createVolume(port, { id: deps.ids.next(), title }, ctx());
      if (!created.ok) return err(repo(created.error));
      if (summary !== '') {
        const described = await updateVolume(port, created.value.id, created.value.version, { title, summary }, ctx());
        if (!described.ok) return err(repo(described.error));
      }
      map.set(title, created.value.id);
    }
    return ok(map);
  }

  return {
    async planningView(): Promise<Result<PlanningView, AppError>> {
      const port = project();
      return port === null ? err({ code: 'no_work' }) : view(port);
    },

    /** 由作品大纲拆出章节计划草稿（不写入作品）。 */
    async draftPlans(request: PlanDraftRequest, options: CallOptions = {}): Promise<Result<PlanDraft, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const current = await view(port);
      if (!current.ok) return current;
      const work = await getProject(port);
      if (!work.ok) return err(repo(work.error));
      if (current.value.outline.trim() === '') return err({ code: 'settings', detail: '请先在作品信息中写下作品大纲' });
      const volumes = await listVolumes(port);
      if (!volumes.ok) return err(repo(volumes.error));
      // 规划技能（B75），例如雪花写作法。
      const skills = await skillsForStage(port, 'planning', deps);
      if (!skills.ok) return err(repo(skills.error));
      const prompt = renderPlanDraft({
        title: work.value?.title ?? '',
        genre: work.value?.genre ?? '',
        synopsis: work.value?.synopsis ?? '',
        outline: current.value.outline,
        characters: current.value.characters.map((c) => ({ name: c.name, description: c.description })),
        skills: skills.value.map((s) => ({ name: s.name, description: s.description, text: s.text })),
        chapters: current.value.chapters.map((c) => c.chapter.title),
        volumes: volumes.value.map((v) => v.title),
        foreshadows: current.value.foreshadows.filter((f) => f.status !== 'dropped').map((f) => ({ title: f.title, content: f.content, reveal: f.reveal })),
        chapterCount: request.chapterCount,
        wordsPerChapter: request.wordsPerChapter,
      });
      if (!prompt.ok) return err({ code: 'settings', detail: prompt.error });
      const result = await runner.structured(
        { prompt: prompt.value, maxOutputTokens: draftOutputTokens(request.chapterCount), effort: 'medium', ...(request.stepKey !== undefined && { stepKey: request.stepKey }) },
        PlanDraftOutput,
        options,
      );
      return result.ok ? ok(result.value.value) : result;
    },

    /**
     * 采用草稿：已有章节按顺序对应草稿的前几章（章名不改），多出的章节在末尾新建；
     * 新伏笔记入账本（计划状态），埋设与回收的章节取草稿中列出它的章；人物按名字与别名对应到人物设定。
     * 分卷（B68）：草稿里的卷按卷名对应到已有的卷，没有的在最后新建（写上梗概；已有的卷没有简介时补上）；
     * 新建的章节放进草稿给它的卷；已有的章节还未分卷时移进草稿给它的卷，已经在某一卷里的不动（作者定过的）。
     */
    async applyPlanDraft(draft: PlanDraft): Promise<Result<AppliedDraft, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const volumeOf = await placeVolumes(port, draft);
      if (!volumeOf.ok) return volumeOf;
      const chapters = await listChapters(port, 'normal');
      if (!chapters.ok) return err(repo(chapters.error));
      const ids = chapters.value.map((c) => c.id);
      // 每一卷当前的最后一章：移进来与新建的章节按草稿的顺序接在卷末。
      const lastIn = new Map<string, string>();
      for (const c of chapters.value) if (c.volumeId !== null) lastIn.set(c.volumeId, c.id);
      for (const [i, c] of chapters.value.entries()) {
        const target = volumeOf.value.get((draft.chapters[i]?.volume ?? '').trim());
        if (c.volumeId !== null || target === undefined) continue;
        const moved = await moveChapter(port, c.id, c.version, { volumeId: target, after: lastIn.get(target) ?? null }, ctx());
        if (!moved.ok) return err(repo(moved.error));
        lastIn.set(target, c.id);
      }
      for (const planned of draft.chapters.slice(ids.length)) {
        const volumeId = volumeOf.value.get((planned.volume ?? '').trim());
        const title = planned.title.trim() || '未命名章节';
        const created = await createChapter(
          port,
          { id: deps.ids.next(), title, ...(volumeId !== undefined ? { volumeId } : ids.length > 0 && { after: ids.at(-1)! }) },
          ctx(),
        );
        if (!created.ok) return err(repo(created.error));
        ids.push(created.value.id);
        if (volumeId !== undefined) lastIn.set(volumeId, created.value.id);
      }

      const existing = await listForeshadows(port);
      if (!existing.ok) return err(repo(existing.error));
      const byTitle = new Map(existing.value.map((f) => [f.title.trim(), f.id]));
      const chapterOf = (title: string, field: 'plant' | 'payoff') => {
        const i = draft.chapters.findIndex((c) => c[field].some((t) => t.trim() === title));
        return i < 0 ? null : (ids[i] ?? null);
      };
      for (const f of draft.foreshadows) {
        const title = f.title.trim();
        if (title === '' || byTitle.has(title)) continue;
        const fields: ForeshadowFields = {
          title,
          content: f.content,
          reveal: f.reveal,
          plantChapterId: chapterOf(title, 'plant'),
          plantAnchor: null,
          payoffChapterId: chapterOf(title, 'payoff'),
          payoffAnchor: null,
          status: 'planned',
        };
        const created = await createForeshadow(port, { id: deps.ids.next(), ...fields }, ctx());
        if (!created.ok) return err(repo(created.error));
        byTitle.set(title, created.value.id);
      }

      // 账本里已有、还没有定章节的伏笔：草稿安排了埋设或回收的章节时补上；作者定过的不改。
      for (const f of existing.value) {
        const title = f.title.trim();
        const plantChapterId = f.plantChapterId ?? chapterOf(title, 'plant');
        const payoffChapterId = f.payoffChapterId ?? chapterOf(title, 'payoff');
        if (plantChapterId === f.plantChapterId && payoffChapterId === f.payoffChapterId) continue;
        const placed = await updateForeshadow(
          port,
          f,
          { title: f.title, content: f.content, reveal: f.reveal, plantChapterId, plantAnchor: f.plantAnchor, payoffChapterId, payoffAnchor: f.payoffAnchor, status: f.status },
          ctx(),
        );
        if (!placed.ok) return err(repo(placed.error));
      }

      const entities = await listEntities(port);
      if (!entities.ok) return err(repo(entities.error));
      const characterOf = new Map(entities.value.filter((e) => e.kind === 'character').flatMap((e) => [e.name, ...e.aliases].map((n) => [n.trim(), e.id] as const)));
      const unmatched = new Set<string>();
      const foreshadowIds = (titles: readonly string[]) => titles.flatMap((t) => byTitle.get(t.trim()) ?? []);
      for (const [i, planned] of draft.chapters.entries()) {
        const chapterId = ids[i];
        if (chapterId === undefined) continue;
        const castIds = planned.cast.flatMap((name) => {
          const id = characterOf.get(name.trim());
          if (id === undefined && name.trim() !== '') unmatched.add(name.trim());
          return id ?? [];
        });
        const fields: PlanFields = {
          goal: planned.goal,
          castIds: [...new Set(castIds)],
          beats: planned.beats.map((b) => b.trim()).filter((b) => b !== ''),
          foreshadowPlant: foreshadowIds(planned.plant),
          foreshadowPayoff: foreshadowIds(planned.payoff),
          treatment: planned.treatment,
          targetWords: planned.targetWords,
        };
        const current = await getChapterPlan(port, chapterId);
        if (!current.ok) return err(repo(current.error));
        const saved = await saveChapterPlan(port, chapterId, current.value, fields, ctx());
        if (!saved.ok) return err(repo(saved.error));
      }
      const result = await view(port);
      return result.ok ? ok({ view: result.value, unmatchedCast: [...unmatched] }) : result;
    },

    async savePlan(chapterId: string, fields: PlanFields): Promise<Result<PlanningView, AppError>> {
      return change(async (port) => {
        const current = await getChapterPlan(port, chapterId);
        return current.ok ? saveChapterPlan(port, chapterId, current.value, fields, ctx()) : current;
      });
    },

    /** 删除一章的计划（AI 助手撤销自己新建的计划）；没有计划时什么也不做。 */
    async deletePlan(chapterId: string): Promise<Result<PlanningView, AppError>> {
      return change(async (port) => {
        const current = await getChapterPlan(port, chapterId);
        if (!current.ok || current.value === null) return current.ok ? ok(undefined) : current;
        return deleteChapterPlan(port, current.value);
      });
    },

    addForeshadow: (fields: ForeshadowFields) => change((port) => createForeshadow(port, { id: deps.ids.next(), ...fields }, ctx())),
    updateForeshadow: (foreshadow: Foreshadow, fields: ForeshadowFields) => change((port) => updateForeshadow(port, foreshadow, fields, ctx())),
    deleteForeshadow: (foreshadow: Foreshadow) => change((port) => deleteForeshadow(port, foreshadow)),
  };
}

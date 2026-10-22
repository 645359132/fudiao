// 章节计划与伏笔账本的用例（需求 B63、B65，施工文档第五章“写手与审核”）。
// 计划草稿由模型从作品大纲拆出，只是草稿：作者看过、修改后“采用”，才写入章节计划与伏笔账本。
import type { CallOptions } from '@fudiao/llm';
import { PlanDraftOutput, renderBookVolumes, renderPlanDraft, renderVolumeOutline, BookVolumesOutput, VolumeOutlineOutput, type PlanDraftData } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  createChapter,
  createEntity,
  listRelationships,
  updateEntity,
  type Volume,
  createVolume,
  countPendingIssues,
  moveChapter,
  updateVolume,
  listVolumes,
  trashChapter,
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
/** 一次拆完全书时的分卷方式：auto 由模型按故事段落分、none 不分卷、fixed 指定卷数。 */
export const VOLUME_MODES = ['auto', 'none', 'fixed'] as const;
export type VolumeMode = (typeof VOLUME_MODES)[number];

export type PlanDraftRequest = {
  readonly chapterCount: number;
  readonly wordsPerChapter: number;
  readonly stepKey?: string;
  /** 一次拆完全书时的分卷方式与卷数（只给一卷拆章时不用）。省略按 auto。 */
  readonly volumeMode?: VolumeMode;
  readonly volumeCount?: number | null;
};

/** 一键成书的全书卷纲：各卷的章数，按顺序。 */
export type BookVolumesRequest = { readonly volumes: readonly number[]; readonly stepKey?: string };
/** 全书卷纲要写的内容最多约多少 Token：每卷约 700。 */
export const bookVolumesContentTokens = (volumes: number) => Math.min(16_000, 1_500 + volumes * 700);
const bookVolumesOutputTokens = (volumes: number) => bookVolumesContentTokens(volumes) + THINKING_ALLOWANCE;

/** 续写一卷（B82）的卷纲：卷名、梗概、主线、卷末转折、新人物、要回收的伏笔与新伏笔。 */
export type VolumeOutline = VolumeOutlineOutput;

export type VolumeOutlineRequest = { readonly chapterCount: number; readonly instruction: string; readonly stepKey?: string };

/** 卷纲给的前文：最近几章的梗概，最多这么多章。 */
const OUTLINE_RECENT_CHAPTERS = 8;
/** 只给新的一卷拆章时列出的已有章节（最后几章）。 */
const APPEND_LISTED_CHAPTERS = 20;
const VOLUME_OUTLINE_TOKENS = 4_000 + THINKING_ALLOWANCE;

/** 采用草稿的结果：草稿中写了、但人物设定里找不到的名字（没有建设定，作者可以自己补）。 */
export type AppliedDraft = { readonly view: PlanningView; readonly unmatchedCast: readonly string[] };

const repo = (error: RepoError): AppError => ({ code: 'repo', error });

/** 计划草稿要写的内容最多约多少 Token：每章约 400 字的计划。 */
export const planContentTokens = (chapters: number) => chapters * 1_200;
/** 计划草稿的输出上限：内容之外留出思考的余量。 */
const draftOutputTokens = (chapters: number) => planContentTokens(chapters) + THINKING_ALLOWANCE;

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

  /**
   * 把草稿的第 i 章写进 ids[i] 这一章：新伏笔记入账本（埋设与回收的章节取草稿中列出它的章），账本里已有、
   * 还没有定章节的伏笔按草稿补上章节（作者定过的不改）；每章的计划按名字对应人物与伏笔。返回对不上的人物名字。
   */
  async function writeDraftPlans(port: SqlPort, draft: PlanDraft, ids: readonly string[]): Promise<Result<string[], AppError>> {
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
    return ok([...unmatched]);
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

  /**
   * 采用卷纲：在最后新建一卷，简介写梗概、主线与卷末转折；新人物建人物卡片（同名的不重复建）；
   * 新伏笔记入账本（计划状态，章节由本卷的章节计划补上）。返回新建的卷与建了几项。
   */
async function applyVolumeOutline(outline: VolumeOutline): Promise<Result<{ readonly volume: Volume; readonly characters: number; readonly foreshadows: number }, AppError>> {
    const port = project();
    if (port === null) return err({ code: 'no_work' });
    const title = outline.title.trim();
    if (title === '') return err({ code: 'settings', detail: '卷名不能为空' });
    const summary = [
      outline.summary.trim(),
      outline.mainline.length === 0 ? '' : `主线：${outline.mainline.map((m) => m.trim()).filter((m) => m !== '').join('；')}`,
      outline.climax.trim() === '' ? '' : `卷末：${outline.climax.trim()}`,
    ]
      .filter((x) => x !== '')
      .join('\n');
    const created = await createVolume(port, { id: deps.ids.next(), title }, ctx());
    if (!created.ok) return err(repo(created.error));
    const described = summary === '' ? ok(created.value) : await updateVolume(port, created.value.id, created.value.version, { title, summary }, ctx());
    if (!described.ok) return err(repo(described.error));
    const entities = await listEntities(port);
    if (!entities.ok) return err(repo(entities.error));
    const known = new Set(entities.value.filter((e) => e.kind === 'character').flatMap((e) => [e.name, ...e.aliases].map((n) => n.trim())));
    let characters = 0;
    for (const c of outline.newCharacters) {
      const name = c.name.trim();
      if (name === '' || known.has(name)) continue;
      known.add(name);
      const entity = await createEntity(port, { id: deps.ids.next(), kind: 'character', name }, ctx());
      if (!entity.ok) return err(repo(entity.error));
      if (c.description.trim() !== '') {
        const d = await updateEntity(port, entity.value.id, entity.value.version, { description: c.description.trim() }, ctx());
        if (!d.ok) return err(repo(d.error));
      }
      characters += 1;
    }
    const existing = await listForeshadows(port);
    if (!existing.ok) return err(repo(existing.error));
    const titles = new Set(existing.value.map((f) => f.title.trim()));
    let foreshadows = 0;
    for (const f of outline.newForeshadows) {
      const t = f.title.trim();
      if (t === '' || titles.has(t)) continue;
      titles.add(t);
      const made = await createForeshadow(
        port,
        { id: deps.ids.next(), title: t, content: f.content, reveal: f.reveal, plantChapterId: null, plantAnchor: null, payoffChapterId: null, payoffAnchor: null, status: 'planned' },
        ctx(),
      );
      if (!made.ok) return err(repo(made.error));
      foreshadows += 1;
    }
    return ok({ volume: described.value, characters, foreshadows });
  }

  return {
    /**
     * 续写一卷（B82）：由大纲、已有的卷、设定、人物关系、最近几章的长篇记忆、最后一章章尾留下的事与还没有回收的伏笔，
     * 生成下一卷的卷纲（不写入作品）。
     */
    async draftVolumeOutline(request: VolumeOutlineRequest, options: CallOptions = {}): Promise<Result<VolumeOutline, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const current = await view(port);
      if (!current.ok) return current;
      const [work, volumes, relations] = await Promise.all([getProject(port), listVolumes(port), listRelationships(port)]);
      if (!work.ok) return err(repo(work.error));
      if (!volumes.ok) return err(repo(volumes.error));
      if (!relations.ok) return err(repo(relations.error));
      const written = current.value.chapters.filter((c) => c.hasText);
      if (written.length === 0) return err({ code: 'settings', detail: '还没有写好的章节：续写一卷要接着前文写，先写几章，或用一键成书从头开始' });
      const skills = await skillsForStage(port, 'planning', deps);
      if (!skills.ok) return err(repo(skills.error));
      // 人物前文结尾的状态：取各章记忆里最后一次写到的。
      const stateOf = new Map<string, string>();
      for (const c of written) for (const [id, state] of Object.entries(c.memory?.castState ?? {})) stateOf.set(id, state);
      const nameOf = new Map(current.value.characters.map((e) => [e.id, e.name]));
      const recent = written.slice(-OUTLINE_RECENT_CHAPTERS).map((c) => ({ title: c.chapter.title, summary: (c.memory?.summary ?? c.chapter.summary).trim() || '（没有梗概）' }));
      const prompt = renderVolumeOutline({
        title: work.value?.title ?? '',
        genre: work.value?.genre ?? '',
        synopsis: work.value?.synopsis ?? '',
        outline: current.value.outline,
        volumes: volumes.value.map((v) => ({ title: v.title, summary: v.summary })),
        characters: current.value.characters.map((e) => ({ name: e.name, description: e.description, state: stateOf.get(e.id) ?? '' })),
        relations: relations.value.flatMap((r) => (nameOf.has(r.fromId) && nameOf.has(r.toId) ? [r.mutual ? `${nameOf.get(r.fromId) ?? ''}与${nameOf.get(r.toId) ?? ''}：${r.label}` : `${nameOf.get(r.fromId) ?? ''}是${nameOf.get(r.toId) ?? ''}的${r.label}`] : [])),
        skills: skills.value.map((x) => ({ name: x.name, description: x.description, text: x.text })),
        writtenCount: written.length,
        memories: recent,
        threads: written.at(-1)?.memory?.openThreads ?? [],
        foreshadows: current.value.foreshadows.filter((f) => f.status === 'planned' || f.status === 'planted').map((f) => ({ title: f.title, content: f.content, reveal: f.reveal })),
        chapterCount: request.chapterCount,
        instruction: request.instruction,
      });
      if (!prompt.ok) return err({ code: 'settings', detail: prompt.error });
      const result = await runner.structured(
        { prompt: prompt.value, maxOutputTokens: VOLUME_OUTLINE_TOKENS, effort: 'medium', ...(request.stepKey !== undefined && { stepKey: request.stepKey }) },
        VolumeOutlineOutput,
        options,
      );
      return result.ok ? ok(result.value.value) : result;
    },

    applyVolumeOutline,

    /**
     * 一键成书的全书卷纲（长篇先分卷再逐卷拆章）：按作者定的卷数与各卷章数，由大纲、人物与已有的伏笔给每卷定卷纲（不写入作品）。
     * 模型给出的卷数与要求不符时报错，由作者重做。
     */
    async draftBookVolumes(request: BookVolumesRequest, options: CallOptions = {}): Promise<Result<BookVolumesOutput, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      if (request.volumes.length === 0) return err({ code: 'settings', detail: '至少要有一卷' });
      const current = await view(port);
      if (!current.ok) return current;
      const work = await getProject(port);
      if (!work.ok) return err(repo(work.error));
      const skills = await skillsForStage(port, 'planning', deps);
      if (!skills.ok) return err(repo(skills.error));
      const open = current.value.foreshadows.filter((f) => f.status !== 'dropped' && f.status !== 'paid_off');
      const prompt = renderBookVolumes({
        title: work.value?.title ?? '',
        genre: work.value?.genre ?? '',
        synopsis: work.value?.synopsis ?? '',
        outline: current.value.outline.trim() === '' ? '（还没有写大纲）' : current.value.outline,
        characters: current.value.characters.map((c) => ({ name: c.name, description: c.description })),
        skills: skills.value.map((x) => ({ name: x.name, description: x.description, text: x.text })),
        foreshadows: open.map((f) => ({ title: f.title, content: f.content, reveal: f.reveal })),
        volumes: request.volumes,
      });
      if (!prompt.ok) return err({ code: 'settings', detail: prompt.error });
      const result = await runner.structured(
        { prompt: prompt.value, maxOutputTokens: bookVolumesOutputTokens(request.volumes.length), effort: 'medium', ...(request.stepKey !== undefined && { stepKey: request.stepKey }) },
        BookVolumesOutput,
        options,
      );
      if (!result.ok) return result;
      const got = result.value.value.volumes.length;
      if (got !== request.volumes.length) return err({ code: 'settings', detail: `模型给出 ${got} 卷，与要求的 ${request.volumes.length} 卷不符：可以重做这一步` });
      return ok(result.value.value);
    },

    /** 采用全书卷纲：按顺序逐卷新建（卷、新人物与新伏笔同采用一份卷纲）。返回各卷的标识与建了几项。 */
    async applyBookVolumes(volumes: readonly VolumeOutline[]): Promise<Result<{ readonly volumes: readonly { readonly id: string; readonly title: string }[]; readonly characters: number; readonly foreshadows: number }, AppError>> {
      const made: { readonly id: string; readonly title: string }[] = [];
      let characters = 0;
      let foreshadows = 0;
      for (const outline of volumes) {
        const applied = await applyVolumeOutline(outline);
        if (!applied.ok) return applied;
        made.push({ id: applied.value.volume.id, title: applied.value.volume.title });
        characters += applied.value.characters;
        foreshadows += applied.value.foreshadows;
      }
      return ok({ volumes: made, characters, foreshadows });
    },

    /**
     * 只给这一卷拆章节计划草稿（B82）：已有的章节只作为前文（列出最后几章与最近的梗概），不改动它们。
     * payoffs 是卷纲挑出的本卷要回收的伏笔：只带账本里确实有、还没回收也没废弃的，拆章时要求各安排到本卷的某一章。
     */
    async draftVolumePlans(
      request: PlanDraftRequest & {
        readonly volumeId: string;
        readonly payoffs?: readonly string[];
        /** 一键成书逐卷拆章时的全书分卷与“本卷之后还有卷”（续写一卷不给）。 */
        readonly bookVolumes?: readonly { readonly title: string; readonly summary: string }[];
        readonly laterVolumes?: boolean;
      },
      options: CallOptions = {},
    ): Promise<Result<PlanDraft, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const current = await view(port);
      if (!current.ok) return current;
      const [work, volumes] = await Promise.all([getProject(port), listVolumes(port)]);
      if (!work.ok) return err(repo(work.error));
      if (!volumes.ok) return err(repo(volumes.error));
      const volume = volumes.value.find((v) => v.id === request.volumeId);
      if (volume === undefined) return err({ code: 'settings', detail: '要拆章的这一卷不在了' });
      const skills = await skillsForStage(port, 'planning', deps);
      if (!skills.ok) return err(repo(skills.error));
      const written = current.value.chapters.filter((c) => c.hasText);
      const open = current.value.foreshadows.filter((f) => f.status !== 'dropped' && f.status !== 'paid_off');
      const openTitles = new Set(open.map((f) => f.title.trim()));
      const payoffs = [...new Set((request.payoffs ?? []).map((t) => t.trim()))].filter((t) => openTitles.has(t));
      const prompt = renderPlanDraft({
        title: work.value?.title ?? '',
        genre: work.value?.genre ?? '',
        synopsis: work.value?.synopsis ?? '',
        outline: current.value.outline.trim() === '' ? '（还没有写大纲）' : current.value.outline,
        characters: current.value.characters.map((c) => ({ name: c.name, description: c.description })),
        skills: skills.value.map((x) => ({ name: x.name, description: x.description, text: x.text })),
        chapters: current.value.chapters.slice(-APPEND_LISTED_CHAPTERS).map((c) => c.chapter.title),
        volumes: volumes.value.map((v) => v.title),
        foreshadows: open.map((f) => ({ title: f.title, content: f.content, reveal: f.reveal })),
        chapterCount: request.chapterCount,
        wordsPerChapter: request.wordsPerChapter,
        appendVolume: {
          title: volume.title,
          summary: volume.summary,
          recent: written.slice(-OUTLINE_RECENT_CHAPTERS).map((c) => ({ title: c.chapter.title, summary: (c.memory?.summary ?? c.chapter.summary).trim() || '（没有梗概）' })),
          payoffs,
          ...(request.bookVolumes !== undefined && { bookVolumes: request.bookVolumes }),
          ...(request.laterVolumes !== undefined && { laterVolumes: request.laterVolumes }),
        },
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
     * 采用这一卷的章节计划草稿：在这一卷的末尾新建草稿里的各章并写上计划（伏笔与人物同 applyPlanDraft），已有的章节不动。
     */
    async applyVolumeDraft(draft: PlanDraft, volumeId: string): Promise<Result<AppliedDraft, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const chapters = await listChapters(port, 'normal');
      if (!chapters.ok) return err(repo(chapters.error));
      let after: string | null = chapters.value.filter((c) => c.volumeId === volumeId).at(-1)?.id ?? null;
      const created: { readonly id: string; readonly version: number }[] = [];
      // 章节建了、计划没写成（例如作者同时改了某条伏笔）：新建的章节都还没有正文，移入回收站，再采用时不会多出一套章。
      const undo = async () => {
        for (const c of created) await trashChapter(port, c.id, c.version, ctx());
      };
      for (const planned of draft.chapters) {
        const made = await createChapter(port, { id: deps.ids.next(), title: planned.title.trim() || '未命名章节', volumeId, ...(after !== null && { after }) }, ctx());
        if (!made.ok) {
          await undo();
          return err(repo(made.error));
        }
        created.push({ id: made.value.id, version: made.value.version });
        after = made.value.id;
      }
      const written = await writeDraftPlans(
        port,
        draft,
        created.map((c) => c.id),
      );
      if (!written.ok) {
        await undo();
        return written;
      }
      const result = await view(port);
      return result.ok ? ok({ view: result.value, unmatchedCast: written.value }) : result;
    },

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
        volumeMode: request.volumeMode ?? 'auto',
        ...(request.volumeMode === 'fixed' &&
          request.volumeCount !== null &&
          request.volumeCount !== undefined && { volumeCount: request.volumeCount, volumeChapters: Math.ceil(request.chapterCount / request.volumeCount) }),
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

      const written = await writeDraftPlans(port, draft, ids);
      if (!written.ok) return written;
      const result = await view(port);
      return result.ok ? ok({ view: result.value, unmatchedCast: written.value }) : result;
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

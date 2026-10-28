// 一章的写作材料（需求 B59；B39 补充）：写手与按章节计划建推演场景共用，两边看到的是同一份作品。
// 本章的目标、情节点与详略，出场人物（设定、最近的状态、各自知道的事、最近几章在不在场），本章成立的人物关系，
// 适用于本章的世界事实，前文梗概，伏笔与上一章留下的事，本章提到的地点。不读正文（上一章的结尾由写手自己取）。
import { createEntityMatcher } from '@fudiao/editor';
import { err, ok, type Result } from '@fudiao/shared';
import {
  getProject,
  listCastAppearances,
  listChapterMemories,
  listChapterPlans,
  listChaptersWithText,
  listEntities,
  listFacts,
  listForeshadows,
  listRelationships,
  listVolumes,
  type Chapter,
  type ChapterPlan,
  type FactKind,
  type FactModality,
  type RepoError,
  type SqlPort,
} from '@fudiao/store';
import { effectiveAvoidPhrases, factApplies, foreshadowsForChapter, knowledgeForCast, relationsForCast } from '@fudiao/writing';
import type { AppError } from './errors';

/** 前文梗概最多带多少字，超出时先去掉最远的章节。 */
export const MEMORY_CHARS = 6000;
/** 世界事实最多带多少条。 */
export const MAX_FACTS = 30;
/** 人物关系最多这么多条（两端都出场的在前）。 */
export const MAX_RELATIONS = 30;
/** 每个人物最多带几条他知道的事。 */
export const MAX_KNOWS = 8;
/** 每个人物最近出场的章最多列几章。 */
export const PRESENT_CHAPTERS = 3;
/** 每个人物不在场的章最多列几章。 */
export const ABSENT_CHAPTERS = 5;
/** 在场与不在场的章只带梗概的开头多少字。 */
export const MENTION_CHARS = 40;
/** 本章提到的地点最多带几个。 */
export const MAX_LOCATIONS = 6;

const repo = (error: RepoError): AppError => ({ code: 'repo', error });

/** 一个人物知道的一件事：认知或说法，带来源方式与相信程度。 */
export type CastFact = { readonly text: string; readonly kind: Exclude<FactKind, 'world'>; readonly modality: FactModality | null; readonly confidence: number | null };
/** 前面某一章：章名与梗概（可能截短）。 */
export type ChapterMention = { readonly title: string; readonly summary: string };
export type CastMaterial = {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  /** 长篇记忆中这个人物最近一次出场后的状态，没有时为空。 */
  readonly state: string;
  readonly knows: readonly CastFact[];
  /** 最近几章里他在场的章（从远到近）。 */
  readonly present: readonly ChapterMention[];
  /** 最近几章里他不在场、前文没写他得知的章（从远到近）。 */
  readonly absent: readonly ChapterMention[];
};
export type RelationMaterial = { readonly from: string; readonly to: string; readonly label: string; readonly mutual: boolean; readonly description: string; readonly secret: boolean };

export type ChapterMaterials = {
  readonly title: string;
  readonly genre: string;
  readonly chapterTitle: string;
  readonly volume: { readonly title: string; readonly summary: string } | null;
  readonly goal: string;
  readonly beats: readonly string[];
  readonly treatment: string;
  readonly avoidPhrases: readonly string[];
  readonly cast: readonly CastMaterial[];
  readonly relations: readonly RelationMaterial[];
  /** 适用于本章、涉及出场人物的世界事实；人物的认知与说法在各人物的 knows 里。 */
  readonly worldFacts: readonly string[];
  /** 前面章节的梗概，从远到近。 */
  readonly memories: readonly ChapterMention[];
  readonly toPlant: readonly { readonly title: string; readonly content: string }[];
  readonly toPayoff: readonly { readonly title: string; readonly content: string; readonly reveal: string; readonly progress: readonly string[] }[];
  readonly mustNotReveal: readonly string[];
  readonly openThreads: readonly string[];
  /** 本章计划里提到的地点设定。 */
  readonly locations: readonly { readonly name: string; readonly description: string }[];
};

const clip = (text: string) => (text.length <= MENTION_CHARS ? text : `${text.slice(0, MENTION_CHARS)}……`);

/**
 * 收集一章的材料。unfinished：这一章此刻是不是写到一半（写手正在写）；前面还没写完的章用计划顶上梗概。
 */
export async function gatherChapterMaterials(
  port: SqlPort,
  { chapter, chapters, plan, unfinished }: { readonly chapter: Chapter; readonly chapters: readonly Chapter[]; readonly plan: ChapterPlan; readonly unfinished: (chapterId: string) => boolean },
): Promise<Result<ChapterMaterials, AppError>> {
  const [work, entities, facts, foreshadows, memories, withText, volumes, relations, plans, appearances] = await Promise.all([
    getProject(port),
    listEntities(port),
    listFacts(port),
    listForeshadows(port),
    listChapterMemories(port),
    listChaptersWithText(port),
    listVolumes(port),
    listRelationships(port),
    listChapterPlans(port),
    listCastAppearances(port),
  ]);
  if (!work.ok) return err(repo(work.error));
  if (!entities.ok) return err(repo(entities.error));
  if (!facts.ok) return err(repo(facts.error));
  if (!foreshadows.ok) return err(repo(foreshadows.error));
  if (!memories.ok) return err(repo(memories.error));
  if (!withText.ok) return err(repo(withText.error));
  if (!volumes.ok) return err(repo(volumes.error));
  if (!relations.ok) return err(repo(relations.error));
  if (!plans.ok) return err(repo(plans.error));
  if (!appearances.ok) return err(repo(appearances.error));
  const volume = volumes.value.find((v) => v.id === chapter.volumeId);

  const order = new Map(chapters.map((c, i) => [c.id, i]));
  const index = order.get(chapter.id) ?? 0;
  const cast = entities.value.filter((e) => plan.castIds.includes(e.id));
  const castIds = new Set(cast.map((c) => c.id));
  const nameOf = new Map(entities.value.map((e) => [e.id, e.name]));
  const fs = foreshadowsForChapter(plan, foreshadows.value, order);

  // 前文梗概：优先用长篇记忆（待复核的也用，它仍是最接近正文的梗概），没有时用作者写的章节梗概；从近到远选入，超出预算时去掉最远的。
  // 正文已经清空（例如回退之后）的章节，留下的记忆不再对应任何正文，不用。
  const hasText = new Set(withText.value);
  const memoryOf = new Map(memories.value.filter((m) => hasText.has(m.chapterId)).map((m) => [m.chapterId, m]));
  const earlier: ChapterMention[] = [];
  let used = 0;
  // 前面还没写、正在写或还没整理记忆的章节（例如作者跳着写）：用它的章节计划顶上，至少知道那里要发生什么。
  const planOf = new Map(plans.value.map((p) => [p.chapterId, p]));
  const planned = (c: Chapter) => {
    const goal = planOf.get(c.id)?.goal.trim() ?? '';
    if (goal === '') return '';
    return `（${!hasText.has(c.id) ? '还没写，' : unfinished(c.id) ? '还没写完，' : ''}按计划）${goal}`;
  };
  for (const c of chapters.slice(0, index).reverse()) {
    const summary = (memoryOf.get(c.id)?.summary ?? c.summary).trim() || planned(c);
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

  // 各人物知道的（以他为持有者的认知与说法）与最近几章在不在场：只看已写、有长篇记忆的章。
  const knowledge = knowledgeForCast({ castIds: [...castIds], index, order, appearances: appearances.value, written: new Set(memoryOf.keys()), facts: facts.value });
  const mention = (i: number): ChapterMention | null => {
    const c = chapters[i];
    const summary = c === undefined ? '' : (memoryOf.get(c.id)?.summary.trim() ?? '');
    return c === undefined || summary === '' ? null : { title: c.title, summary: clip(summary) };
  };
  const mentions = (indexes: readonly number[], limit: number) => indexes.slice(-limit).flatMap((i) => mention(i) ?? []);

  const previous = chapters[index - 1];
  const openThreads = previous === undefined ? [] : (memoryOf.get(previous.id)?.openThreads ?? []);

  // 本章计划里提到的地点设定（按名字与别名匹配）。
  const matcher = createEntityMatcher(entities.value.filter((e) => e.kind === 'location').map((e) => ({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases })));
  const locationIds = [...new Set(matcher.find([plan.goal, ...plan.beats, plan.treatment, ...openThreads].join('\n')).map((m) => m.entityId))].slice(0, MAX_LOCATIONS);
  const locations = locationIds.flatMap((id) => {
    const e = entities.value.find((x) => x.id === id);
    return e === undefined ? [] : [{ name: e.name, description: e.description }];
  });

  return ok({
    title: work.value?.title ?? '',
    genre: work.value?.genre ?? '',
    chapterTitle: chapter.title,
    volume: volume === undefined ? null : { title: volume.title, summary: volume.summary },
    goal: plan.goal,
    beats: plan.beats,
    treatment: plan.treatment,
    avoidPhrases: effectiveAvoidPhrases(work.value?.avoidPhrases ?? null),
    cast: cast.map((c) => {
      const k = knowledge.get(c.id);
      return {
        id: c.id,
        name: c.name,
        aliases: c.aliases,
        description: c.description,
        state: stateOf.get(c.id) ?? '',
        knows: (k?.knows ?? []).slice(0, MAX_KNOWS).map((f) => ({ text: f.content, kind: f.kind === 'claim' ? ('claim' as const) : ('belief' as const), modality: f.modality, confidence: f.confidence })),
        present: mentions(k?.present ?? [], PRESENT_CHAPTERS),
        absent: mentions(k?.absent ?? [], ABSENT_CHAPTERS),
      };
    }),
    // 人物关系网（B73）：本章成立、至少一端出场的关系。
    relations: relationsForCast(relations.value, castIds, index, order, MAX_RELATIONS).map((r) => ({
      from: nameOf.get(r.fromId) ?? '',
      to: nameOf.get(r.toId) ?? '',
      label: r.label,
      mutual: r.mutual,
      description: r.description,
      secret: r.secret,
    })),
    // 只用适用于本章的事实（与上下文、审核相同）：后面章节才成立的事、已经不再成立的事都不给。
    worldFacts: facts.value
      .filter((f) => f.status === 'confirmed' && f.kind === 'world' && factApplies(f, index, order) && f.subjectIds.some((id) => castIds.has(id)))
      .slice(0, MAX_FACTS)
      .map((f) => f.content),
    memories: earlier,
    toPlant: fs.toPlant.map((f) => ({ title: f.title, content: f.content })),
    toPayoff: fs.toPayoff.map((f) => ({ title: f.title, content: f.content, reveal: f.reveal, progress: progressOf.get(f.id) ?? [] })),
    mustNotReveal: fs.mustNotReveal.map((f) => f.reveal.trim()),
    // 上一章结尾留下的事（B74）：上一章的长篇记忆里有就带上。
    openThreads,
    locations,
  });
}

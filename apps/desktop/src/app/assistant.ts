// AI 助手（需求 B69，施工文档 M5-01）：对话框里用作者配置的默认模型驱动，理解作者的意图并操作这个软件。
// 每一步模型输出“给作者的话 + 要执行的动作”（结构化输出管线校验，见 packages/prompts 的 AssistantTurnOutput），
// 动作经下面的工具执行——工具只调用现有的用例，锁定设定、快照、版本守卫与回收站照常生效。
// 删除与覆盖类的动作须作者在对话框里确认后才执行。对话按作品保存（迁移 0011）；没有打开作品时只在内存里，
// 助手新建或打开作品后，这一轮对话随之存进那部作品。
import {
  AssistantTurnOutput,
  renderAssistantTurn,
  type AssistantAction,
  type AssistantHistoryItem,
  type AssistantResult,
  type AssistantState,
  type PlanDraftData,
} from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  appendAssistantMessages,
  chapterLengths,
  clearAssistantMessages,
  listAssistantMessages,
  listChapterPlans,
  type Chapter,
  type ChapterTarget,
  type Entity,
  type EntityKind,
  type EntityPatch,
  type Fact,
  type FactInput,
  type FactStatus,
  type PlanFields,
  type ProjectPatch,
  type SearchResult,
  type SqlPort,
  type Volume,
} from '@fudiao/store';
import { partialStringField, type CallOptions, type LlmStreamEvent } from '@fudiao/llm';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppliedDraft, PlanningView } from './planning';
import type { AppDeps } from './ports';
import type { SelectionOperation } from '@fudiao/prompts';
import type { ContextOverrides } from '@fudiao/context';
import type { EditorSelection } from './writing-context';
import type { WriterEvents, WriterOutcome } from './writer';
import type { ReviewOutcome } from './review';
import type { ForeshadowFields } from '@fudiao/store';

/** 对话中的一条：作者的话、助手一步的输出、动作的结果，或等待作者确认的动作。 */
export type AssistantItem =
  | { readonly id: string; readonly role: 'user'; readonly text: string }
  | { readonly id: string; readonly role: 'assistant'; readonly output: AssistantTurnOutput }
  | { readonly id: string; readonly role: 'results'; readonly results: readonly AssistantResult[] }
  | { readonly id: string; readonly role: 'pending'; readonly action: AssistantAction; readonly summary: string };

/** 助手要界面做的事：打开章节或页面；打开一章旁的候选稿或审核问题；作品换了（新建或打开了另一部）；作品内容变了。 */
export type AssistantEffect =
  | { readonly kind: 'open_chapter'; readonly chapterId: string }
  | { readonly kind: 'show_candidates'; readonly chapterId: string }
  | { readonly kind: 'show_review'; readonly chapterId: string }
  | { readonly kind: 'chapter_changed'; readonly chapterId: string }
  | { readonly kind: 'open_page'; readonly page: Extract<AssistantAction, { tool: 'open_page' }>['page'] }
  | { readonly kind: 'work_opened' }
  | { readonly kind: 'changed' };

/** 作者发话时在正文里选中的文字（edit_selection 的对象）。 */
export type AssistantSelection = { readonly chapterId: string; readonly range: EditorSelection; readonly text: string };

export type AssistantEvents = CallOptions & {
  /** 对话每多一条时调用（界面据此逐步显示进展）。 */
  readonly onUpdate?: (items: readonly AssistantItem[]) => void;
  readonly onEffect?: (effect: AssistantEffect) => void;
  /** 模型正在输出的这一步里，给作者的话已经到达的部分（逐字显示）；这一步结束时为 null。 */
  readonly onDraft?: (message: string | null) => void;
  /** 正在执行的耗时动作（写手写章、生成计划、审核等）的进展；动作做完时为 null。 */
  readonly onProgress?: (note: string | null) => void;
  /** 作者此刻在看什么（章节或页面），写进给模型的现状。 */
  readonly current?: () => string;
  /** 作者选中的文字；没有选中时为 null。 */
  readonly selection?: AssistantSelection | null;
};

/** 一轮对话的结果：最新的对话，以及是否停在等待作者确认。 */
export type AssistantOutcome = { readonly items: readonly AssistantItem[]; readonly pending: boolean };

/** 助手用到的现有用例（由应用服务提供）。 */
export type AssistantHost = {
  loadLibrary(): Promise<Result<{ readonly works: readonly { readonly id: string; readonly title: string; readonly archived: boolean; readonly missing: boolean }[] }, AppError>>;
  createWork(title: string): Promise<Result<unknown, AppError>>;
  openWork(id: string): Promise<Result<unknown, AppError>>;
  reloadWork(): Promise<
    Result<{ readonly project: { readonly title: string; readonly genre: string; readonly synopsis: string; readonly outline: string }; readonly chapters: readonly Chapter[]; readonly trashed: readonly Chapter[]; readonly volumes: readonly Volume[] }, AppError>
  >;
  updateWorkInfo(patch: ProjectPatch): Promise<Result<unknown, AppError>>;
  createVolume(title: string, after?: string): Promise<Result<{ readonly volumes: readonly Volume[] }, AppError>>;
  updateVolume(volume: Volume, fields: { readonly title: string; readonly summary: string }): Promise<Result<unknown, AppError>>;
  moveVolume(volume: Volume, after: string | null): Promise<Result<unknown, AppError>>;
  deleteVolume(volume: Volume): Promise<Result<unknown, AppError>>;
  createChapter(title: string, after?: string, volumeId?: string | null): Promise<Result<{ readonly chapters: readonly Chapter[] }, AppError>>;
  renameChapter(chapter: Chapter, title: string): Promise<Result<unknown, AppError>>;
  updateChapterNotes(chapter: Chapter, notes: { readonly summary: string; readonly notes: string }): Promise<Result<unknown, AppError>>;
  moveChapter(chapter: Chapter, target: ChapterTarget): Promise<Result<unknown, AppError>>;
  trashChapter(chapter: Chapter): Promise<Result<unknown, AppError>>;
  restoreChapter(chapter: Chapter): Promise<Result<unknown, AppError>>;
  createSnapshot(chapterId: string): Promise<Result<unknown, AppError>>;
  openChapter(chapterId: string): Promise<Result<{ readonly saved: readonly { readonly id: string; readonly text: string }[] }, AppError>>;
  search(query: string): Promise<Result<SearchResult, AppError>>;
  listEntities(): Promise<Result<Entity[], AppError>>;
  createEntity(kind: EntityKind, name: string): Promise<Result<{ readonly created: Entity }, AppError>>;
  updateEntity(entity: Entity, patch: EntityPatch): Promise<Result<unknown, AppError>>;
  deleteEntity(entity: Entity): Promise<Result<unknown, AppError>>;
  listFacts(): Promise<Result<Fact[], AppError>>;
  createFact(input: FactInput, status: FactStatus): Promise<Result<unknown, AppError>>;
  planningView(): Promise<Result<PlanningView, AppError>>;
  savePlan(chapterId: string, fields: PlanFields): Promise<Result<unknown, AppError>>;
  draftPlans(request: { readonly chapterCount: number; readonly wordsPerChapter: number }, options?: CallOptions): Promise<Result<PlanDraftData, AppError>>;
  applyPlanDraft(draft: PlanDraftData): Promise<Result<AppliedDraft, AppError>>;
  writeChapter(chapterId: string, events?: WriterEvents): Promise<Result<WriterOutcome, AppError>>;
  rollbackWriter(chapterId: string): Promise<Result<unknown, AppError>>;
  reviewChapter(chapterId: string, options?: CallOptions): Promise<Result<ReviewOutcome, AppError>>;
  addForeshadow(fields: ForeshadowFields): Promise<Result<unknown, AppError>>;
  exportText(kind: 'txt' | 'md', chapterId?: string): Promise<Result<boolean, AppError>>;
  runSelectionOperation(
    request: { readonly chapterId: string; readonly selection: EditorSelection | null; readonly operation: SelectionOperation; readonly instruction: string; readonly overrides: ContextOverrides },
    options?: CallOptions,
  ): Promise<Result<{ readonly candidate: { readonly id: string } | null }, AppError>>;
};

/** 一轮请求中模型最多走几步（每步一次调用），防止来回打转。 */
export const MAX_ASSISTANT_STEPS = 8;
/** 给模型的对话最多带最近这么多条（从作者的一句话开始）。 */
const HISTORY_LIMIT = 60;
/** 现状中最多列出的章节与设定。 */
const MAX_LISTED_CHAPTERS = 120;
const MAX_LISTED_ENTITIES = 200;
/** 读一章时最多给出的字数：太长时给开头与结尾。 */
const READ_LIMIT = 6_000;
/** 现状中作者选中的文字最多给出的字数：太长时给开头与结尾。 */
const SELECTION_LIMIT = 2_000;
/** 审核结果在对话里列出的问题数。 */
const LISTED_ISSUES = 6;
export const ASSISTANT_OUTPUT_TOKENS = 6_000 + THINKING_ALLOWANCE;

const KIND_LABEL: Readonly<Record<EntityKind, string>> = { character: '人物', location: '地点', organization: '组织', item: '物品', rule: '世界规则' };
const PLAN_LABEL = { todo: '待写', writing: '写作中', written: '已写', reviewed: '已审核' } as const;
const SEVERITY_LABEL = { high: '严重', medium: '一般', low: '轻微' } as const;
const EDIT_LABEL = { rewrite: '改写', expand: '扩写', shorten: '缩写', polish: '润色' } as const;
const UNVOLUMED = '未分卷';

const settings = (detail: string): AppError => ({ code: 'settings', detail });

type Outcome = { readonly ok: boolean; readonly detail: string };
const done = (detail: string): Outcome => ({ ok: true, detail });
const failed = (detail: string): Outcome => ({ ok: false, detail });

/** 按标识或名称找一项：标识相同、名称相同、名称包含（只有一项时）；找不到或有几项对得上时说明。 */
function pick<T extends { readonly id: string }>(items: readonly T[], ref: string, names: (t: T) => readonly string[], what: string): Result<T, string> {
  const key = ref.trim();
  const byId = items.find((t) => t.id === key);
  if (byId !== undefined) return ok(byId);
  const exact = items.filter((t) => names(t).some((n) => n.trim() === key));
  if (exact.length === 1) return ok(exact[0]!);
  const loose = exact.length > 1 ? exact : items.filter((t) => names(t).some((n) => n.includes(key) || (key.length >= 2 && key.includes(n.trim()) && n.trim().length >= 2)));
  if (loose.length === 1) return ok(loose[0]!);
  if (loose.length === 0) return err(`找不到${what}“${key}”`);
  return err(`有几个${what}都对得上“${key}”：${loose.slice(0, 6).map((t) => `${names(t)[0] ?? ''}[${t.id}]`).join('、')}，请用标识指明`);
}

const describeError = (e: AppError): string => {
  if (e.code === 'settings') return e.detail;
  if (e.code === 'repo') {
    const r = e.error;
    if (r.code === 'locked') return '这是锁定设定，作者解锁后才能修改或删除';
    if (r.code === 'invalid') return r.detail;
    if (r.code === 'conflict') return '已在别处修改，请重试';
    if (r.code === 'in_use') return '还有事实、章节计划或故事事件用到它，不能删除';
    if (r.code === 'not_found') return '找不到这一项';
    return '保存失败';
  }
  if (e.code === 'no_work') return '还没有打开作品：先新建或打开一部作品';
  return e.code;
};

/** 需要作者确认的动作：删除与覆盖。plan_chapters 只在作品已有章节计划时需要（会覆盖它们）。 */
function needsConfirm(action: AssistantAction, hasPlans: boolean): boolean {
  return action.tool === 'delete_volume' || action.tool === 'trash_chapter' || action.tool === 'delete_entity' || action.tool === 'rollback_writer' || (action.tool === 'plan_chapters' && hasPlans);
}

/** 太长的文字只留开头与结尾。 */
const clip = (text: string, limit: number): { readonly text: string; readonly clipped: boolean } =>
  text.length <= limit ? { text, clipped: false } : { text: `${text.slice(0, limit / 2)}\n……\n${text.slice(-limit / 2)}`, clipped: true };

export function assistantUseCases({
  deps,
  host,
  project,
  runner,
}: {
  readonly deps: AppDeps;
  readonly host: AssistantHost;
  readonly project: () => SqlPort | null;
  readonly runner: ReturnType<typeof modelRunner>;
}) {
  const ctx = () => ({ now: deps.clock.now() });
  /** 没有打开作品时的对话。 */
  let memory: AssistantItem[] = [];
  /** 正在进行的一轮：取消用。 */
  let running = false;

  async function load(): Promise<Result<AssistantItem[], AppError>> {
    const port = project();
    if (port === null) return ok([...memory]);
    const rows = await listAssistantMessages(port);
    if (!rows.ok) return err({ code: 'repo', error: rows.error });
    return ok(rows.value.flatMap((r): AssistantItem[] => fromStored(r.id, r.role, r.payload)));
  }

  /** 追加并保存；作品没有打开时只在内存里。 */
  async function append(items: AssistantItem[], added: readonly AssistantItem[], events: AssistantEvents): Promise<void> {
    items.push(...added);
    const port = project();
    if (port === null) memory = [...items];
    else await appendAssistantMessages(port, added.map((a) => ({ id: a.id, role: a.role, payload: toStored(a) })), ctx());
    events.onUpdate?.([...items]);
  }

  // —— 现状 ——

  async function state(events: AssistantEvents): Promise<AssistantState> {
    const current = events.current?.() ?? '';
    const library = await host.loadLibrary();
    const works = library.ok ? library.value.works.filter((w) => !w.archived && !w.missing).map((w) => w.title) : [];
    const port = project();
    if (port === null) return { works, work: null };
    const work = await host.reloadWork();
    if (!work.ok) return { works, work: null };
    const [entities, plans, lengths] = await Promise.all([host.listEntities(), listChapterPlans(port), chapterLengths(port)]);
    const planOf = new Map(plans.ok ? plans.value.map((p) => [p.chapterId, PLAN_LABEL[p.status]]) : []);
    const lengthOf = new Map(lengths.ok ? lengths.value.map((l) => [l.chapterId, l.length]) : []);
    const volumeTitle = new Map(work.value.volumes.map((v) => [v.id, v.title]));
    const all = work.value.chapters.map((c) => ({ id: c.id, title: c.title, volume: c.volumeId === null ? '' : (volumeTitle.get(c.volumeId) ?? ''), words: lengthOf.get(c.id) ?? 0, plan: planOf.get(c.id) ?? '' }));
    const omitted = all.length > MAX_LISTED_CHAPTERS;
    const chapters = omitted ? [...all.slice(0, 40), ...all.slice(-(MAX_LISTED_CHAPTERS - 40))] : all;
    const p = work.value.project;
    const chosen = events.selection ?? null;
    const chosenChapter = chosen === null ? undefined : work.value.chapters.find((c) => c.id === chosen.chapterId);
    let selection: NonNullable<AssistantState['work']>['selection'] = null;
    if (chosen !== null && chosenChapter !== undefined && chosen.text.trim() !== '') {
      selection = { chapter: chosenChapter.title, length: chosen.text.length, ...clip(chosen.text, SELECTION_LIMIT) };
    }
    return {
      works,
      work: {
        trashed: work.value.trashed.slice(0, 30).map((c) => ({ id: c.id, title: c.title })),
        selection,
        title: p.title,
        genre: p.genre,
        synopsis: p.synopsis,
        outline: p.outline,
        volumes: work.value.volumes.map((v) => ({ id: v.id, title: v.title, summary: v.summary })),
        chapters,
        chapterCount: all.length,
        omitted,
        entities: (entities.ok ? entities.value : []).slice(0, MAX_LISTED_ENTITIES).map((e) => ({ id: e.id, kind: KIND_LABEL[e.kind], name: e.name, locked: e.locked })),
        current,
      },
    };
  }

  // —— 工具 ——

  async function chapters() {
    const work = await host.reloadWork();
    return work.ok ? ok(work.value) : work;
  }

  async function findChapter(ref: string): Promise<Result<Chapter, string>> {
    const work = await chapters();
    if (!work.ok) return err(describeError(work.error));
    return pick(work.value.chapters, ref, (c) => [c.title], '章节');
  }

  async function findVolume(ref: string): Promise<Result<Volume, string>> {
    const work = await chapters();
    if (!work.ok) return err(describeError(work.error));
    return pick(work.value.volumes, ref, (v) => [v.title], '卷');
  }

  async function findEntity(ref: string): Promise<Result<Entity, string>> {
    const list = await host.listEntities();
    if (!list.ok) return err(describeError(list.error));
    return pick(list.value, ref, (e) => [e.name, ...e.aliases], '设定');
  }

  const changed = (events: AssistantEvents) => events.onEffect?.({ kind: 'changed' });
  const fail = (e: AppError) => failed(describeError(e));

  async function execute(action: AssistantAction, events: AssistantEvents): Promise<Outcome> {
    switch (action.tool) {
      case 'list_chapters': {
        const work = await chapters();
        if (!work.ok) return fail(work.error);
        const port = project();
        const lengths = port === null ? null : await chapterLengths(port);
        const lengthOf = new Map(lengths?.ok === true ? lengths.value.map((l) => [l.chapterId, l.length]) : []);
        let list = work.value.chapters;
        if (action.volume !== null) {
          if (action.volume.trim() === UNVOLUMED) list = list.filter((c) => c.volumeId === null);
          else {
            const v = pick(work.value.volumes, action.volume, (x) => [x.title], '卷');
            if (!v.ok) return failed(v.error);
            list = list.filter((c) => c.volumeId === v.value.id);
          }
        }
        const title = new Map(work.value.volumes.map((v) => [v.id, v.title]));
        return done(list.length === 0 ? '没有章节。' : list.map((c) => `[${c.id}] ${c.title}${c.volumeId === null ? '' : `（${title.get(c.volumeId) ?? ''}）`}，${lengthOf.get(c.id) ?? 0} 字`).join('\n'));
      }
      case 'read_chapter': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        const content = await host.openChapter(c.value.id);
        if (!content.ok) return fail(content.error);
        const text = content.value.saved.map((p) => p.text).join('\n');
        if (text.trim() === '') return done(`《${c.value.title}》还没有正文。`);
        const shown = text.length <= READ_LIMIT ? text : `${text.slice(0, READ_LIMIT / 2)}\n……（中间省略 ${text.length - READ_LIMIT} 字）……\n${text.slice(-READ_LIMIT / 2)}`;
        return done(`《${c.value.title}》正文：\n${shown}`);
      }
      case 'search_text': {
        const result = await host.search(action.query);
        if (!result.ok) return fail(result.error);
        const hits = result.value.hits.slice(0, 20);
        if (hits.length === 0) return done(`没有找到“${action.query}”。`);
        return done(`${result.value.hits.length} 处${result.value.truncated ? '以上' : ''}：\n${hits.map((h) => `[${h.chapterId}] ${h.chapterTitle}：…${h.before}【${h.match}】${h.after}…`).join('\n')}`);
      }
      case 'get_entity': {
        const e = await findEntity(action.entity);
        if (!e.ok) return failed(e.error);
        const x = e.value;
        const attributes = x.attributes.map((a) => `${a.label}：${a.value}`).join('；');
        return done(`[${x.id}] ${KIND_LABEL[x.kind]}：${x.name}${x.aliases.length > 0 ? `（别名：${x.aliases.join('、')}）` : ''}${x.locked ? '（锁定）' : ''}\n说明：${x.description || '无'}${attributes === '' ? '' : `\n属性：${attributes}`}`);
      }
      case 'list_facts': {
        const facts = await host.listFacts();
        if (!facts.ok) return fail(facts.error);
        let list = facts.value;
        if (action.about !== null) {
          const e = await findEntity(action.about);
          if (!e.ok) return failed(e.error);
          list = list.filter((f) => f.subjectIds.includes(e.value.id) || f.holderId === e.value.id);
        }
        const status = { candidate: '候选', confirmed: '已确认', needs_review: '待复核', rejected: '已驳回' } as const;
        return done(list.length === 0 ? '没有事实记录。' : list.slice(0, 50).map((f) => `[${f.id}] ${f.content}（${status[f.status]}）`).join('\n'));
      }
      case 'get_chapter_plan': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        const view = await host.planningView();
        if (!view.ok) return fail(view.error);
        const plan = view.value.chapters.find((x) => x.chapter.id === c.value.id)?.plan ?? null;
        if (plan === null) return done(`《${c.value.title}》还没有章节计划。`);
        const entities = await host.listEntities();
        const name = new Map(entities.ok ? entities.value.map((e) => [e.id, e.name]) : []);
        return done(
          `《${c.value.title}》（${PLAN_LABEL[plan.status]}）\n目标：${plan.goal}\n情节点：${plan.beats.join('；')}\n出场人物：${plan.castIds.map((id) => name.get(id) ?? id).join('、') || '无'}\n字数：${plan.targetWords ?? '未定'}`,
        );
      }
      case 'create_work': {
        const created = await host.createWork(action.title);
        if (!created.ok) return fail(created.error);
        const patch: { -readonly [K in keyof ProjectPatch]: ProjectPatch[K] } = {};
        if (action.genre !== null) patch.genre = action.genre;
        if (action.synopsis !== null) patch.synopsis = action.synopsis;
        if (action.outline !== null) patch.outline = action.outline;
        if (Object.keys(patch).length > 0) {
          const info = await host.updateWorkInfo(patch);
          if (!info.ok) return fail(info.error);
        }
        events.onEffect?.({ kind: 'work_opened' });
        return done(`已新建并打开《${action.title.trim()}》。`);
      }
      case 'open_work': {
        const library = await host.loadLibrary();
        if (!library.ok) return fail(library.error);
        const w = pick(
          library.value.works.filter((x) => !x.missing),
          action.work,
          (x) => [x.title],
          '作品',
        );
        if (!w.ok) return failed(w.error);
        const opened = await host.openWork(w.value.id);
        if (!opened.ok) return fail(opened.error);
        events.onEffect?.({ kind: 'work_opened' });
        return done(`已打开《${w.value.title}》。`);
      }
      case 'update_work': {
        const patch: { -readonly [K in keyof ProjectPatch]: ProjectPatch[K] } = {};
        if (action.title !== null) patch.title = action.title;
        if (action.genre !== null) patch.genre = action.genre;
        if (action.synopsis !== null) patch.synopsis = action.synopsis;
        if (action.outline !== null) patch.outline = action.outline;
        if (Object.keys(patch).length === 0) return failed('没有要改的内容');
        const info = await host.updateWorkInfo(patch);
        if (!info.ok) return fail(info.error);
        changed(events);
        return done(`已修改作品信息：${Object.keys(patch).map((k) => ({ title: '作品名', genre: '类型', synopsis: '简介', outline: '大纲' })[k] ?? k).join('、')}。`);
      }
      case 'create_volume': {
        let after: string | undefined;
        if (action.after !== null) {
          const v = await findVolume(action.after);
          if (!v.ok) return failed(v.error);
          after = v.value.id;
        }
        const before = await chapters();
        const known = new Set(before.ok ? before.value.volumes.map((v) => v.id) : []);
        const created = await host.createVolume(action.title, after);
        if (!created.ok) return fail(created.error);
        const volume = created.value.volumes.find((v) => !known.has(v.id));
        if (volume !== undefined && action.summary !== null && action.summary.trim() !== '') {
          const described = await host.updateVolume(volume, { title: volume.title, summary: action.summary });
          if (!described.ok) return fail(described.error);
        }
        changed(events);
        return done(`已新建卷“${action.title.trim()}”${volume === undefined ? '' : `[${volume.id}]`}。`);
      }
      case 'update_volume': {
        const v = await findVolume(action.volume);
        if (!v.ok) return failed(v.error);
        const updated = await host.updateVolume(v.value, { title: action.title ?? v.value.title, summary: action.summary ?? v.value.summary });
        if (!updated.ok) return fail(updated.error);
        changed(events);
        return done(`已修改卷“${action.title ?? v.value.title}”。`);
      }
      case 'move_volume': {
        const v = await findVolume(action.volume);
        if (!v.ok) return failed(v.error);
        let after: string | null = null;
        if (action.after !== null) {
          const a = await findVolume(action.after);
          if (!a.ok) return failed(a.error);
          after = a.value.id;
        }
        const moved = await host.moveVolume(v.value, after);
        if (!moved.ok) return fail(moved.error);
        changed(events);
        return done(`已调整“${v.value.title}”的顺序。`);
      }
      case 'delete_volume': {
        const v = await findVolume(action.volume);
        if (!v.ok) return failed(v.error);
        const deleted = await host.deleteVolume(v.value);
        if (!deleted.ok) return fail(deleted.error);
        changed(events);
        return done(`已删除卷“${v.value.title}”。`);
      }
      case 'create_chapter': {
        const before = await chapters();
        if (!before.ok) return fail(before.error);
        const known = new Set(before.value.chapters.map((c) => c.id));
        let created;
        if (action.after !== null) {
          const a = pick(before.value.chapters, action.after, (c) => [c.title], '章节');
          if (!a.ok) return failed(a.error);
          created = await host.createChapter(action.title, a.value.id);
        } else if (action.volume !== null) {
          let volumeId: string | null = null;
          if (action.volume.trim() !== UNVOLUMED) {
            const v = pick(before.value.volumes, action.volume, (x) => [x.title], '卷');
            if (!v.ok) return failed(v.error);
            volumeId = v.value.id;
          }
          created = await host.createChapter(action.title, undefined, volumeId);
        } else {
          created = await host.createChapter(action.title);
        }
        if (!created.ok) return fail(created.error);
        const chapter = created.value.chapters.find((c) => !known.has(c.id));
        changed(events);
        return done(`已新建章节《${action.title.trim()}》${chapter === undefined ? '' : `[${chapter.id}]`}。`);
      }
      case 'update_chapter': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        let chapter = c.value;
        if (action.title !== null && action.title.trim() !== chapter.title) {
          const renamed = await host.renameChapter(chapter, action.title);
          if (!renamed.ok) return fail(renamed.error);
          const again = await findChapter(chapter.id);
          if (!again.ok) return failed(again.error);
          chapter = again.value;
        }
        if (action.summary !== null || action.notes !== null) {
          const noted = await host.updateChapterNotes(chapter, { summary: action.summary ?? chapter.summary, notes: action.notes ?? chapter.notes });
          if (!noted.ok) return fail(noted.error);
        }
        changed(events);
        return done(`已修改《${chapter.title}》。`);
      }
      case 'move_chapter': {
        const work = await chapters();
        if (!work.ok) return fail(work.error);
        const c = pick(work.value.chapters, action.chapter, (x) => [x.title], '章节');
        if (!c.ok) return failed(c.error);
        let target: ChapterTarget;
        if (action.after !== null) {
          const a = pick(work.value.chapters, action.after, (x) => [x.title], '章节');
          if (!a.ok) return failed(a.error);
          target = { volumeId: a.value.volumeId, after: a.value.id };
        } else if (action.volume !== null) {
          let volumeId: string | null = null;
          if (action.volume.trim() !== UNVOLUMED) {
            const v = pick(work.value.volumes, action.volume, (x) => [x.title], '卷');
            if (!v.ok) return failed(v.error);
            volumeId = v.value.id;
          }
          const members = work.value.chapters.filter((x) => x.volumeId === volumeId && x.id !== c.value.id);
          target = { volumeId, after: members.at(-1)?.id ?? null };
        } else {
          return failed('请给出 after（移到哪一章之后）或 volume（移到哪一卷）');
        }
        const moved = await host.moveChapter(c.value, target);
        if (!moved.ok) return fail(moved.error);
        changed(events);
        return done(`已移动《${c.value.title}》。`);
      }
      case 'trash_chapter': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        const trashed = await host.trashChapter(c.value);
        if (!trashed.ok) return fail(trashed.error);
        changed(events);
        return done(`已把《${c.value.title}》移入回收站（可以恢复）。`);
      }
      case 'open_chapter': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        events.onEffect?.({ kind: 'open_chapter', chapterId: c.value.id });
        return done(`已打开《${c.value.title}》。`);
      }
      case 'create_entity': {
        const created = await host.createEntity(action.kind, action.name);
        if (!created.ok) return fail(created.error);
        const patch: { -readonly [K in keyof EntityPatch]: EntityPatch[K] } = {};
        if (action.description !== null) patch.description = action.description;
        if (action.aliases !== null) patch.aliases = action.aliases.map((a) => a.trim()).filter((a) => a !== '');
        if (Object.keys(patch).length > 0) {
          const described = await host.updateEntity(created.value.created, patch);
          if (!described.ok) return fail(described.error);
        }
        changed(events);
        return done(`已新建${KIND_LABEL[action.kind]}“${action.name.trim()}”[${created.value.created.id}]。`);
      }
      case 'update_entity': {
        const e = await findEntity(action.entity);
        if (!e.ok) return failed(e.error);
        if (e.value.locked) return failed(`“${e.value.name}”是锁定设定，作者解锁后才能修改`);
        const patch: { -readonly [K in keyof EntityPatch]: EntityPatch[K] } = {};
        if (action.name !== null) patch.name = action.name;
        if (action.description !== null) patch.description = action.description;
        if (action.aliases !== null) patch.aliases = action.aliases.map((a) => a.trim()).filter((a) => a !== '');
        if (Object.keys(patch).length === 0) return failed('没有要改的内容');
        const updated = await host.updateEntity(e.value, patch);
        if (!updated.ok) return fail(updated.error);
        changed(events);
        return done(`已修改“${action.name ?? e.value.name}”。`);
      }
      case 'delete_entity': {
        const e = await findEntity(action.entity);
        if (!e.ok) return failed(e.error);
        const deleted = await host.deleteEntity(e.value);
        if (!deleted.ok) return fail(deleted.error);
        changed(events);
        return done(`已删除“${e.value.name}”。`);
      }
      case 'add_fact': {
        let holderId: string | null = null;
        if (action.kind === 'belief') {
          if (action.holder === null) return failed('人物认知须给出持有人（holder）');
          const h = await findEntity(action.holder);
          if (!h.ok) return failed(h.error);
          holderId = h.value.id;
        }
        const subjectIds: string[] = [];
        const missing: string[] = [];
        for (const s of action.subjects ?? []) {
          const e = await findEntity(s);
          if (e.ok) subjectIds.push(e.value.id);
          else missing.push(s);
        }
        const input: FactInput = {
          kind: action.kind,
          holderId,
          subjectIds,
          content: action.content,
          modality: action.kind === 'belief' ? 'inferred' : null,
          confidence: null,
          validFromChapterId: null,
          validToChapterId: null,
          validFrom: null,
          validTo: null,
          basis: [],
        };
        // 助手记下的事实是候选，作者在事实页确认后才算数（硬性规则 21）。
        const created = await host.createFact(input, 'candidate');
        if (!created.ok) return fail(created.error);
        changed(events);
        return done(`已记为候选事实，等作者在“事实”页确认${missing.length > 0 ? `；这些设定没有找到，没有关联：${missing.join('、')}` : ''}。`);
      }
      case 'save_chapter_plan': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        const view = await host.planningView();
        if (!view.ok) return fail(view.error);
        const current = view.value.chapters.find((x) => x.chapter.id === c.value.id)?.plan ?? null;
        const entities = await host.listEntities();
        const characters = entities.ok ? entities.value.filter((e) => e.kind === 'character') : [];
        const unmatched: string[] = [];
        const castIds = (action.cast ?? []).flatMap((n) => {
          const e = pick(characters, n, (x) => [x.name, ...x.aliases], '人物');
          if (!e.ok) unmatched.push(n);
          return e.ok ? [e.value.id] : [];
        });
        const saved = await host.savePlan(c.value.id, {
          goal: action.goal,
          castIds: action.cast === null ? (current?.castIds ?? []) : [...new Set(castIds)],
          beats: action.beats.map((b) => b.trim()).filter((b) => b !== ''),
          foreshadowPlant: current?.foreshadowPlant ?? [],
          foreshadowPayoff: current?.foreshadowPayoff ?? [],
          treatment: current?.treatment ?? '',
          targetWords: action.targetWords ?? current?.targetWords ?? null,
        });
        if (!saved.ok) return fail(saved.error);
        changed(events);
        return done(`已保存《${c.value.title}》的章节计划${unmatched.length > 0 ? `；这些人物还没有人物卡片，没有加入出场人物：${unmatched.join('、')}` : ''}。`);
      }
      case 'plan_chapters': {
        events.onProgress?.(`正在按大纲生成 ${action.count} 章的章节计划`);
        const draft = await host.draftPlans({ chapterCount: action.count, wordsPerChapter: action.wordsPerChapter ?? 3000 }, withSignal(events));
        if (!draft.ok) return fail(draft.error);
        const applied = await host.applyPlanDraft(draft.value);
        if (!applied.ok) return fail(applied.error);
        changed(events);
        const volumes = new Set(draft.value.chapters.map((c) => (c.volume ?? '').trim()).filter((v) => v !== '')).size;
        return done(
          `已生成并采用 ${draft.value.chapters.length} 章的计划${volumes > 0 ? `，分 ${volumes} 卷` : ''}${applied.value.unmatchedCast.length > 0 ? `；这些人物还没有人物卡片：${applied.value.unmatchedCast.join('、')}` : ''}。`,
        );
      }
      case 'write_chapter': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        events.onEffect?.({ kind: 'open_chapter', chapterId: c.value.id });
        events.onProgress?.(`写手正在写《${c.value.title}》`);
        const written = await host.writeChapter(c.value.id, {
          ...withSignal(events),
          onSegment: (n, total) => {
            events.onProgress?.(`写手正在写《${c.value.title}》：已写 ${n}/${total} 段`);
            // 每写完一段就让界面重新载入这一章，作者看得到正文在长。
            events.onEffect?.({ kind: 'chapter_changed', chapterId: c.value.id });
          },
        });
        if (!written.ok) return fail(written.error);
        changed(events);
        const o = written.value;
        if (o.status === 'written') return done(`写手已写完《${c.value.title}》（写入前的正文在“版本快照”里，可以一键回退）。`);
        return failed(`写手${o.status === 'cancelled' ? '被取消' : '中途停下'}：${o.reason ?? ''}（已写 ${o.segmentsDone}/${o.segmentsTotal} 段，可以接着写）`);
      }
      case 'continue_chapter': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        events.onProgress?.(`正在续写《${c.value.title}》`);
        const content = await host.openChapter(c.value.id);
        if (!content.ok) return fail(content.error);
        const last = content.value.saved.at(-1);
        if (last === undefined || content.value.saved.every((p) => p.text.trim() === '')) return failed(`《${c.value.title}》还没有正文可以接着写；有章节计划时用 write_chapter 让写手写`);
        const end = { paragraphId: last.id, offset: last.text.length };
        const result = await host.runSelectionOperation(
          { chapterId: c.value.id, selection: { from: end, to: end }, operation: 'continue', instruction: action.instruction ?? '', overrides: { include: [], exclude: [] } },
          withSignal(events),
        );
        if (!result.ok) return fail(result.error);
        if (result.value.candidate === null) return failed('续写没有完成');
        events.onEffect?.({ kind: 'show_candidates', chapterId: c.value.id });
        return done(`已为《${c.value.title}》续写一段，作为候选稿放在章节旁的“AI 写作”里，作者接受后才写入正文。`);
      }
      case 'edit_selection': {
        const chosen = events.selection ?? null;
        if (chosen === null || chosen.text.trim() === '') return failed('作者没有在正文里选中文字：请作者先选中要改的那段，再说要怎么改');
        const c = await findChapter(chosen.chapterId);
        if (!c.ok) return failed(c.error);
        events.onProgress?.(`正在${EDIT_LABEL[action.operation]}选中的文字`);
        const result = await host.runSelectionOperation(
          { chapterId: chosen.chapterId, selection: chosen.range, operation: action.operation, instruction: action.instruction ?? '', overrides: { include: [], exclude: [] } },
          withSignal(events),
        );
        if (!result.ok) return fail(result.error);
        if (result.value.candidate === null) return failed(`${EDIT_LABEL[action.operation]}没有完成`);
        events.onEffect?.({ kind: 'show_candidates', chapterId: chosen.chapterId });
        return done(`已${EDIT_LABEL[action.operation]}《${c.value.title}》中选中的 ${chosen.text.length} 字，作为候选稿放在章节旁的“AI 写作”里，作者对照差异后接受。`);
      }
      case 'review_chapter': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        events.onProgress?.(`正在审核《${c.value.title}》`);
        const reviewed = await host.reviewChapter(c.value.id, withSignal(events));
        if (!reviewed.ok) return fail(reviewed.error);
        events.onEffect?.({ kind: 'show_review', chapterId: c.value.id });
        const { issues, modelReviewed, reason } = reviewed.value;
        const note = modelReviewed ? '' : `（模型审核没有完成：${reason ?? '原因不明'}；下面只有程序检查的结果）`;
        if (issues.length === 0) return done(`审核完《${c.value.title}》，没有发现问题${note}。`);
        const listed = issues.slice(0, LISTED_ISSUES).map((i) => `- ${SEVERITY_LABEL[i.severity]}：${i.description}${i.suggestion === '' ? '' : `（建议：${i.suggestion}）`}`);
        const more = issues.length > LISTED_ISSUES ? '\n……' : '';
        return done(`审核完《${c.value.title}》，有 ${issues.length} 个待处理的问题${note}，列在章节旁的“审核”里：\n${listed.join('\n')}${more}`);
      }
      case 'rollback_writer': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        const rolled = await host.rollbackWriter(c.value.id);
        if (!rolled.ok) return fail(rolled.error);
        changed(events);
        events.onEffect?.({ kind: 'chapter_changed', chapterId: c.value.id });
        return done(`已把《${c.value.title}》回退到写手写入之前；回退前的正文存为了快照。`);
      }
      case 'add_foreshadow': {
        let plantChapterId: string | null = null;
        let payoffChapterId: string | null = null;
        if (action.plant !== null) {
          const c = await findChapter(action.plant);
          if (!c.ok) return failed(c.error);
          plantChapterId = c.value.id;
        }
        if (action.payoff !== null) {
          const c = await findChapter(action.payoff);
          if (!c.ok) return failed(c.error);
          payoffChapterId = c.value.id;
        }
        const added = await host.addForeshadow({
          title: action.title,
          content: action.content,
          reveal: action.reveal ?? '',
          plantChapterId,
          plantAnchor: null,
          payoffChapterId,
          payoffAnchor: null,
          status: 'planned',
        });
        if (!added.ok) return fail(added.error);
        changed(events);
        return done(`已在伏笔账本里记下“${action.title.trim()}”。`);
      }
      case 'restore_chapter': {
        const work = await chapters();
        if (!work.ok) return fail(work.error);
        const c = pick(work.value.trashed, action.chapter, (x) => [x.title], '回收站里的章节');
        if (!c.ok) return failed(c.error);
        const restored = await host.restoreChapter(c.value);
        if (!restored.ok) return fail(restored.error);
        changed(events);
        return done(`已把《${c.value.title}》从回收站恢复。`);
      }
      case 'save_snapshot': {
        const c = await findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        const saved = await host.createSnapshot(c.value.id);
        if (!saved.ok) return fail(saved.error);
        return done(`已给《${c.value.title}》存了一个版本快照，在章节的“版本快照”里。`);
      }
      case 'export_book': {
        let chapterId: string | undefined;
        if (action.chapter !== null) {
          const c = await findChapter(action.chapter);
          if (!c.ok) return failed(c.error);
          chapterId = c.value.id;
        }
        const exported = await host.exportText(action.format === 'txt' ? 'txt' : 'md', chapterId);
        if (!exported.ok) return fail(exported.error);
        return exported.value ? done('已导出。') : failed('作者取消了保存，没有导出');
      }
      case 'open_page': {
        events.onEffect?.({ kind: 'open_page', page: action.page });
        return done('已打开页面。');
      }
    }
  }

  /** 作者是否停止了这一轮（每次都重新读取，不受前面判断的影响）。 */
  const aborted = (events: AssistantEvents): boolean => events.signal?.aborted ?? false;

  const withSignal = (events: AssistantEvents): CallOptions => (events.signal === undefined ? {} : { signal: events.signal });

  /** 给作者确认用的说明。 */
  function summaryOf(action: AssistantAction): string {
    if (action.tool === 'delete_volume') return `删除卷“${action.volume}”`;
    if (action.tool === 'trash_chapter') return `把“${action.chapter}”移入回收站`;
    if (action.tool === 'delete_entity') return `删除设定“${action.entity}”`;
    if (action.tool === 'plan_chapters') return `按大纲重新生成 ${action.count} 章的章节计划并采用（会覆盖已有的计划）`;
    if (action.tool === 'rollback_writer') return `把“${action.chapter}”回退到写手写入之前（现稿会先存为快照）`;
    return action.tool;
  }

  async function hasPlans(): Promise<boolean> {
    const port = project();
    if (port === null) return false;
    const plans = await listChapterPlans(port);
    return plans.ok && plans.value.length > 0;
  }

  const history = (items: readonly AssistantItem[]): AssistantHistoryItem[] => {
    const usable = items.filter((i) => i.role !== 'pending');
    let start = Math.max(0, usable.length - HISTORY_LIMIT);
    while (start > 0 && usable[start]?.role !== 'user') start--;
    return usable.slice(start).map((i): AssistantHistoryItem => (i.role === 'user' ? { role: 'user', text: i.text } : i.role === 'assistant' ? { role: 'assistant', output: i.output } : { role: 'results', results: i.role === 'results' ? i.results : [] }));
  };

  /** 从当前的对话往下走，直到办完、需要作者确认、出错或走满步数。 */
  async function proceed(items: AssistantItem[], events: AssistantEvents): Promise<Result<AssistantOutcome, AppError>> {
    // 这一轮从最后一句作者的话开始；作品在这一轮里换了时，这一轮的对话随之存进新的作品。
    const turnStart = items.map((i) => i.role).lastIndexOf('user');
    let workBefore = project();
    for (let step = 0; step < MAX_ASSISTANT_STEPS; step++) {
      if (aborted(events)) break;
      const prompt = renderAssistantTurn({ history: history(items), state: await state(events) });
      if (!prompt.ok) return err(settings(prompt.error));
      // 流式到达时把给作者的话逐字交给界面；只用于显示，动作在整步输出通过校验后才执行。
      let streamed = '';
      const onEvent = (event: LlmStreamEvent) => {
        events.onEvent?.(event);
        if (event.type !== 'text') return;
        streamed += event.delta;
        const message = partialStringField(streamed, 'message');
        if (message !== null) events.onDraft?.(message);
      };
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: ASSISTANT_OUTPUT_TOKENS, effort: 'medium' }, AssistantTurnOutput, { ...withSignal(events), onEvent });
      if (!result.ok) {
        events.onDraft?.(null);
        return result;
      }
      const output = result.value.value;
      await append(items, [{ id: deps.ids.next(), role: 'assistant', output }], events);
      events.onDraft?.(null);
      if (output.actions.length === 0) return ok({ items, pending: false });
      const results: AssistantResult[] = [];
      const planned = await hasPlans();
      for (const action of output.actions) {
        if (aborted(events)) break;
        if (needsConfirm(action, planned)) {
          const added: AssistantItem[] = [];
          if (results.length > 0) added.push({ id: deps.ids.next(), role: 'results', results: [...results] });
          added.push({ id: deps.ids.next(), role: 'pending', action, summary: summaryOf(action) });
          await append(items, added, events);
          return ok({ items, pending: true });
        }
        const outcome = await execute(action, events);
        events.onProgress?.(null);
        results.push({ tool: action.tool, ok: outcome.ok, detail: outcome.detail });
        // 作品换了：这一轮的对话存进新的作品，之后的对话都记在那里。
        const now = project();
        if (now !== workBefore && now !== null) {
          await appendAssistantMessages(now, items.slice(Math.max(0, turnStart)).map((i) => ({ id: i.id, role: i.role, payload: toStored(i) })), ctx());
          items.splice(0, Math.max(0, turnStart));
          memory = [];
          workBefore = now;
        }
      }
      await append(items, [{ id: deps.ids.next(), role: 'results', results }], events);
      // 说办完了而动作都成功，就停下；有动作失败时再走一步，让助手说明或换个办法。
      if (output.done && results.every((r) => r.ok)) return ok({ items, pending: false });
    }
    return ok({ items, pending: false });
  }

  return {
    /** 当前作品（或作品列表页）的对话。 */
    async assistantItems(): Promise<Result<AssistantItem[], AppError>> {
      return load();
    },

    /** 作者说一句话：存入对话，然后让助手往下走。 */
    async sendToAssistant(text: string, events: AssistantEvents = {}): Promise<Result<AssistantOutcome, AppError>> {
      if (text.trim() === '') return err(settings('请输入要助手做的事'));
      if (running) return err(settings('助手正在处理上一句话，请稍候或先停止'));
      running = true;
      try {
        const loaded = await load();
        if (!loaded.ok) return loaded;
        const items = loaded.value;
        const last = items.at(-1);
        if (last?.role === 'pending') {
          await append(items, [{ id: deps.ids.next(), role: 'results', results: [{ tool: last.action.tool, ok: false, detail: '作者没有确认，接着说了别的，这个动作没有执行。' }] }], events);
        }
        await append(items, [{ id: deps.ids.next(), role: 'user', text: text.trim() }], events);
        return await proceed(items, events);
      } finally {
        running = false;
      }
    },

    /** 作者确认或拒绝等待中的动作，然后让助手接着走。 */
    async resolveAssistantPending(approve: boolean, events: AssistantEvents = {}): Promise<Result<AssistantOutcome, AppError>> {
      if (running) return err(settings('助手正在处理，请稍候'));
      running = true;
      try {
        const loaded = await load();
        if (!loaded.ok) return loaded;
        const items = loaded.value;
        const last = items.at(-1);
        if (last?.role !== 'pending') return err(settings('没有等待确认的动作'));
        const outcome = approve ? await execute(last.action, events) : failed('作者没有同意，这个动作没有执行。');
        events.onProgress?.(null);
        await append(items, [{ id: deps.ids.next(), role: 'results', results: [{ tool: last.action.tool, ok: outcome.ok, detail: approve ? `作者确认后执行：${outcome.detail}` : outcome.detail }] }], events);
        return await proceed(items, events);
      } finally {
        running = false;
      }
    },

    /** 清空对话，重新开始。 */
    async clearAssistant(): Promise<Result<void, AppError>> {
      memory = [];
      const port = project();
      if (port === null) return ok(undefined);
      const cleared = await clearAssistantMessages(port);
      return cleared.ok ? ok(undefined) : err({ code: 'repo', error: cleared.error });
    },
  };
}

// —— 存储的形状 ——

function toStored(item: AssistantItem): Record<string, unknown> {
  switch (item.role) {
    case 'user':
      return { text: item.text };
    case 'assistant':
      return { output: item.output };
    case 'results':
      return { results: item.results };
    case 'pending':
      return { action: item.action, summary: item.summary };
  }
}

/** 读回存储的一条；内容不合格（例如旧版本的动作）时略去。 */
function fromStored(id: string, role: string, payload: Readonly<Record<string, unknown>>): AssistantItem[] {
  if (role === 'user' && typeof payload['text'] === 'string') return [{ id, role, text: payload['text'] }];
  if (role === 'assistant') {
    const output = AssistantTurnOutput.safeParse(payload['output']);
    return output.success ? [{ id, role, output: output.data }] : [];
  }
  if (role === 'results' && Array.isArray(payload['results'])) {
    const results = payload['results'].flatMap((r: unknown): AssistantResult[] => {
      if (r === null || typeof r !== 'object') return [];
      const x = r as Record<string, unknown>;
      return typeof x['tool'] === 'string' && typeof x['ok'] === 'boolean' && typeof x['detail'] === 'string' ? [{ tool: x['tool'], ok: x['ok'], detail: x['detail'] }] : [];
    });
    return [{ id, role, results }];
  }
  if (role === 'pending') {
    const action = AssistantTurnOutput.shape.actions.element.safeParse(payload['action']);
    return action.success && typeof payload['summary'] === 'string' ? [{ id, role, action: action.data, summary: payload['summary'] }] : [];
  }
  return [];
}

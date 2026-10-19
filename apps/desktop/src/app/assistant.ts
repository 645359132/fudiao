// AI 助手（需求 B69、B71，施工文档 M5）：对话框里用作者配置的默认模型驱动，理解作者的意图并操作这个软件。
// 每一步模型输出“给作者的话 + 要执行的动作”（结构化输出管线校验，见 packages/prompts 的 AssistantTurnOutput），
// 动作经命令表执行（assistant-tools.ts）；删除与覆盖类的动作先停下，作者在对话框里确认后才执行。
// 对话按作品保存（迁移 0011）；没有打开作品时只在内存里，助手新建或打开作品后，这一轮对话随之存进那部作品。
import {
  AssistantTurnOutput,
  renderAssistantTurn,
  type AssistantAction,
  type AssistantHistoryItem,
  type AssistantResult,
  type AssistantState,
  type RenderedPrompt,
} from '@fudiao/prompts';
import { partialStringField, type LlmStreamEvent, type LlmUsage } from '@fudiao/llm';
import { err, ok, type Result } from '@fudiao/shared';
import { appendAssistantMessages, chapterLengths, clearAssistantMessages, listAssistantMessages, listChapterPlans, listRelationships, type SqlPort } from '@fudiao/store';
import { clip, confirmationFor, PREFERENCES_KEY, preferenceLines, runTool, toolEnv, toolLabel, undoModeOf, type AssistantHost, type Outcome, type ToolEvents } from './assistant-tools';
import { captureWork, CHANGE_KINDS, chapterDigest, diffWork, textUndoSummary, undoChanges, type ChangeEntry } from './assistant-undo';
import { ENTITY_KIND_LABEL, PLAN_STATUS_LABEL, RELATION_CATEGORY_LABEL } from './labels';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';

export type { AssistantEffect, AssistantHost, AssistantSelection } from './assistant-tools';

/** 对话中的一条：作者的话、助手一步的输出、动作的结果，或等待作者确认的动作。 */
export type AssistantItem =
  | { readonly id: string; readonly role: 'user'; readonly text: string }
  | { readonly id: string; readonly role: 'assistant'; readonly output: AssistantTurnOutput }
  | { readonly id: string; readonly role: 'results'; readonly results: readonly AssistantResult[] }
  | { readonly id: string; readonly role: 'pending'; readonly action: AssistantAction; readonly summary: string; readonly rest: readonly AssistantAction[] }
  /** 一个动作对作品的改动（撤销用，不给模型看）；kept 为真表示动作有结果但不在撤销范围。 */
  | { readonly id: string; readonly role: 'changes'; readonly tool: string; readonly entries: readonly ChangeEntry[]; readonly kept: boolean }
  /** 撤销了某一轮：undid 是撤销掉的改动（changes 条目的标识）；作者在对话框里点的撤销要告诉模型，助手自己的撤销已在动作结果里。 */
  | {
      readonly id: string;
      readonly role: 'undo';
      readonly undid: readonly string[];
      readonly report: string;
      readonly ok: boolean;
      readonly source: 'button' | 'action';
      /** 重建的记录：旧标识到新标识（之后再撤销更早的一轮时用）。 */
      readonly rebuilt: Readonly<Record<string, string>>;
    };

/** 可以撤销的一轮：这一轮里还没有撤销的改动，与这一轮最后一条的标识（界面把“撤销”放在它后面）。 */
export type UndoTarget = { readonly changes: readonly Extract<AssistantItem, { role: 'changes' }>[]; readonly lastId: string };

/**
 * 最近一轮有改动、还没有撤销的对话（skipCurrent 时不算最后一轮：助手在这一轮里被要求撤销的是上一轮）。
 * 已经撤销过的轮次跳过，所以再撤销一次就是更早的一轮。
 */
export function undoTarget(items: readonly AssistantItem[], skipCurrent = false): UndoTarget | null {
  const undone = new Set(items.flatMap((i) => (i.role === 'undo' ? i.undid : [])));
  const starts = items.flatMap((i, at) => (i.role === 'user' ? [at] : []));
  const turns = starts.map((start, n) => items.slice(start, starts[n + 1] ?? items.length));
  for (const turn of (skipCurrent ? turns.slice(0, -1) : turns).reverse()) {
    const changes = turn.filter((i): i is Extract<AssistantItem, { role: 'changes' }> => i.role === 'changes' && i.entries.length > 0 && !undone.has(i.id));
    if (changes.length > 0) return { changes, lastId: turn.at(-1)?.id ?? '' };
  }
  return null;
}

/** 一轮对话的回调：动作执行要用的（见 ToolEvents），加上对话的更新、逐字显示与作者在看什么。 */
export type AssistantEvents = ToolEvents & {
  /** 对话每多一条时调用（界面据此逐步显示进展）。 */
  readonly onUpdate?: (items: readonly AssistantItem[]) => void;
  /** 模型正在输出的这一步里，给作者的话已经到达的部分（逐字显示）；这一步结束时为 null。 */
  readonly onDraft?: (message: string | null) => void;
  /** 作者此刻在看什么（章节或页面），写进给模型的现状。 */
  readonly current?: () => string;
  /** 正在后台进行的任务（写手在写哪一章、排着几章、审核、推演等），一句话一项，写进给模型的现状。 */
  readonly running?: () => readonly string[];
  /** 助手每一步的思考深度（作者在对话框下方选择），没有给出时为 medium。 */
  readonly effort?: 'low' | 'medium' | 'high';
  /** 每一步结束后：这一步发给模型的内容占了多少 Token，以及模型的上下文上限（服务没有返回用量时不调用）。 */
  readonly onUsage?: (usage: AssistantUsage) => void;
};

/** 一步请求的上下文用量：promptTokens 含命中缓存与写入缓存的部分。 */
export type AssistantUsage = { readonly promptTokens: number; readonly contextWindow: number };

/** 一轮对话的结果：最新的对话，以及是否停在等待作者确认。 */
export type AssistantOutcome = { readonly items: readonly AssistantItem[]; readonly pending: boolean };

/** 一轮请求中模型最多走几步（每步一次调用），防止来回打转；走满时告诉作者停在了哪里。 */
export const MAX_ASSISTANT_STEPS = 12;
/**
 * 带给模型的对话与现状有多少（一级比一级少）。平常用第一级：对话最多最近 60 条、4 万字（超出时从最早的一轮开头略去，
 * 这一轮总是保留）；之前几轮的动作结果只留 600 字（那一轮已经用过了，留着全文只会让每一步越来越长）；现状最多列
 * 120 章、200 项设定、80 条关系。估算放不进模型的上下文时依次换下一级；后两级连这一轮较早的动作结果也截短，
 * 后三级把作品的简介、大纲与卷简介截成开头与结尾（全文用 get_work 查看）。
 */
type Budget = {
  readonly historyItems: number;
  readonly historyChars: number;
  readonly earlierResult: number;
  /** 这一轮里除最新一条以外的动作结果最多留多少字；null 为不截。 */
  readonly currentResult: number | null;
  readonly chapters: number;
  readonly entities: number;
  readonly relations: number;
  /** 简介与大纲各留多少字、每卷简介留多少字；null 为不截。 */
  readonly outline: number | null;
  readonly volumeSummary: number | null;
};
const BUDGETS: readonly Budget[] = [
  { historyItems: 60, historyChars: 40_000, earlierResult: 600, currentResult: null, chapters: 120, entities: 200, relations: 80, outline: null, volumeSummary: null },
  { historyItems: 30, historyChars: 16_000, earlierResult: 300, currentResult: null, chapters: 60, entities: 100, relations: 40, outline: 8_000, volumeSummary: 600 },
  { historyItems: 12, historyChars: 6_000, earlierResult: 200, currentResult: 3_000, chapters: 30, entities: 50, relations: 20, outline: 3_000, volumeSummary: 200 },
  { historyItems: 0, historyChars: 0, earlierResult: 0, currentResult: 1_500, chapters: 12, entities: 20, relations: 10, outline: 1_000, volumeSummary: 80 },
];
/**
 * 估算请求有多少 Token：正文的字数乘以每字的 Token 数，起初按偏多的 1.3 估（中文在各家分词器里大多不超过它），
 * 之后按服务报回的用量校准（按模型分开）。原生结构化输出时输出结构也随请求发出，它是英文与符号，按每字 0.5 估，
 * 不参与校准。上下文留出 5% 的余量，再减去输出的上限与一次格式修正要追加的内容（上一次的输出与问题说明）。
 */
const DEFAULT_TOKENS_PER_CHAR = 1.3;
const SCHEMA_TOKENS_PER_CHAR = 0.5;
const CONTEXT_MARGIN = 0.05;
const REPAIR_RESERVE = 2_000;
/** 现状中作者选中的文字最多给出的字数：太长时给开头与结尾。 */
const SELECTION_LIMIT = 2_000;
export const ASSISTANT_OUTPUT_TOKENS = 6_000 + THINKING_ALLOWANCE;

const settings = (detail: string): AppError => ({ code: 'settings', detail });

/** 这一轮从哪一条开始，以及开始时打开的作品：作品在这一轮里换了时，这一轮的对话随之存进新的作品。 */
type TurnState = { turnStart: number; workBefore: string | null };

/** 没有执行的动作也要告诉模型，免得它以为做过了。 */
const skipped = (actions: readonly AssistantAction[], detail: string): AssistantResult[] => actions.map((a) => ({ tool: a.tool, ok: false, detail }));

export function assistantUseCases({
  deps,
  host,
  project,
  workKey,
  runner,
}: {
  readonly deps: AppDeps;
  readonly host: AssistantHost;
  readonly project: () => SqlPort | null;
  /** 当前打开的作品（作品库的位置）；作品库的连接可能在换作品后沿用同一个对象，不能据连接判断换没换作品。 */
  readonly workKey: () => string | null;
  readonly runner: ReturnType<typeof modelRunner>;
}) {
  const ctx = () => ({ now: deps.clock.now() });
  /** 没有打开作品时的对话。 */
  let memory: AssistantItem[] = [];
  /** 正在进行的一轮：取消用。 */
  let running = false;
  /** 各模型每字约多少 Token（按服务报回的用量校准）。 */
  const tokensPerChar = new Map<string, number>();

  async function load(): Promise<Result<AssistantItem[], AppError>> {
    const port = project();
    if (port === null) return ok([...memory]);
    const rows = await listAssistantMessages(port);
    if (!rows.ok) return err({ code: 'repo', error: rows.error });
    return ok(rows.value.flatMap((r): AssistantItem[] => fromStored(r.id, r.role, r.payload)));
  }

  /** 追加并保存；作品没有打开时只在内存里。 */
  /** 存不进作品库时返回错误：调用方停下这一轮，不让界面上的对话与存下的不一致、也不接着调用模型。 */
  async function append(items: AssistantItem[], added: readonly AssistantItem[], events: AssistantEvents): Promise<Result<void, AppError>> {
    const port = project();
    if (port !== null) {
      const saved = await appendAssistantMessages(port, added.map((a) => ({ id: a.id, role: a.role, payload: toStored(a) })), ctx());
      if (!saved.ok) return err({ code: 'repo', error: saved.error });
    }
    items.push(...added);
    if (port === null) memory = [...items];
    events.onUpdate?.([...items]);
    return ok(undefined);
  }

  // —— 现状 ——

  async function state(events: AssistantEvents): Promise<AssistantState> {
    const current = events.current?.() ?? '';
    const library = await host.loadLibrary();
    const works = library.ok ? library.value.works.filter((w) => !w.archived && !w.missing).map((w) => w.title) : [];
    const running = events.running?.() ?? [];
    const port = project();
    if (port === null) return { works, running, work: null };
    const work = await host.reloadWork();
    if (!work.ok) return { works, running, work: null };
    const [entities, plans, lengths, relations, skills] = await Promise.all([host.listEntities(), listChapterPlans(port), chapterLengths(port), listRelationships(port), host.listWritingSkills()]);
    const preferenceSkill = skills.ok ? skills.value.skills.find((s) => s.skill.key === PREFERENCES_KEY && s.skill.enabled) : undefined;
    const planOf = new Map(plans.ok ? plans.value.map((p) => [p.chapterId, PLAN_STATUS_LABEL[p.status]]) : []);
    const lengthOf = new Map(lengths.ok ? lengths.value.map((l) => [l.chapterId, l.length]) : []);
    const volumeTitle = new Map(work.value.volumes.map((v) => [v.id, v.title]));
    const all = work.value.chapters.map((c) => ({ id: c.id, title: c.title, volume: c.volumeId === null ? '' : (volumeTitle.get(c.volumeId) ?? ''), words: lengthOf.get(c.id) ?? 0, plan: planOf.get(c.id) ?? '' }));
    const p = work.value.project;
    const nameOf = new Map((entities.ok ? entities.value : []).map((e) => [e.id, e.name]));
    const titleOf = new Map(work.value.chapters.map((c) => [c.id, c.title]));
    const rels = relations.ok ? relations.value : [];
    const range = (from: string | null, to: string | null) =>
      [from === null ? '' : `《${titleOf.get(from) ?? ''}》起`, to === null ? '' : `至《${titleOf.get(to) ?? ''}》`].join('');
    const chosen = events.selection ?? null;
    const chosenChapter = chosen === null ? undefined : work.value.chapters.find((c) => c.id === chosen.chapterId);
    let selection: NonNullable<AssistantState['work']>['selection'] = null;
    if (chosen !== null && chosenChapter !== undefined && chosen.text.trim() !== '') {
      selection = { chapter: chosenChapter.title, length: chosen.text.length, ...clip(chosen.text, SELECTION_LIMIT) };
    }
    return {
      works,
      running,
      work: {
        trashed: work.value.trashed.slice(0, 30).map((c) => ({ id: c.id, title: c.title })),
        relations: rels.map((r) => ({
          id: r.id,
          from: nameOf.get(r.fromId) ?? '',
          to: nameOf.get(r.toId) ?? '',
          label: r.label,
          mutual: r.mutual,
          secret: r.secret,
          category: RELATION_CATEGORY_LABEL[r.category],
          range: range(r.validFromChapterId, r.validToChapterId),
        })),
        relationCount: rels.length,
        preferences: preferenceSkill === undefined ? [] : preferenceLines(preferenceSkill.skill.instruction),
        selection,
        title: p.title,
        genre: p.genre,
        synopsis: p.synopsis,
        outline: p.outline,
        volumes: work.value.volumes.map((v) => ({ id: v.id, title: v.title, summary: v.summary })),
        chapters: all,
        chapterCount: all.length,
        totalWords: all.reduce((n, c) => n + c.words, 0),
        plannedCount: all.filter((c) => c.plan !== '').length,
        omitted: false,
        entities: (entities.ok ? entities.value : []).map((e) => ({ id: e.id, kind: ENTITY_KIND_LABEL[e.kind], name: e.name, locked: e.locked })),
        entityCount: entities.ok ? entities.value.length : 0,
        current,
      },
    };
  }


  /** 按这一级的量列出现状：章节太多时列前三分之一与后面的部分，设定与关系列前面的部分，简介、大纲与卷简介留开头与结尾。 */
  const trimState = (full: AssistantState, budget: Budget, trimmed: boolean): AssistantState => {
    const w = full.work;
    if (w === null) return { ...full, trimmed };
    const omitted = w.chapters.length > budget.chapters;
    const head = Math.floor(budget.chapters / 3);
    const cut = (text: string, limit: number | null) => (limit === null ? text : clip(text, limit).text);
    return {
      ...full,
      trimmed,
      work: {
        ...w,
        synopsis: cut(w.synopsis, budget.outline),
        outline: cut(w.outline, budget.outline),
        volumes: w.volumes.map((v) => ({ ...v, summary: cut(v.summary, budget.volumeSummary) })),
        chapters: omitted ? [...w.chapters.slice(0, head), ...w.chapters.slice(-(budget.chapters - head))] : w.chapters,
        omitted,
        entities: w.entities.slice(0, budget.entities),
        relations: (w.relations ?? []).slice(0, budget.relations),
      },
    };
  };

  /** 作者是否停止了这一轮（每次都重新读取，不受前面判断的影响）。 */
  const aborted = (events: AssistantEvents): boolean => events.signal?.aborted ?? false;


  const history = (items: readonly AssistantItem[], budget: Budget): AssistantHistoryItem[] => {
    const usable = items.filter((i) => i.role !== 'pending' && i.role !== 'changes' && !(i.role === 'undo' && i.source === 'action'));
    const turnStart = usable.map((i) => i.role).lastIndexOf('user');
    const converted = usable.map((i, at): AssistantHistoryItem => {
      if (i.role === 'user') return { role: 'user', text: i.text };
      if (i.role === 'assistant') return { role: 'assistant', output: i.output };
      const results = i.role === 'results' ? i.results : i.role === 'undo' ? [{ tool: 'undo_last_turn', ok: i.ok, detail: `作者在对话框里点了撤销：${i.report}` }] : [];
      const limit = at < turnStart ? budget.earlierResult : at < usable.length - 1 ? budget.currentResult : null;
      return { role: 'results', results: limit === null ? results : results.map((r) => ({ ...r, detail: clip(r.detail, limit).text })) };
    });
    const size = (h: AssistantHistoryItem) => (h.role === 'user' ? h.text.length : h.role === 'assistant' ? JSON.stringify(h.output).length : h.results.reduce((n, r) => n + r.detail.length + r.tool.length, 0));
    // 从最近的往前数，条数或字数超出时从那一轮的开头（作者的话）截断；这一轮总是完整保留。
    let start = converted.length;
    let chars = 0;
    while (start > 0) {
      const item = converted[start - 1]!;
      if (start - 1 < turnStart && (converted.length - (start - 1) > budget.historyItems || chars + size(item) > budget.historyChars)) break;
      chars += size(item);
      start--;
    }
    while (start < converted.length && start > 0 && converted[start]?.role !== 'user') start++;
    return converted.slice(start);
  };

  /** 助手撤销上一轮时要改回的正文（见 undo_last_turn 的确认）。 */
  const undoPreview = (items: readonly AssistantItem[]): string | null => {
    const target = undoTarget(items, true);
    return target === null ? null : textUndoSummary(target.changes.map((c) => c.entries));
  };

  const turnState = (items: readonly AssistantItem[]): TurnState => ({ turnStart: items.map((i) => i.role).lastIndexOf('user'), workBefore: workKey() });

  /**
   * 依次执行动作，结果记进 results。遇到须作者确认的就停下：排在它后面的动作随等待确认的那一条保存，
   * 作者确认后接着执行（不然它们会悄悄丢掉，模型还以为做过了）。返回是否停在等待确认。
   */
  async function runActions(
    actions: readonly AssistantAction[],
    results: AssistantResult[],
    items: AssistantItem[],
    events: AssistantEvents,
    turn: TurnState,
  ): Promise<Result<boolean, AppError>> {
    for (const [at, action] of actions.entries()) {
      if (aborted(events)) {
        results.push(...skipped(actions.slice(at), '作者停止了，这个动作没有执行。'));
        return ok(false);
      }
      const env = toolEnv(host, project, events, () => undoLast(items, events, 'action'), () => undoPreview(items));
      const asked = await confirmationFor(action.tool, action, env);
      if (asked !== null) {
        const added: AssistantItem[] = [];
        if (results.length > 0) added.push({ id: deps.ids.next(), role: 'results', results: [...results] });
        // 存下确认时找到的那一项（标识），作者确认后执行的就是说明里的那一个。
        added.push({ id: deps.ids.next(), role: 'pending', action: asked.action, summary: asked.summary, rest: actions.slice(at + 1) });
        const saved = await append(items, added, events);
        return saved.ok ? ok(true) : saved;
      }
      const performed = await perform(action, env, items, events);
      events.onProgress?.(null);
      if (!performed.ok) return performed;
      const outcome = performed.value;
      results.push({ tool: action.tool, ok: outcome.ok, detail: outcome.detail });
      // 作品换了：这一轮的对话存进新的作品，之后的对话都记在那里。
      const now = project();
      if (workKey() !== turn.workBefore && now !== null) {
        const moved = await appendAssistantMessages(now, items.slice(Math.max(0, turn.turnStart)).map((i) => ({ id: i.id, role: i.role, payload: toStored(i) })), ctx());
        if (!moved.ok) return err({ code: 'repo', error: moved.error });
        items.splice(0, Math.max(0, turn.turnStart));
        memory = [];
        turn.workBefore = workKey();
        // 这一轮现在从头开始：同一轮里再换一次作品时，从作者的话起整轮存过去。
        turn.turnStart = 0;
      }
    }
    return ok(false);
  }

  /**
   * 执行一个动作并记下它对作品的改动（撤销用）：改结构的动作前后各取一份现状、记下差别；写手写章记下章节；
   * 写手修订前先给那一章存快照。作品在动作里换了（新建或打开了另一部）时不记。
   */
  async function perform(action: AssistantAction, env: ReturnType<typeof toolEnv>, items: AssistantItem[], events: AssistantEvents): Promise<Result<Outcome, AppError>> {
    const mode = undoModeOf(action.tool);
    const port = project();
    const key = workKey();
    let entries: ChangeEntry[] = [];
    let outcome: Outcome;
    if (mode === 'work') {
      // 动作自己指明写入的那一步时只记那一步的改动（见 ToolEnv.recordChanges），否则记整个执行期间的。
      let recorded: ChangeEntry[] | null = null;
      const recordChanges = async <T>(f: () => Promise<T>): Promise<T> => {
        const before = await captureWork(host, port);
        const result = await f();
        const after = workKey() === key ? await captureWork(host, port) : null;
        recorded = before !== null && after !== null ? diffWork(before, after, new Set()) : [];
        return result;
      };
      const before = await captureWork(host, port);
      outcome = await runTool(action.tool, action, { ...env, recordChanges });
      const after = workKey() === key ? await captureWork(host, port) : null;
      // 移动的那一卷或那一章，位置的变化要记下（撤销时放回去）。
      const moved = action.tool === 'move_chapter' ? await env.findChapter(action.chapter) : action.tool === 'move_volume' ? await env.findVolume(action.volume) : null;
      if (recorded !== null) entries = recorded;
      else if (before !== null && after !== null) entries = diffWork(before, after, new Set(moved?.ok === true ? [moved.value.id] : []));
    } else if (mode === 'writer' && action.tool === 'write_chapter') {
      const chapter = await env.findChapter(action.chapter);
      outcome = await runTool(action.tool, action, env);
      const written = outcome.ok && chapter.ok ? await chapterDigest(host, chapter.value.id) : null;
      if (chapter.ok && written?.ok === true) entries = [{ kind: 'writer', id: chapter.value.id, title: chapter.value.title, digest: written.value.digest }];
    } else if (mode === 'revise' && action.tool === 'revise_review_issue') {
      const chapterId = await host.issueChapterId(action.issue.trim());
      const chapter = chapterId.ok && chapterId.value !== null ? await env.findChapter(chapterId.value) : null;
      const snapshot = chapter?.ok === true ? await host.createSnapshot(chapter.value.id) : null;
      outcome = await runTool(action.tool, action, env);
      const revised = outcome.ok && chapter?.ok === true ? await chapterDigest(host, chapter.value.id) : null;
      if (chapter?.ok === true && snapshot?.ok === true && revised?.ok === true) {
        entries = [{ kind: 'text', id: chapter.value.id, title: chapter.value.title, snapshotId: snapshot.value.id, digest: revised.value.digest }];
      }
    } else {
      outcome = await runTool(action.tool, action, env);
    }
    const kept = mode === 'kept' && outcome.ok;
    if (entries.length > 0 || kept) {
      const item: AssistantItem = { id: deps.ids.next(), role: 'changes', tool: action.tool, entries, kept };
      // 作品在这个动作里换了：先只放进这一轮的对话，随后整轮存进新的作品（见 runActions）。
      if (workKey() === key) {
        const saved = await append(items, [item], events);
        if (!saved.ok) return saved;
      } else items.push(item);
    }
    return ok(outcome);
  }

  /**
   * 撤销一轮的改动，记进对话。source 为 action 时是助手在这一轮里被要求撤销（撤销上一轮），结果作为动作结果交给模型；
   * 为 button 时是作者在对话框里点的（撤销最近一轮），之后作者再说话时模型会看到。
   */
  async function undoLast(items: AssistantItem[], events: AssistantEvents, source: 'button' | 'action'): Promise<Outcome> {
    const target = undoTarget(items, source === 'action');
    if (target === null) return { ok: false, detail: '没有可以撤销的改动（更早的改动已经撤销过，或那几轮没有改动作品）' };
    const rebuilt: Record<string, string> = {};
    for (const i of items) if (i.role === 'undo') Object.assign(rebuilt, i.rebuilt);
    const done = await undoChanges(
      host,
      project,
      target.changes.map((c) => c.entries),
      rebuilt,
    );
    if (!done.ok) return { ok: false, detail: done.error.code === 'no_work' ? '还没有打开作品' : '撤销没有完成' };
    events.onEffect?.({ kind: 'changed' });
    for (const c of target.changes) for (const e of c.entries) if (e.kind === 'writer' || e.kind === 'text') events.onEffect?.({ kind: 'chapter_changed', chapterId: e.id });
    const turn = items.slice(items.findIndex((i) => i.id === target.changes[0]?.id));
    const kept = [...new Set(turn.flatMap((i) => (i.role === 'changes' && i.kept ? [toolLabel(i.tool)] : [])))];
    const { undone, skipped } = done.value;
    const report = [
      undone.length > 0 ? `已撤销：${undone.join('；')}。` : '没有撤销任何改动。',
      skipped.length > 0 ? `没有撤销：${skipped.join('；')}。` : '',
      kept.length > 0 ? `这一轮里“${kept.join('、')}”的结果不在撤销范围，照旧保留。` : '',
    ]
      .filter((x) => x !== '')
      .join('');
    const ok = undone.length > 0;
    const saved = await append(items, [{ id: deps.ids.next(), role: 'undo', undid: target.changes.map((c) => c.id), report, ok, source, rebuilt: done.value.rebuilt }], events);
    if (!saved.ok) return { ok: false, detail: `${report}但撤销的记录没有存进作品库，对话框里可能显示得不对` };
    return { ok, detail: report };
  }

  /**
   * 按模型的上下文上限挑一级的量渲染这一步的请求：第一级放得下就用它，放不下依次换更少的一级（最后一级仍放不下时照发，
   * 由服务报错）。缩减过时现状里写明，模型知道要用读取动作重新查看。不知道上限时用第一级。
   */
  function fitPrompt(items: readonly AssistantItem[], full: AssistantState, limits: Limits) {
    const room =
      limits === null || limits.contextWindow <= 0
        ? Infinity
        : limits.contextWindow * (1 - CONTEXT_MARGIN) - Math.min(ASSISTANT_OUTPUT_TOKENS, limits.maxOutputTokens) - REPAIR_RESERVE;
    let rendered = renderAssistantTurn({ history: history(items, BUDGETS[0]!), state: trimState(full, BUDGETS[0]!, false) });
    for (const budget of BUDGETS.slice(1)) {
      if (!rendered.ok || estimateTokens(rendered.value, limits) <= room) break;
      rendered = renderAssistantTurn({ history: history(items, budget), state: trimState(full, budget, true) });
    }
    return rendered;
  }

  /** 这一步的请求约有多少 Token（见 DEFAULT_TOKENS_PER_CHAR）。 */
  const estimateTokens = (prompt: RenderedPrompt, limits: Limits): number => {
    const size = promptSize(prompt);
    const perChar = (limits === null ? undefined : tokensPerChar.get(limits.model)) ?? DEFAULT_TOKENS_PER_CHAR;
    return size.text * perChar + (limits?.nativeSchema === true ? size.schema * SCHEMA_TOKENS_PER_CHAR : 0);
  };

  /** 按第一次请求（修正之前）服务报回的输入 Token 数校准这个模型每字的 Token 数（扣掉输出结构的估计）。 */
  const calibrate = (prompt: RenderedPrompt, limits: Limits, usage: LlmUsage | null) => {
    if (limits === null || usage === null) return;
    const size = promptSize(prompt);
    const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens - (limits.nativeSchema ? size.schema * SCHEMA_TOKENS_PER_CHAR : 0);
    if (size.text > 0 && input > 0) tokensPerChar.set(limits.model, Math.min(3, Math.max(0.3, input / size.text)));
  };

  /** 从当前的对话往下走，直到办完、需要作者确认、出错或走满步数。 */
  async function proceed(items: AssistantItem[], events: AssistantEvents): Promise<Result<AssistantOutcome, AppError>> {
    const turn = turnState(items);
    const limits = await runner.modelLimits();
    for (let step = 0; step < MAX_ASSISTANT_STEPS; step++) {
      if (aborted(events)) break;
      const prompt = fitPrompt(items, await state(events), limits);
      if (!prompt.ok) return err(settings(prompt.error));
      // 流式到达时把给作者的话逐字交给界面；只用于显示，动作在整步输出通过校验后才执行。
      let streamed = '';
      const onEvent = (event: LlmStreamEvent) => {
        events.onEvent?.(event);
        if (event.type === 'retry') {
          streamed = '';
          events.onDraft?.(null);
          events.onProgress?.(`网络中断，正在重新请求（第 ${event.attempt} 次）`);
          return;
        }
        if (event.type !== 'text') return;
        streamed += event.delta;
        const message = partialStringField(streamed, 'message');
        if (message !== null) events.onDraft?.(message);
      };
      const result = await runner.structured(
        { prompt: prompt.value, maxOutputTokens: ASSISTANT_OUTPUT_TOKENS, effort: events.effort ?? 'medium' },
        AssistantTurnOutput,
        { ...(events.signal !== undefined && { signal: events.signal }), onEvent },
      );
      if (!result.ok) {
        events.onDraft?.(null);
        return result;
      }
      const usage = result.value.attempts.at(-1)?.usage ?? null;
      if (usage !== null) events.onUsage?.({ promptTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, contextWindow: result.value.contextWindow });
      calibrate(prompt.value, limits, result.value.attempts[0]?.usage ?? null);
      const output = result.value.value;
      const said = await append(items, [{ id: deps.ids.next(), role: 'assistant', output }], events);
      events.onDraft?.(null);
      if (!said.ok) return said;
      if (output.actions.length === 0) return ok({ items, pending: false });
      const results: AssistantResult[] = [];
      const ran = await runActions(output.actions, results, items, events, turn);
      if (!ran.ok) return ran;
      if (ran.value) return ok({ items, pending: true });
      const saved = await append(items, [{ id: deps.ids.next(), role: 'results', results }], events);
      if (!saved.ok) return saved;
      // 说办完了而动作都成功，就停下；有动作失败时再走一步，让助手说明或换个办法。
      if (output.done && results.every((r) => r.ok)) return ok({ items, pending: false });
    }
    // 作者停止了，或走满了步数：说清楚停在哪里，不让上一步“还要继续”的话悬着。
    const stopped = aborted(events) ? '已按作者的要求停下，' : `这一轮已经走了 ${MAX_ASSISTANT_STEPS} 步，先停在这里；`;
    const note = `${stopped}上面列出的是已经做完的。要接着做，说“继续”即可。`;
    const saved = await append(items, [{ id: deps.ids.next(), role: 'assistant', output: { message: note, actions: [], done: true } }], events);
    return saved.ok ? ok({ items, pending: false }) : saved;
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
          const declined = await append(
            items,
            [{ id: deps.ids.next(), role: 'results', results: [{ tool: last.action.tool, ok: false, detail: '作者没有确认，接着说了别的，这个动作没有执行。' }, ...skipped(last.rest, '排在等待确认的动作后面，也没有执行；需要的话重新给出。')] }],
            events,
          );
          if (!declined.ok) return declined;
        }
        const said = await append(items, [{ id: deps.ids.next(), role: 'user', text: text.trim() }], events);
        if (!said.ok) return said;
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
        const turn = turnState(items);
        const performed = approve ? await perform(last.action, toolEnv(host, project, events, () => undoLast(items, events, 'action'), () => undoPreview(items)), items, events) : ok({ ok: false, detail: '作者没有同意，这个动作没有执行。' });
        events.onProgress?.(null);
        if (!performed.ok) return performed;
        const outcome = performed.value;
        const results: AssistantResult[] = [{ tool: last.action.tool, ok: outcome.ok, detail: approve ? `作者确认后执行：${outcome.detail}` : outcome.detail }];
        // 同一步里排在它后面的动作：确认了就接着执行（可能又停在下一个须确认的动作上），没同意就都不执行。
        if (approve) {
          const ran = await runActions(last.rest, results, items, events, turn);
          if (!ran.ok) return ran;
          if (ran.value) return ok({ items, pending: true });
        } else results.push(...skipped(last.rest, '排在作者没有同意的动作后面，也没有执行；需要的话重新给出。'));
        const saved = await append(items, [{ id: deps.ids.next(), role: 'results', results }], events);
        if (!saved.ok) return saved;
        return await proceed(items, events);
      } finally {
        running = false;
      }
    },

    /** 作者在对话框里点“撤销这一轮的改动”：撤销最近一轮有改动的对话。不调用模型。 */
    async undoAssistantTurn(events: AssistantEvents = {}): Promise<Result<AssistantOutcome, AppError>> {
      if (running) return err(settings('助手正在处理，请稍候'));
      running = true;
      try {
        const loaded = await load();
        if (!loaded.ok) return loaded;
        const items = loaded.value;
        if (items.at(-1)?.role === 'pending') return err(settings('先确认或拒绝等待中的动作'));
        const done = await undoLast(items, events, 'button');
        if (!done.ok && undoTarget(items) !== null) return err(settings(done.detail));
        return ok({ items, pending: false });
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

type Limits = Awaited<ReturnType<ReturnType<typeof modelRunner>['modelLimits']>>;

/** 一次请求的字数：系统提示与各条消息（text）、输出结构的 JSON（schema）。 */
const promptSize = (prompt: RenderedPrompt): { readonly text: number; readonly schema: number } => ({
  text: prompt.system.reduce((n, s) => n + s.text.length, 0) + prompt.messages.reduce((n, m) => n + m.content.length, 0),
  schema: prompt.output === undefined ? 0 : JSON.stringify(prompt.output.schema).length,
});

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
      return { action: item.action, summary: item.summary, rest: item.rest };
    case 'changes':
      return { tool: item.tool, entries: item.entries, kept: item.kept };
    case 'undo':
      return { undid: item.undid, report: item.report, ok: item.ok, source: item.source, rebuilt: item.rebuilt };
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
  if (role === 'changes' && typeof payload['tool'] === 'string' && Array.isArray(payload['entries'])) {
    // 改动记录是这里自己写下的；种类不认识的（更新的版本写的）略去。
    const entries = payload['entries'].filter((e: unknown): e is ChangeEntry => e !== null && typeof e === 'object' && CHANGE_KINDS.has(String((e as Record<string, unknown>)['kind'])));
    return [{ id, role, tool: payload['tool'], entries, kept: payload['kept'] === true }];
  }
  if (role === 'undo' && Array.isArray(payload['undid']) && typeof payload['report'] === 'string') {
    const undid = payload['undid'].filter((x: unknown): x is string => typeof x === 'string');
    const raw = payload['rebuilt'];
    const rebuilt = raw !== null && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    return [{ id, role, undid, report: payload['report'], ok: payload['ok'] === true, source: payload['source'] === 'action' ? 'action' : 'button', rebuilt }];
  }
  if (role === 'pending') {
    const action = AssistantTurnOutput.shape.actions.element.safeParse(payload['action']);
    // 较早保存的没有 rest。
    const rest = AssistantTurnOutput.shape.actions.safeParse(payload['rest'] ?? []);
    return action.success && rest.success && typeof payload['summary'] === 'string' ? [{ id, role, action: action.data, summary: payload['summary'], rest: rest.data }] : [];
  }
  return [];
}

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
} from '@fudiao/prompts';
import { partialStringField, type LlmStreamEvent } from '@fudiao/llm';
import { err, ok, type Result } from '@fudiao/shared';
import { appendAssistantMessages, chapterLengths, clearAssistantMessages, listAssistantMessages, listChapterPlans, listRelationships, type SqlPort } from '@fudiao/store';
import { clip, confirmationFor, runTool, toolEnv, type AssistantHost, type ToolEvents } from './assistant-tools';
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
  | { readonly id: string; readonly role: 'pending'; readonly action: AssistantAction; readonly summary: string };

/** 一轮对话的回调：动作执行要用的（见 ToolEvents），加上对话的更新、逐字显示与作者在看什么。 */
export type AssistantEvents = ToolEvents & {
  /** 对话每多一条时调用（界面据此逐步显示进展）。 */
  readonly onUpdate?: (items: readonly AssistantItem[]) => void;
  /** 模型正在输出的这一步里，给作者的话已经到达的部分（逐字显示）；这一步结束时为 null。 */
  readonly onDraft?: (message: string | null) => void;
  /** 作者此刻在看什么（章节或页面），写进给模型的现状。 */
  readonly current?: () => string;
};

/** 一轮对话的结果：最新的对话，以及是否停在等待作者确认。 */
export type AssistantOutcome = { readonly items: readonly AssistantItem[]; readonly pending: boolean };

/** 一轮请求中模型最多走几步（每步一次调用），防止来回打转。 */
export const MAX_ASSISTANT_STEPS = 8;
/** 给模型的对话最多带最近这么多条（从作者的一句话开始）。 */
const HISTORY_LIMIT = 60;
/** 现状中最多列出的章节与设定。 */
const MAX_LISTED_CHAPTERS = 120;
const MAX_LISTED_ENTITIES = 200;
const MAX_LISTED_RELATIONS = 80;
/** 现状中作者选中的文字最多给出的字数：太长时给开头与结尾。 */
const SELECTION_LIMIT = 2_000;
export const ASSISTANT_OUTPUT_TOKENS = 6_000 + THINKING_ALLOWANCE;

const settings = (detail: string): AppError => ({ code: 'settings', detail });

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
    const [entities, plans, lengths, relations] = await Promise.all([host.listEntities(), listChapterPlans(port), chapterLengths(port), listRelationships(port)]);
    const planOf = new Map(plans.ok ? plans.value.map((p) => [p.chapterId, PLAN_STATUS_LABEL[p.status]]) : []);
    const lengthOf = new Map(lengths.ok ? lengths.value.map((l) => [l.chapterId, l.length]) : []);
    const volumeTitle = new Map(work.value.volumes.map((v) => [v.id, v.title]));
    const all = work.value.chapters.map((c) => ({ id: c.id, title: c.title, volume: c.volumeId === null ? '' : (volumeTitle.get(c.volumeId) ?? ''), words: lengthOf.get(c.id) ?? 0, plan: planOf.get(c.id) ?? '' }));
    const omitted = all.length > MAX_LISTED_CHAPTERS;
    const chapters = omitted ? [...all.slice(0, 40), ...all.slice(-(MAX_LISTED_CHAPTERS - 40))] : all;
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
      work: {
        trashed: work.value.trashed.slice(0, 30).map((c) => ({ id: c.id, title: c.title })),
        relations: rels.slice(0, MAX_LISTED_RELATIONS).map((r) => ({
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
        selection,
        title: p.title,
        genre: p.genre,
        synopsis: p.synopsis,
        outline: p.outline,
        volumes: work.value.volumes.map((v) => ({ id: v.id, title: v.title, summary: v.summary })),
        chapters,
        chapterCount: all.length,
        omitted,
        entities: (entities.ok ? entities.value : []).slice(0, MAX_LISTED_ENTITIES).map((e) => ({ id: e.id, kind: ENTITY_KIND_LABEL[e.kind], name: e.name, locked: e.locked })),
        current,
      },
    };
  }


  /** 作者是否停止了这一轮（每次都重新读取，不受前面判断的影响）。 */
  const aborted = (events: AssistantEvents): boolean => events.signal?.aborted ?? false;


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
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: ASSISTANT_OUTPUT_TOKENS, effort: 'medium' }, AssistantTurnOutput, { ...(events.signal !== undefined && { signal: events.signal }), onEvent });
      if (!result.ok) {
        events.onDraft?.(null);
        return result;
      }
      const output = result.value.value;
      await append(items, [{ id: deps.ids.next(), role: 'assistant', output }], events);
      events.onDraft?.(null);
      if (output.actions.length === 0) return ok({ items, pending: false });
      const results: AssistantResult[] = [];
      for (const action of output.actions) {
        if (aborted(events)) break;
        const env = toolEnv(host, project, events);
        const summary = await confirmationFor(action.tool, action, env);
        if (summary !== null) {
          const added: AssistantItem[] = [];
          if (results.length > 0) added.push({ id: deps.ids.next(), role: 'results', results: [...results] });
          added.push({ id: deps.ids.next(), role: 'pending', action, summary });
          await append(items, added, events);
          return ok({ items, pending: true });
        }
        const outcome = await runTool(action.tool, action, env);
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
        const outcome = approve ? await runTool(last.action.tool, last.action, toolEnv(host, project, events)) : { ok: false, detail: '作者没有同意，这个动作没有执行。' };
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

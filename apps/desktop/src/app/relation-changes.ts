// 人物关系随剧情变化（需求 B73 补充，作者反馈 2026-10-23）：写手写完一章、整理完长篇记忆后，由模型读这一章（或几章）的
// 长篇记忆，找出关系的新增、改变与结束，人物的出场、退场与回归。找到的先存为待确认的建议（硬性规则 21：记下来源章节、
// 依据的记忆版本与调用记录），作者在人物关系页逐条采用、忽略，或全部采用后才写进作品。
// 已经写了很多章的作品可以补找：按书中顺序分批，只找还没按当前这一版记忆找过的章节。
import type { CallOptions } from '@fudiao/llm';
import { RelationChangesOutput, renderRelationChanges } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  countChaptersWithoutMemory,
  countPendingRelationSuggestions,
  createEntity,
  createRelationship,
  deleteCastPresence,
  findCallByRequestHash,
  getProject,
  getRelationSuggestion,
  listCastAppearances,
  listCastPresence,
  listChapterMemories,
  listChapters,
  listEntities,
  listRelationScanTodo,
  listRelationSuggestions,
  listRelationships,
  reviewStaleMemories,
  saveCastPresence,
  saveRelationScan,
  settleRelationSuggestion,
  updateCastPresence,
  updateEntity,
  updateRelationship,
  type CastPresence,
  type CastPresenceFields,
  type Chapter,
  type Entity,
  type Relationship,
  type RelationSuggestion,
  type RepoError,
  type SqlPort,
  type SuggestionInput,
} from '@fudiao/store';
import {
  castTimelines,
  chapterMention,
  exitAt,
  exitNote,
  projectRelations,
  relationToChange,
  replaceLabels,
  resolveRelationChanges,
  type ChangeChapter,
  type LabeledRelation,
  type PresenceRecord,
} from '@fudiao/writing';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';

/** 一次最多交给模型几章。 */
export const RELATION_BATCH_CHAPTERS = 8;
/** 一次交给模型的梗概与人物状态最多多少字（超出时这一批少带几章）。 */
const RELATION_BATCH_CHARS = 12_000;
/** 人物说明在提示词里最多留多少字（人物多的书，人物表不至于太长）。 */
const DESCRIPTION_CHARS = 60;
/** 输出上限：几十条变化，每条一两句，另留出思考的余量。 */
export const RELATION_OUTPUT_TOKENS = 3_000 + THINKING_ALLOWANCE;

export type RelationScanStatus = {
  /** 长篇记忆有效、还没按这一版记忆找过的章节（书中顺序）。 */
  readonly todo: readonly string[];
  /** 有正文、却没有有效长篇记忆的章节数：要先整理或重建记忆。 */
  readonly noMemory: number;
};

/** 出场与退场：记下的记录，以及每个人物第一次出场的章节（推算的与记下的，取最早的）。 */
export type CastPresenceView = {
  readonly records: readonly CastPresence[];
  readonly firstChapter: Readonly<Record<string, string>>;
};

export type RelationChangesView = {
  /** 待确认的建议，按书中顺序。 */
  readonly suggestions: readonly RelationSuggestion[];
  readonly scan: RelationScanStatus;
};

/** 一次查找的结果：找过几章、新存了几条建议、丢弃了几条（对不上、重复或已处理过）。 */
export type RelationScanResult = { readonly scanned: number; readonly added: number; readonly dropped: number };

/** 补找的结果：做了几批；stop 为停下的原因（作者停下或某一批没有做成），做完时为 null。 */
export type RelationBackfillResult = RelationScanResult & { readonly batches: number; readonly left: number; readonly stop: AppError | null };

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

/** 关系读成一句话：“甲是乙的师父”，双向时“甲与乙：朋友”。 */
export const relationText = (from: string, to: string, label: string, mutual: boolean) => (mutual ? `${from}与${to}：${label}` : `${from}是${to}的${label}`);

const clip = (text: string, n: number) => {
  const chars = [...text.trim().replace(/\s+/g, ' ')];
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n).join('')}……`;
};

/** 一条建议的称呼（结束的那句话、失败的说明里用）。 */
export function suggestionText(s: RelationSuggestion): string {
  switch (s.kind) {
    case 'relation_add':
      return `新增关系：${relationText(s.fromName, s.toName, s.label, s.mutual)}`;
    case 'relation_change':
      return `关系改变：${s.fromName}与${s.toName}${s.oldLabel === '' ? '' : `从“${s.oldLabel}”`}变为“${s.label}”`;
    case 'relation_end':
      return `关系结束：${relationText(s.fromName, s.toName, s.label, s.mutual)}`;
    case 'cast_enter':
      return `新人物出场：${s.fromName}`;
    case 'cast_exit':
      return `人物退场：${s.fromName}`;
    case 'cast_return':
      return `人物回归：${s.fromName}`;
  }
}

/** 名字（含别名）→ 人物卡片。 */
function characterIndex(entities: readonly Entity[]): Map<string, Entity> {
  const out = new Map<string, Entity>();
  for (const e of entities.filter((x) => x.kind === 'character')) for (const n of [e.name, ...e.aliases]) if (n.trim() !== '' && !out.has(n.trim())) out.set(n.trim(), e);
  return out;
}

/** 出场与退场：记下的记录，以及每个人物第一次出场的章节。 */
export async function castPresenceOf(port: SqlPort): Promise<Result<CastPresenceView, AppError>> {
  const [records, appearances, chapters] = await Promise.all([listCastPresence(port), listCastAppearances(port), listChapters(port, 'normal')]);
  if (!records.ok) return err(repo(records.error));
  if (!appearances.ok) return err(repo(appearances.error));
  if (!chapters.ok) return err(repo(chapters.error));
  const timelines = castTimelines({ order: new Map(chapters.value.map((c, i) => [c.id, i])), appearances: appearances.value, records: records.value });
  const firstChapter: Record<string, string> = {};
  for (const [id, t] of timelines) {
    const chapter = t.first === null ? undefined : chapters.value[t.first];
    if (chapter !== undefined) firstChapter[id] = chapter.id;
  }
  return ok({ records: records.value, firstChapter });
}

/** 待确认的建议与还要找的章节。先标出待复核的长篇记忆：正文改过的不算有效。 */
export async function relationChangesOf(port: SqlPort, ctx: { readonly now: string }): Promise<Result<RelationChangesView, AppError>> {
  const reviewed = await reviewStaleMemories(port, ctx);
  if (!reviewed.ok) return err(repo(reviewed.error));
  const [suggestions, todo, noMemory] = await Promise.all([listRelationSuggestions(port), listRelationScanTodo(port), countChaptersWithoutMemory(port)]);
  if (!suggestions.ok) return err(repo(suggestions.error));
  if (!todo.ok) return err(repo(todo.error));
  if (!noMemory.ok) return err(repo(noMemory.error));
  return ok({ suggestions: suggestions.value, scan: { todo: todo.value.map((t) => t.chapterId), noMemory: noMemory.value } });
}

export function relationChangeUseCases(deps: AppDeps, project: () => SqlPort | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });

  const presence = (port: SqlPort) => castPresenceOf(port);
  const changesView = (port: SqlPort) => relationChangesOf(port, ctx());

  /** 找这几章（有效的长篇记忆）带来的变化：一次调用，结果换掉这些章原来待确认的建议。 */
  async function find(port: SqlPort, chapterIds: readonly string[], options: CallOptions): Promise<Result<RelationScanResult, AppError>> {
    const [work, chapters, memories, entities, relationships, records, appearances, pending, settled] = await Promise.all([
      getProject(port),
      listChapters(port, 'normal'),
      listChapterMemories(port),
      listEntities(port),
      listRelationships(port),
      listCastPresence(port),
      listCastAppearances(port),
      listRelationSuggestions(port),
      listRelationSuggestions(port, null),
    ]);
    if (!work.ok) return err(repo(work.error));
    if (!chapters.ok) return err(repo(chapters.error));
    if (!memories.ok) return err(repo(memories.error));
    if (!entities.ok) return err(repo(entities.error));
    if (!relationships.ok) return err(repo(relationships.error));
    if (!records.ok) return err(repo(records.error));
    if (!appearances.ok) return err(repo(appearances.error));
    if (!pending.ok) return err(repo(pending.error));
    if (!settled.ok) return err(repo(settled.error));
    const order = new Map(chapters.value.map((c, i) => [c.id, i]));
    const memoryOf = new Map(memories.value.map((m) => [m.chapterId, m]));
    const batch = chapterIds
      .flatMap((id) => {
        const index = order.get(id);
        const memory = memoryOf.get(id);
        return index === undefined || memory === undefined || memory.status !== 'valid' ? [] : [{ chapter: chapters.value[index]!, index, memory }];
      })
      .sort((a, b) => a.index - b.index);
    if (batch.length === 0) return err(settings('这些章还没有有效的长篇记忆：先在计划页整理（或重建）长篇记忆，再找人物关系的变化'));
    const start = batch[0]!.index;

    const nameOf = new Map(entities.value.map((e) => [e.id, e.name]));
    const characters = entities.value.filter((e) => e.kind === 'character');
    // 这一批开始时的人物与关系：已有的，加上这一批之前待确认的建议（后面几章不重复前面已经找到、还没确认的）。
    const earlier = pending.value.filter((p) => (order.get(p.chapterId) ?? Infinity) < start);
    const projected = projectRelations(relationships.value, earlier, (id) => nameOf.get(id) ?? '', start, order);
    const relations: LabeledRelation[] = projected.map((r, i) => ({ ...r, tag: `R${i + 1}` }));
    const newcomers = earlier.filter((p) => p.kind === 'cast_enter' && p.fromId === null);
    const pendingRecords: PresenceRecord[] = earlier.flatMap((p) =>
      (p.kind === 'cast_exit' || p.kind === 'cast_return') && p.fromId !== null ? [{ entityId: p.fromId, chapterId: p.chapterId, kind: p.kind === 'cast_exit' ? 'exit' : 'return', note: p.description }] : [],
    );
    const timelines = castTimelines({ order, appearances: appearances.value, records: [...records.value, ...pendingRecords] });
    const status = (id: string) => {
      const t = timelines.get(id);
      const exit = exitAt(t, start);
      if (exit !== null) return `第 ${exit.at + 1} 章退场${exit.note.trim() === '' ? '' : `：${exit.note.trim()}`}`;
      return t?.first === null || t === undefined || t.first > start ? '还没出场' : '';
    };

    const labels: ChangeChapter[] = batch.map((b, i) => ({ label: `C${i + 1}`, chapterId: b.chapter.id, index: b.index, prevId: chapters.value[b.index - 1]?.id ?? null }));
    const castLine = (state: Readonly<Record<string, string>>) => Object.entries(state).flatMap(([id, s]) => (nameOf.has(id) ? [`${nameOf.get(id) ?? ''}：${s}`] : []));
    const prompt = renderRelationChanges({
      title: work.value?.title ?? '',
      genre: work.value?.genre ?? '',
      characters: [
        ...characters.map((c) => ({ name: c.name, aliases: c.aliases, description: clip(c.description, DESCRIPTION_CHARS), status: status(c.id) })),
        ...newcomers.map((p) => ({ name: p.fromName, aliases: [], description: clip(p.description, DESCRIPTION_CHARS), status: '待作者确认的新人物' })),
      ],
      relations: relations.map((r) => ({ label: r.tag, text: relationText(r.from.name, r.to.name, r.label, r.mutual), description: clip(r.description, DESCRIPTION_CHARS) })),
      chapters: batch.map((b, i) => ({ label: `C${i + 1}`, title: b.chapter.title, summary: b.memory.summary, cast: castLine(b.memory.castState) })),
    });
    if (!prompt.ok) return err(settings(prompt.error));
    const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: RELATION_OUTPUT_TOKENS, effort: 'low' }, RelationChangesOutput, options);
    if (!result.ok) return result;

    // 说明里照抄的标签换成章节名与关系。
    const mentions = new Map<string, string>([
      ...labels.map((c) => [c.label, chapterMention(chapters.value[c.index]?.title ?? '', c.index)] as const),
      ...relations.map((r) => [r.tag, `“${relationText(r.from.name, r.to.name, r.label, r.mutual)}”`] as const),
    ]);
    const { changes, dropped } = resolveRelationChanges({
      chapters: labels,
      people: [...characters.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })), ...newcomers.map((p) => ({ id: null, name: p.fromName, aliases: [] }))],
      relations,
      draft: result.value.value,
      rewrite: (text) => replaceLabels(text, mentions),
    });
    // 作者已经采用或忽略过的同样一条（这几章重新找时）不再提。
    const key = (x: { chapterId: string; kind: string; fromName: string; toName: string; label: string }) => [x.chapterId, x.kind, x.fromName, x.toName, x.label].join('|');
    const handled = new Set(settled.value.filter((s) => s.status !== 'pending').map(key));
    const versionOf = new Map(batch.map((b) => [b.chapter.id, b.memory.version]));
    const inputs: SuggestionInput[] = [];
    let repeated = 0;
    for (const c of changes) {
      const input: SuggestionInput = {
        id: deps.ids.next(),
        chapterId: c.chapterId,
        kind: c.kind,
        relationshipId: c.relationshipId,
        fromId: c.from.id,
        fromName: c.from.name,
        toId: c.to?.id ?? null,
        toName: c.to?.name ?? '',
        category: c.category,
        label: c.label,
        oldLabel: c.oldLabel,
        mutual: c.mutual,
        secret: c.secret,
        description: c.description,
        validToChapterId: c.validToChapterId,
        reason: c.reason,
        memoryVersion: versionOf.get(c.chapterId) ?? 0,
      };
      if (handled.has(key(input))) {
        repeated += 1;
        continue;
      }
      inputs.push(input);
    }
    const hash = result.value.attempts.at(-1)?.requestHash;
    const call = hash === undefined ? null : await findCallByRequestHash(port, hash);
    const saved = await saveRelationScan(
      port,
      { scanned: batch.map((b) => ({ chapterId: b.chapter.id, memoryVersion: b.memory.version })), llmCallId: call?.ok === true ? (call.value?.id ?? null) : null, suggestions: inputs },
      ctx(),
    );
    if (!saved.ok) return err(repo(saved.error));
    return ok({ scanned: batch.length, added: inputs.length, dropped: dropped + repeated });
  }

  /** 把还要找的章节按书中顺序分批：每批最多几章，梗概与人物状态的字数有上限。 */
  async function batches(port: SqlPort): Promise<Result<string[][], AppError>> {
    const reviewed = await reviewStaleMemories(port, ctx());
    if (!reviewed.ok) return err(repo(reviewed.error));
    const [todo, memories] = await Promise.all([listRelationScanTodo(port), listChapterMemories(port)]);
    if (!todo.ok) return err(repo(todo.error));
    if (!memories.ok) return err(repo(memories.error));
    const sizeOf = new Map(memories.value.map((m) => [m.chapterId, m.summary.length + Object.values(m.castState).reduce((n, s) => n + s.length + 6, 0)]));
    const out: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const { chapterId } of todo.value) {
      const n = sizeOf.get(chapterId) ?? 0;
      if (current.length > 0 && (current.length >= RELATION_BATCH_CHAPTERS || size + n > RELATION_BATCH_CHARS)) {
        out.push(current);
        current = [];
        size = 0;
      }
      current.push(chapterId);
      size += n;
    }
    if (current.length > 0) out.push(current);
    return ok(out);
  }

  /** 人物卡片：有标识的直接取；新人物按名字（含别名）找，没有时建卡片（用它待确认的出场建议的小传，并采用那一条）。 */
  async function personOf(port: SqlPort, id: string | null, name: string, chapterId: string): Promise<Result<Entity, AppError>> {
    const entities = await listEntities(port);
    if (!entities.ok) return err(repo(entities.error));
    const found = id === null ? characterIndex(entities.value).get(name.trim()) : entities.value.find((e) => e.id === id);
    if (found !== undefined) return ok(found);
    if (id !== null) return err(repo({ code: 'not_found' }));
    const pending = await listRelationSuggestions(port);
    if (!pending.ok) return err(repo(pending.error));
    const enter = pending.value.find((p) => p.kind === 'cast_enter' && p.fromName === name.trim());
    if (enter !== undefined) {
      const adopted = await adopt(port, enter);
      if (!adopted.ok) return adopted;
      const again = await listEntities(port);
      if (!again.ok) return err(repo(again.error));
      const made = characterIndex(again.value).get(name.trim());
      return made === undefined ? err(repo({ code: 'not_found' })) : ok(made);
    }
    return enterCharacter(port, name, '', chapterId);
  }

  /** 新人物：建卡片（锁定之类的属性都是默认的），记下在这一章第一次出场。 */
  async function enterCharacter(port: SqlPort, name: string, description: string, chapterId: string): Promise<Result<Entity, AppError>> {
    const made = await createEntity(port, { id: deps.ids.next(), kind: 'character', name }, ctx());
    if (!made.ok) return err(repo(made.error));
    const described = description.trim() === '' ? ok(made.value) : await updateEntity(port, made.value.id, made.value.version, { description: description.trim() }, ctx());
    if (!described.ok) return err(repo(described.error));
    const entered = await saveCastPresence(port, { id: deps.ids.next(), entityId: made.value.id, chapterId, kind: 'enter', note: '' }, ctx());
    if (!entered.ok) return err(repo(entered.error));
    return ok(described.value);
  }

  /**
   * 采用一条建议：写进作品，记为已采用（带上建出或改动的记录）。按两端重新找原来的关系，前面的建议采用过或作者改过关系都能接上；
   * 再采用一次（例如上一次写进作品后没来得及记为已采用）不会重复建。
   */
  async function adopt(port: SqlPort, s: RelationSuggestion): Promise<Result<string | null, AppError>> {
    const chapters = await listChapters(port, 'normal');
    if (!chapters.ok) return err(repo(chapters.error));
    const order = new Map(chapters.value.map((c, i) => [c.id, i]));
    const index = order.get(s.chapterId);
    if (index === undefined) return err(settings('这条建议所在的章节不在目录里了'));
    const chapter: Chapter = chapters.value[index]!;
    const where = chapterMention(chapter.title, index);
    let resultId: string;

    if (s.kind === 'cast_enter' || s.kind === 'cast_exit' || s.kind === 'cast_return') {
      if (s.kind === 'cast_enter') {
        const entities = await listEntities(port);
        if (!entities.ok) return err(repo(entities.error));
        const existing = characterIndex(entities.value).get(s.fromName.trim());
        if (existing === undefined) {
          const made = await enterCharacter(port, s.fromName, s.description, s.chapterId);
          if (!made.ok) return made;
          resultId = made.value.id;
        } else {
          // 作者在这之前已经建了这个人物：只记下出场的章节。
          const entered = await saveCastPresence(port, { id: deps.ids.next(), entityId: existing.id, chapterId: s.chapterId, kind: 'enter', note: '' }, ctx());
          if (!entered.ok) return err(repo(entered.error));
          resultId = existing.id;
        }
      } else {
        const person = await personOf(port, s.fromId, s.fromName, s.chapterId);
        if (!person.ok) return person;
        const saved = await saveCastPresence(port, { id: deps.ids.next(), entityId: person.value.id, chapterId: s.chapterId, kind: s.kind === 'cast_exit' ? 'exit' : 'return', note: s.description }, ctx());
        if (!saved.ok) return err(repo(saved.error));
        resultId = saved.value.id;
      }
    } else {
      const from = await personOf(port, s.fromId, s.fromName, s.chapterId);
      if (!from.ok) return from;
      const to = await personOf(port, s.toId, s.toName, s.chapterId);
      if (!to.ok) return to;
      const category = s.category ?? 'other';
      const fields = { fromId: from.value.id, toId: to.value.id, category, label: s.label, mutual: s.mutual, description: s.description, secret: s.secret };
      // 新建关系之前读一次：personOf 可能刚采用了新人物的出场。
      const current = await listRelationships(port);
      if (!current.ok) return err(repo(current.error));
      const create = async (validFromChapterId: string | null, validToChapterId: string | null) => {
        const same = current.value.find(
          (r) => r.label === s.label && ((r.fromId === from.value.id && r.toId === to.value.id) || (r.mutual && r.fromId === to.value.id && r.toId === from.value.id)) && r.validFromChapterId === validFromChapterId,
        );
        if (same !== undefined) return ok(same);
        const made = await createRelationship(port, { id: deps.ids.next(), ...fields, validFromChapterId, validToChapterId }, ctx());
        return made.ok ? ok(made.value) : err(repo(made.error));
      };
      if (s.kind === 'relation_add') {
        const made = await create(s.chapterId, s.validToChapterId);
        if (!made.ok) return made;
        resultId = made.value.id;
      } else {
        const target = relationToChange(current.value, s.relationshipId, from.value.id, to.value.id, s.kind === 'relation_change' ? s.oldLabel : s.label, index, order);
        if (s.kind === 'relation_end') {
          if (target === undefined) return err(settings(`${from.value.name}与${to.value.name}在${where}时已经没有这层关系：这条建议可以忽略`));
          const until = target.validToChapterId === null ? undefined : order.get(target.validToChapterId);
          const ended = until !== undefined && until <= index ? ok(target) : await updateRelationship(port, target.id, target.version, { ...keep(target), validToChapterId: s.chapterId }, ctx());
          if (!ended.ok) return err(repo(ended.error));
          resultId = target.id;
        } else if (target === undefined) {
          // 原来的关系已不在：改变后的样子从这一章起。
          const made = await create(s.chapterId, null);
          if (!made.ok) return made;
          resultId = made.value.id;
        } else {
          const began = target.validFromChapterId === null ? undefined : order.get(target.validFromChapterId);
          const prev = chapters.value[index - 1];
          if ((began !== undefined && began >= index) || prev === undefined) {
            // 原来的关系就是从这一章起的（或这是第一章）：就地改成新的样子。
            const changed = await updateRelationship(port, target.id, target.version, { ...fields, validFromChapterId: target.validFromChapterId, validToChapterId: target.validToChapterId }, ctx());
            if (!changed.ok) return err(repo(changed.error));
            resultId = target.id;
          } else {
            // 旧的到上一章为止，新的从这一章起（旧的原来定了结束的章节时，新的接着到那里为止）。
            const ended = await updateRelationship(port, target.id, target.version, { ...keep(target), validToChapterId: prev.id }, ctx());
            if (!ended.ok) return err(repo(ended.error));
            const made = await create(s.chapterId, target.validToChapterId);
            if (!made.ok) return made;
            resultId = made.value.id;
          }
        }
      }
    }
    const settled = await settleRelationSuggestion(port, s.id, s.version, 'adopted', resultId, ctx());
    return settled.ok ? ok(resultId) : err(repo(settled.error));
  }

  return {
    castPresenceView: async (): Promise<Result<CastPresenceView, AppError>> => {
      const port = project();
      return port === null ? err({ code: 'no_work' }) : presence(port);
    },
    relationChangesView: async (): Promise<Result<RelationChangesView, AppError>> => {
      const port = project();
      return port === null ? err({ code: 'no_work' }) : changesView(port);
    },
    /** 待确认的条数：导航“人物关系”上显示。没有打开作品时为 0。 */
    async relationSuggestionCount(): Promise<Result<number, AppError>> {
      const port = project();
      if (port === null) return ok(0);
      const n = await countPendingRelationSuggestions(port);
      return n.ok ? n : err(repo(n.error));
    },

    /** 找这几章带来的关系与人物变化（写手写完一章后调用；也可以作者指定）。 */
    async findRelationChanges(chapterIds: readonly string[], options: CallOptions = {}): Promise<Result<RelationScanResult, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const reviewed = await reviewStaleMemories(port, ctx());
      if (!reviewed.ok) return err(repo(reviewed.error));
      return find(port, chapterIds, options);
    },

    /** 从已写的章节找出变化：按书中顺序分批，只找还没按当前这一版长篇记忆找过的；onBatch 报告做到第几批。 */
    async backfillRelationChanges(options: CallOptions & { readonly onBatch?: (done: number, total: number) => void } = {}): Promise<Result<RelationBackfillResult, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const planned = await batches(port);
      if (!planned.ok) return planned;
      const total = planned.value.length;
      let scanned = 0;
      let added = 0;
      let dropped = 0;
      let done = 0;
      let stop: AppError | null = null;
      const aborted = () => options.signal?.aborted === true;
      for (const chapterIds of planned.value) {
        if (aborted()) {
          stop = { code: 'interrupted', detail: '已停下' };
          break;
        }
        options.onBatch?.(done, total);
        const found = await find(port, chapterIds, options);
        if (!found.ok) {
          stop = aborted() ? { code: 'interrupted', detail: '已停下' } : found.error;
          break;
        }
        scanned += found.value.scanned;
        added += found.value.added;
        dropped += found.value.dropped;
        done += 1;
      }
      options.onBatch?.(done, total);
      const left = planned.value.slice(done).reduce((n, b) => n + b.length, 0);
      return ok({ batches: done, scanned, added, dropped, left, stop });
    },

    async adoptRelationSuggestion(id: string): Promise<Result<void, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const s = await getRelationSuggestion(port, id);
      if (!s.ok) return err(repo(s.error));
      if (s.value === null || s.value.status !== 'pending') return err(repo({ code: 'not_found' }));
      const done = await adopt(port, s.value);
      return done.ok ? ok(undefined) : done;
    },

    /** 全部采用：按书中顺序逐条采用；没采用成的跳过、接着采用后面的，返回它们与原因。 */
    async adoptAllRelationSuggestions(): Promise<Result<{ readonly adopted: number; readonly failed: readonly string[] }, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const list = await listRelationSuggestions(port);
      if (!list.ok) return err(repo(list.error));
      let adopted = 0;
      const failed: string[] = [];
      for (const item of list.value) {
        // 前面一条采用时可能顺带采用了它（新人物的出场）：重新读一次。
        const s = await getRelationSuggestion(port, item.id);
        if (!s.ok) return err(repo(s.error));
        if (s.value === null || s.value.status !== 'pending') continue;
        const done = await adopt(port, s.value);
        if (done.ok) adopted += 1;
        else failed.push(`${suggestionText(s.value)}（${done.error.code === 'settings' ? done.error.detail : done.error.code === 'repo' && done.error.error.code === 'invalid' ? done.error.error.detail : '没有写成'}）`);
      }
      return ok({ adopted, failed });
    },

    async ignoreRelationSuggestion(id: string): Promise<Result<void, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const s = await getRelationSuggestion(port, id);
      if (!s.ok) return err(repo(s.error));
      if (s.value === null) return err(repo({ code: 'not_found' }));
      const done = await settleRelationSuggestion(port, id, s.value.version, 'ignored', null, ctx());
      return done.ok ? ok(undefined) : err(repo(done.error));
    },

    /** 记下（或修改）人物的出场、退场与回归。 */
    async saveCastPresence(current: CastPresence | null, fields: CastPresenceFields): Promise<Result<CastPresenceView, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const done = current === null ? await saveCastPresence(port, { id: deps.ids.next(), ...fields }, ctx()) : await updateCastPresence(port, current.id, current.version, fields, ctx());
      if (!done.ok) return err(repo(done.error));
      return presence(port);
    },

    async deleteCastPresence(current: CastPresence): Promise<Result<CastPresenceView, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const done = await deleteCastPresence(port, current.id, current.version);
      if (!done.ok) return err(repo(done.error));
      return presence(port);
    },
  };
}

/** 改起止章节时其余字段照旧。 */
const keep = (r: Relationship) => ({ fromId: r.fromId, toId: r.toId, category: r.category, label: r.label, mutual: r.mutual, description: r.description, secret: r.secret, validFromChapterId: r.validFromChapterId, validToChapterId: r.validToChapterId });

/** 规划时交给模型的人物说明：书写到最后仍在退场中的，说明后面带上“第 N 章退场：…”。 */
export async function characterBriefs(port: SqlPort, characters: readonly Entity[]): Promise<Result<{ readonly name: string; readonly description: string; readonly id: string }[], RepoError>> {
  const [records, appearances, chapters] = await Promise.all([listCastPresence(port), listCastAppearances(port), listChapters(port, 'normal')]);
  if (!records.ok) return records;
  if (!appearances.ok) return appearances;
  if (!chapters.ok) return chapters;
  const timelines = castTimelines({ order: new Map(chapters.value.map((c, i) => [c.id, i])), appearances: appearances.value, records: records.value });
  return ok(
    characters.map((c) => {
      const note = exitNote(timelines.get(c.id), chapters.value.length);
      return { id: c.id, name: c.name, description: note === '' ? c.description : `${c.description.trim()}${c.description.trim() === '' ? '' : '\n'}（${note}）` };
    }),
  );
}

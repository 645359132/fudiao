// 撤销 AI 助手一轮的改动（ASSISTANT_REVIEW.md 第五节第 3 项）。
// 改动作品结构的动作（设定、关系、卷与章节、作品信息、计划、伏笔、写作技能、规避词表、候选事实）执行前后各取一份
// 结构化的现状，记下两者的差别；撤销时倒着把每一项改回去。改回只经现有的用例，锁定设定、版本守卫与回收站照常生效；
// 某一项在助手改过以后又被改过（作者或后台），不动它，在说明里写明。正文不在这份现状里：写手写章用回退写手写入，
// 写手修订在执行前先存一个快照，撤销时恢复它。候选稿、审核结果、长篇记忆、推演记录等不改作品内容的，照旧保留。
import { err, ok, type Result } from '@fudiao/shared';
import {
  listChapterPlans,
  listEntities,
  listForeshadows,
  listRelationships,
  type Entity,
  type EntityKind,
  type FactStatus,
  type ForeshadowFields,
  type PlanFields,
  type RelationshipFields,
  type SqlPort,
} from '@fudiao/store';
import type { AssistantHost } from './assistant-tools';
import type { AppError } from './errors';

type ProjectImage = { readonly title: string; readonly genre: string; readonly synopsis: string; readonly outline: string };
type VolumeImage = { readonly title: string; readonly summary: string; readonly after: string | null };
type ChapterImage = { readonly title: string; readonly summary: string; readonly notes: string; readonly volumeId: string | null; readonly after: string | null; readonly trashed: boolean };
type EntityImage = { readonly kind: EntityKind; readonly name: string; readonly description: string; readonly aliases: readonly string[]; readonly attributes: Entity['attributes'] };
type SkillImage = { readonly name: string; readonly enabled: boolean; readonly instruction: string; readonly custom: boolean };
type AvoidImage = { readonly custom: boolean; readonly phrases: readonly string[] };
type FactImage = { readonly status: FactStatus; readonly content: string };

/** 每类记录的样子（撤销时比较与改回用）。 */
type Images = {
  readonly project: ProjectImage;
  readonly volume: VolumeImage;
  readonly chapter: ChapterImage;
  readonly entity: EntityImage;
  readonly relationship: RelationshipFields;
  readonly plan: PlanFields;
  readonly foreshadow: ForeshadowFields;
  readonly skill: SkillImage;
  readonly avoid: AvoidImage;
  readonly fact: FactImage;
};
type Kind = keyof Images;

/** 作品的结构化现状：每类记录按标识（计划按章节，作品信息与规避词表各一项）。 */
export type WorkImage = { readonly [K in Kind]: Readonly<Record<string, Images[K]>> };

/** 一项改动：before 为 null 是新建的，after 为 null 是删掉的。 */
type RecordChange<K extends Kind> = { readonly kind: K; readonly id: string; readonly before: Images[K] | null; readonly after: Images[K] | null };

/** 一个动作留下的可撤销改动（存进对话，作品重新打开后照样能撤销）。 */
export type ChangeEntry =
  | { readonly [K in Kind]: RecordChange<K> }[Kind]
  /** 写手写了这一章：撤销即回退写手写入。 */
  | { readonly kind: 'writer'; readonly id: string; readonly title: string }
  /** 写手修订了这一章：撤销即恢复修订前存的快照。 */
  | { readonly kind: 'text'; readonly id: string; readonly title: string; readonly snapshotId: string };

export const CHANGE_KINDS: ReadonlySet<string> = new Set<ChangeEntry['kind']>(['project', 'volume', 'chapter', 'entity', 'relationship', 'plan', 'foreshadow', 'skill', 'avoid', 'fact', 'writer', 'text']);

/** 撤销需要的用例：助手的用例，加上删除计划、伏笔、技能与事实，恢复快照。 */
export type UndoHost = AssistantHost;

const describeError = (e: AppError): string => {
  if (e.code === 'settings') return e.detail;
  if (e.code === 'repo') {
    if (e.error.code === 'locked') return '是锁定设定';
    if (e.error.code === 'conflict') return '已在别处修改';
    if (e.error.code === 'in_use') return '还有别的内容用到它';
    if (e.error.code === 'invalid') return e.error.detail;
    if (e.error.code === 'not_found') return '已经不在了';
  }
  return e.code;
};

/** 取作品的结构化现状。没有打开作品时为 null。 */
export async function captureWork(host: UndoHost, port: SqlPort | null): Promise<WorkImage | null> {
  if (port === null) return null;
  const [work, entities, relationships, plans, foreshadows, skills, facts] = await Promise.all([
    host.reloadWork(),
    listEntities(port),
    listRelationships(port),
    listChapterPlans(port),
    listForeshadows(port),
    host.listWritingSkills(),
    host.listFacts(),
  ]);
  if (!work.ok || !entities.ok || !relationships.ok || !plans.ok || !foreshadows.ok || !skills.ok || !facts.ok) return null;
  const w = work.value;
  const volume: Record<string, VolumeImage> = {};
  w.volumes.forEach((v, i) => {
    volume[v.id] = { title: v.title, summary: v.summary, after: i === 0 ? null : (w.volumes[i - 1]?.id ?? null) };
  });
  const chapter: Record<string, ChapterImage> = {};
  const lastIn = new Map<string | null, string>();
  for (const c of w.chapters) {
    chapter[c.id] = { title: c.title, summary: c.summary, notes: c.notes, volumeId: c.volumeId, after: lastIn.get(c.volumeId) ?? null, trashed: false };
    lastIn.set(c.volumeId, c.id);
  }
  for (const c of w.trashed) chapter[c.id] = { title: c.title, summary: c.summary, notes: c.notes, volumeId: c.volumeId, after: null, trashed: true };
  const by = <T extends { readonly id: string }, I>(list: readonly T[], f: (t: T) => I): Record<string, I> => Object.fromEntries(list.map((t) => [t.id, f(t)]));
  return {
    project: { project: { title: w.project.title, genre: w.project.genre, synopsis: w.project.synopsis, outline: w.project.outline } },
    volume,
    chapter,
    entity: by(entities.value, (e) => ({ kind: e.kind, name: e.name, description: e.description, aliases: e.aliases, attributes: e.attributes })),
    relationship: by(relationships.value, (r) => ({
      fromId: r.fromId,
      toId: r.toId,
      category: r.category,
      label: r.label,
      mutual: r.mutual,
      description: r.description,
      secret: r.secret,
      validFromChapterId: r.validFromChapterId,
      validToChapterId: r.validToChapterId,
    })),
    plan: Object.fromEntries(
      plans.value.map((p) => [
        p.chapterId,
        { goal: p.goal, castIds: p.castIds, beats: p.beats, foreshadowPlant: p.foreshadowPlant, foreshadowPayoff: p.foreshadowPayoff, treatment: p.treatment, targetWords: p.targetWords },
      ]),
    ),
    foreshadow: by(foreshadows.value, (f) => ({
      title: f.title,
      content: f.content,
      reveal: f.reveal,
      plantChapterId: f.plantChapterId,
      plantAnchor: f.plantAnchor,
      payoffChapterId: f.payoffChapterId,
      payoffAnchor: f.payoffAnchor,
      status: f.status,
    })),
    skill: Object.fromEntries(skills.value.skills.map((s) => [s.skill.id, { name: s.skill.name, enabled: s.skill.enabled, instruction: s.skill.instruction, custom: s.builtinText === null }])),
    avoid: { avoid: { custom: skills.value.avoidPhrasesCustom, phrases: skills.value.avoidPhrases } },
    fact: by(facts.value, (f) => ({ status: f.status, content: f.content })),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const KINDS: readonly Kind[] = ['project', 'volume', 'chapter', 'entity', 'relationship', 'plan', 'foreshadow', 'skill', 'avoid', 'fact'];

/** 卷与章节的样子去掉位置（排在谁后面）：别的章节进出时它也会变。 */
const withoutPosition = (x: unknown): unknown => (x !== null && typeof x === 'object' && 'after' in x ? { ...x, after: null } : x);

/**
 * 前后两份现状的差别。计划与伏笔没有删除它们的动作，章节移入回收站后它的计划不再列出，这类“消失”不算改动。
 * 卷与章节的位置只对 moved 里的（这个动作移动的那一项）算改动：新建、移走或移入回收站一章时，后面那一章排在谁后面也变了，
 * 那是连带的，撤销时把移动的那一项放回去就复原了。
 */
export function diffWork(before: WorkImage, after: WorkImage, moved: ReadonlySet<string> = new Set()): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  for (const kind of KINDS) {
    const b: Readonly<Record<string, unknown>> = before[kind];
    const a: Readonly<Record<string, unknown>> = after[kind];
    for (const id of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const was = b[id] ?? null;
      const now = a[id] ?? null;
      if (same(was, now)) continue;
      if (was !== null && now !== null && !moved.has(id) && same(withoutPosition(was), withoutPosition(now))) continue;
      if (now === null && (kind === 'plan' || kind === 'foreshadow')) continue;
      out.push({ kind, id, before: was, after: now } as ChangeEntry);
    }
  }
  return out;
}

/** 一项改动给作者看的名字。 */
function nameOf(entry: ChangeEntry, image: WorkImage | null): string {
  switch (entry.kind) {
    case 'project':
      return '作品信息';
    case 'avoid':
      return '规避词表';
    case 'writer':
      return `写手写入的《${entry.title}》`;
    case 'text':
      return `写手修订的《${entry.title}》`;
    case 'volume':
      return `卷“${(entry.after ?? entry.before)?.title ?? ''}”`;
    case 'chapter':
      return `《${(entry.after ?? entry.before)?.title ?? ''}》`;
    case 'entity':
      return `设定“${(entry.after ?? entry.before)?.name ?? ''}”`;
    case 'relationship': {
      const r = entry.after ?? entry.before;
      if (r === null) return '关系';
      const name = (id: string) => image?.entity[id]?.name ?? '';
      return `关系“${name(r.fromId)}${r.mutual ? '与' : '是'}${name(r.toId)}${r.mutual ? '：' : '的'}${r.label}”`;
    }
    case 'plan':
      return `《${image?.chapter[entry.id]?.title ?? ''}》的章节计划`;
    case 'foreshadow':
      return `伏笔“${(entry.after ?? entry.before)?.title ?? ''}”`;
    case 'skill':
      return `写作技能“${(entry.after ?? entry.before)?.name ?? ''}”`;
    case 'fact':
      return `候选事实“${(entry.after ?? entry.before)?.content.slice(0, 20) ?? ''}”`;
  }
}

const verb = (entry: ChangeEntry): string => {
  if (entry.kind === 'writer' || entry.kind === 'text') return '';
  if (entry.before === null) return '新建的';
  if (entry.after === null) return '删掉的';
  return '改动的';
};

/** 一批改动的撤销结果：撤销了哪些、哪些没有撤销与原因。 */
export type UndoOutcome = { readonly undone: readonly string[]; readonly skipped: readonly string[]; readonly rebuilt: Readonly<Record<string, string>> };

/**
 * 撤销一批改动（一轮里按执行顺序排列的各个动作的改动，每个动作一组）：倒着一组一组改回。
 * 删掉后重建的设定、卷与关系标识会变，后面用到旧标识的改动按新标识处理。
 */
export async function undoChanges(
  host: UndoHost,
  project: () => SqlPort | null,
  groups: readonly (readonly ChangeEntry[])[],
  earlier: Readonly<Record<string, string>> = {},
): Promise<Result<UndoOutcome, AppError>> {
  const undone: string[] = [];
  const skipped: string[] = [];
  // 之前的撤销重建过的记录：旧标识换成新的（例如先撤销删除设定那一轮、再撤销新建关系那一轮）。
  const remap = new Map<string, string>(Object.entries(earlier));
  const known = new Set(remap.keys());

  for (const group of [...groups].reverse()) {
    const now = await captureWork(host, project());
    if (now === null) return err({ code: 'no_work' });
    // 先改回改动的，再删掉新建的，最后重建删掉的；删除与重建按依赖排序。
    const order: readonly ChangeEntry['kind'][] = ['writer', 'text', 'project', 'chapter', 'volume', 'entity', 'relationship', 'plan', 'foreshadow', 'skill', 'avoid', 'fact'];
    const deleteOrder: readonly ChangeEntry['kind'][] = ['relationship', 'foreshadow', 'plan', 'fact', 'chapter', 'volume', 'entity', 'skill'];
    const recreateOrder: readonly ChangeEntry['kind'][] = ['entity', 'volume', 'chapter', 'relationship'];
    const rank = (list: readonly string[], kind: string) => (list.includes(kind) ? list.indexOf(kind) : list.length);
    const modified = group.filter((e) => e.kind === 'writer' || e.kind === 'text' || (e.before !== null && e.after !== null)).sort((a, b) => rank(order, a.kind) - rank(order, b.kind));
    const created = group.filter((e) => e.kind !== 'writer' && e.kind !== 'text' && e.before === null).sort((a, b) => rank(deleteOrder, a.kind) - rank(deleteOrder, b.kind));
    const removed = group.filter((e) => e.kind !== 'writer' && e.kind !== 'text' && e.after === null).sort((a, b) => rank(recreateOrder, a.kind) - rank(recreateOrder, b.kind));

    for (const entry of [...modified, ...created, ...removed]) {
      const label = `${verb(entry)}${nameOf(entry, now)}`;
      const done = await undoOne(host, entry, now, remap);
      if (done === null) undone.push(entry.kind === 'chapter' && entry.before === null ? `${label}（移入了回收站）` : label);
      else skipped.push(`${label}（${done}）`);
    }
  }
  const rebuilt = Object.fromEntries([...remap].filter(([from]) => !known.has(from)));
  return ok({ undone, skipped, rebuilt });
}

/** 删掉后重建的记录标识会变：把记录里引用到的旧标识换成新的。 */
class Remapper {
  constructor(private readonly id: (x: string | null) => string | null) {}
  volume = (v: VolumeImage): VolumeImage => ({ ...v, after: this.id(v.after) });
  chapter = (c: ChapterImage): ChapterImage => ({ ...c, volumeId: this.id(c.volumeId) });
  relationship = (x: RelationshipFields): RelationshipFields => ({ ...x, fromId: this.id(x.fromId) ?? x.fromId, toId: this.id(x.toId) ?? x.toId });
  plan = (p: PlanFields): PlanFields => ({ ...p, castIds: p.castIds.map((c) => this.id(c) ?? c) });
  /** 改动后的样子（比较用）。 */
  any(entry: Exclude<ChangeEntry, { readonly kind: 'writer' | 'text' }>): unknown {
    if (entry.after === null) return null;
    switch (entry.kind) {
      case 'volume':
        return this.volume(entry.after);
      case 'chapter':
        return this.chapter(entry.after);
      case 'relationship':
        return this.relationship(entry.after);
      case 'plan':
        return this.plan(entry.after);
      case 'project':
      case 'entity':
      case 'foreshadow':
      case 'skill':
      case 'avoid':
      case 'fact':
        return entry.after;
    }
  }
}

/** 撤销一项；返回 null 表示撤销了，否则是没有撤销的原因。 */
async function undoOne(host: UndoHost, entry: ChangeEntry, now: WorkImage, remap: Map<string, string>): Promise<string | null> {
  const id = (x: string | null): string | null => (x === null ? null : (remap.get(x) ?? x));
  const r = new Remapper(id);
  const failed = (r: Result<unknown, AppError>): string | null => (r.ok ? null : describeError(r.error));
  const changedSince = '之后又改过，没有动它';
  const gone = '已经不在了';
  if (entry.kind === 'writer') return failed(await host.rollbackWriter(entry.id));
  if (entry.kind === 'text') return failed(await host.restoreSnapshot(entry.snapshotId));

  const key = id(entry.id) ?? entry.id;
  const current = (now[entry.kind] as Readonly<Record<string, unknown>>)[key] ?? null;
  // 新建或改动的：现在的样子须与助手改完时相同（位置不算：别的章节进出会改变它）。
  if (entry.after !== null) {
    if (current === null) return gone;
    const strip = (x: unknown) => (entry.kind === 'chapter' || entry.kind === 'volume' ? { ...(x as object), after: null } : x);
    if (!same(strip(current), strip(r.any(entry)))) return changedSince;
  }

  switch (entry.kind) {
    case 'project':
      return entry.before === null ? gone : failed(await host.updateWorkInfo(entry.before));
    case 'avoid':
      return entry.before === null ? gone : failed(await host.setAvoidPhrases(entry.before.custom ? entry.before.phrases : null));
    case 'volume': {
      const work = await host.reloadWork();
      if (!work.ok) return describeError(work.error);
      const v = work.value.volumes.find((x) => x.id === key);
      if (entry.before === null) return v === undefined ? gone : failed(await host.deleteVolume(v));
      const b = r.volume(entry.before);
      if (entry.after === null) {
        const known = new Set(work.value.volumes.map((x) => x.id));
        const created = await host.createVolume(b.title, b.after ?? undefined);
        if (!created.ok) return describeError(created.error);
        const fresh = created.value.volumes.find((x) => !known.has(x.id));
        if (fresh === undefined) return '没有建成';
        remap.set(entry.id, fresh.id);
        return b.summary === '' ? null : failed(await host.updateVolume(fresh, { title: b.title, summary: b.summary }));
      }
      if (v === undefined) return gone;
      const a = entry.after;
      if (a.title !== b.title || a.summary !== b.summary) {
        const r = await host.updateVolume(v, { title: b.title, summary: b.summary });
        if (!r.ok) return describeError(r.error);
      }
      if ((a.after ?? null) !== (entry.before.after ?? null)) {
        const again = await host.reloadWork();
        const moved = again.ok ? again.value.volumes.find((x) => x.id === key) : undefined;
        if (moved !== undefined) return failed(await host.moveVolume(moved, b.after));
      }
      return null;
    }
    case 'chapter': {
      const find = async () => {
        const work = await host.reloadWork();
        return work.ok ? ([...work.value.chapters, ...work.value.trashed].find((c) => c.id === key) ?? null) : null;
      };
      const c = await find();
      if (c === null) return gone;
      if (entry.before === null) return c.status === 'trashed' ? null : failed(await host.trashChapter(c));
      if (entry.after === null) return gone;
      const b = r.chapter(entry.before);
      const a = entry.after;
      if (a.trashed && !b.trashed) return failed(await host.restoreChapter(c));
      if (!a.trashed && b.trashed) return failed(await host.trashChapter(c));
      let chapter = c;
      if (a.title !== b.title) {
        const r = await host.renameChapter(chapter, b.title);
        if (!r.ok) return describeError(r.error);
        chapter = (await find()) ?? chapter;
      }
      if (a.summary !== b.summary || a.notes !== b.notes) {
        const r = await host.updateChapterNotes(chapter, { summary: b.summary, notes: b.notes });
        if (!r.ok) return describeError(r.error);
        chapter = (await find()) ?? chapter;
      }
      if (id(a.volumeId) !== b.volumeId || a.after !== b.after) return failed(await host.moveChapter(chapter, { volumeId: b.volumeId, after: b.after }));
      return null;
    }
    case 'entity': {
      const list = await host.listEntities();
      if (!list.ok) return describeError(list.error);
      const e = list.value.find((x) => x.id === key);
      if (entry.before === null) return e === undefined ? gone : failed(await host.deleteEntity(e));
      const b = entry.before;
      if (entry.after === null) {
        const created = await host.createEntity(b.kind, b.name);
        if (!created.ok) return describeError(created.error);
        remap.set(entry.id, created.value.created.id);
        return failed(await host.updateEntity(created.value.created, { description: b.description, aliases: [...b.aliases], attributes: b.attributes }));
      }
      if (e === undefined) return gone;
      if (e.locked) return '是锁定设定，作者解锁后才能改回';
      return failed(await host.updateEntity(e, { kind: b.kind, name: b.name, description: b.description, aliases: [...b.aliases], attributes: b.attributes }));
    }
    case 'relationship': {
      const view = await host.relationsView();
      if (!view.ok) return describeError(view.error);
      const rel = view.value.relationships.find((x) => x.id === key);
      if (entry.before === null) return rel === undefined ? gone : failed(await host.deleteRelationship(rel));
      const b = r.relationship(entry.before);
      if (entry.after === null) {
        const known = new Set(view.value.relationships.map((x) => x.id));
        const added = await host.addRelationship(b);
        if (!added.ok) return describeError(added.error);
        const fresh = added.value.relationships.find((x) => !known.has(x.id));
        if (fresh !== undefined) remap.set(entry.id, fresh.id);
        return null;
      }
      return rel === undefined ? gone : failed(await host.updateRelationship(rel, b));
    }
    case 'plan':
      if (entry.before === null) return failed(await host.deletePlan(key));
      return failed(await host.savePlan(key, r.plan(entry.before)));
    case 'foreshadow': {
      const view = await host.planningView();
      if (!view.ok) return describeError(view.error);
      const f = view.value.foreshadows.find((x) => x.id === key);
      if (f === undefined) return gone;
      if (entry.before === null) return failed(await host.deleteForeshadow(f));
      return failed(await host.updateForeshadow(f, entry.before));
    }
    case 'skill': {
      const view = await host.listWritingSkills();
      if (!view.ok) return describeError(view.error);
      const s = view.value.skills.find((x) => x.skill.id === key)?.skill;
      if (s === undefined) return gone;
      if (entry.before === null) return failed(await host.deleteCustomSkill(s));
      return failed(await host.updateWritingSkill(s, { enabled: entry.before.enabled, instruction: entry.before.instruction }));
    }
    case 'fact': {
      const facts = await host.listFacts();
      if (!facts.ok) return describeError(facts.error);
      const f = facts.value.find((x) => x.id === key);
      if (f === undefined) return gone;
      if (entry.before !== null) return '只撤销助手新记的候选事实';
      if (f.status !== 'candidate') return '作者已经处理过这条事实，没有动它';
      return failed(await host.deleteFact(f));
    }
  }
}

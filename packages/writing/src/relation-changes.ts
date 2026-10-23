// 人物关系随剧情变化（需求 B73 补充）的纯函数：一批章节开始时成立的关系（含待确认的建议推出的），
// 以及把模型找出的变化换成建议——章节与关系的标签换回标识、名字对到人物，对不上的丢弃，同一批里先新增后又改变或结束的合并。
import { relationApplies, type RelationLike } from './relations';
import type { ChapterOrder } from './types';

export type RelationCategory = 'family' | 'romance' | 'mentor' | 'ally' | 'rival' | 'enemy' | 'affiliation' | 'other';
export type ChangeKind = 'relation_add' | 'relation_change' | 'relation_end' | 'cast_enter' | 'cast_exit' | 'cast_return';

/** 一个人物：已有卡片的有 id；待确认的新人物还没有卡片，id 为 null，按名字认。 */
export type Person = { readonly id: string | null; readonly name: string };

export const samePerson = (a: Person, b: Person) => (a.id !== null && b.id !== null ? a.id === b.id : a.name === b.name);
/** 两人之间（不分方向）。 */
const samePair = (a: Person, b: Person, c: Person, d: Person) => (samePerson(a, c) && samePerson(b, d)) || (samePerson(a, d) && samePerson(b, c));

/** 已有的关系中这里用到的部分。 */
export type RelationRecord = RelationLike & {
  readonly category: RelationCategory;
  readonly label: string;
  readonly mutual: boolean;
  readonly description: string;
  readonly secret: boolean;
};

/** 待确认的建议中这里用到的部分（与仓储的建议同形）。 */
export type PendingChange = {
  readonly chapterId: string;
  readonly kind: ChangeKind;
  readonly relationshipId: string | null;
  readonly fromId: string | null;
  readonly fromName: string;
  readonly toId: string | null;
  readonly toName: string;
  readonly category: RelationCategory | null;
  readonly label: string;
  readonly oldLabel: string;
  readonly mutual: boolean;
  readonly secret: boolean;
  readonly description: string;
  readonly validToChapterId: string | null;
};

/** 某一章开始时成立的一条关系：relationshipId 为 null 的是待确认的建议推出的。 */
export type ProjectedRelation = {
  readonly relationshipId: string | null;
  readonly from: Person;
  readonly to: Person;
  readonly category: RelationCategory;
  readonly label: string;
  readonly mutual: boolean;
  readonly description: string;
  readonly secret: boolean;
};

const KIND_RANK: Readonly<Record<ChangeKind, number>> = { cast_enter: 0, relation_add: 1, relation_change: 2, relation_end: 3, cast_exit: 4, cast_return: 5 };

/**
 * 第 index 章开始时成立的关系：已有的关系里在这一章成立的，再按书中顺序叠上这一章之前待确认的建议（新增、改变、结束）。
 * 给模型看“现在的关系”，后面几章找变化时不重复前面已经找到、还没确认的。nameOf 给出设定的名字。
 */
export function projectRelations(records: readonly RelationRecord[], pending: readonly PendingChange[], nameOf: (id: string) => string, index: number, order: ChapterOrder): ProjectedRelation[] {
  const out: ProjectedRelation[] = records
    .filter((r) => relationApplies(r, index, order))
    .map((r) => ({ relationshipId: r.id, from: { id: r.fromId, name: nameOf(r.fromId) }, to: { id: r.toId, name: nameOf(r.toId) }, category: r.category, label: r.label, mutual: r.mutual, description: r.description, secret: r.secret }));
  const earlier = pending
    .filter((p) => p.kind.startsWith('relation_') && (order.get(p.chapterId) ?? Infinity) < index)
    .sort((a, b) => (order.get(a.chapterId) ?? 0) - (order.get(b.chapterId) ?? 0) || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  for (const p of earlier) {
    const from: Person = { id: p.fromId, name: p.fromName };
    const to: Person = { id: p.toId, name: p.toName };
    const target = () => {
      const byId = p.relationshipId === null ? -1 : out.findIndex((r) => r.relationshipId === p.relationshipId);
      if (byId >= 0) return byId;
      const label = p.kind === 'relation_change' ? p.oldLabel : p.label;
      const pair = out.flatMap((r, i) => (samePair(r.from, r.to, from, to) ? [i] : []));
      return pair.find((i) => out[i]?.label === label) ?? (pair.length === 1 ? (pair[0] ?? -1) : -1);
    };
    if (p.kind === 'relation_add') {
      const until = p.validToChapterId === null ? undefined : order.get(p.validToChapterId);
      if (until !== undefined && until < index) continue;
    } else {
      const i = target();
      if (i >= 0) out.splice(i, 1);
      if (p.kind === 'relation_end') continue;
    }
    if (p.category === null) continue;
    out.push({ relationshipId: null, from, to, category: p.category, label: p.label, mutual: p.mutual, description: p.description, secret: p.secret });
  }
  return out;
}

/** 交给模型的这一批章节：label 为 C1、C2……；prevId 是书中的前一章（关系改变时旧的到它为止），没有时为 null。 */
export type ChangeChapter = { readonly label: string; readonly chapterId: string; readonly index: number; readonly prevId: string | null };

/** 交给模型的关系：label 为 R1、R2…… */
export type LabeledRelation = ProjectedRelation & { readonly tag: string };

/** 模型找出的变化（与提示词的输出结构同形）。 */
export type RelationChangeDraft = {
  readonly relations: readonly {
    readonly chapter: string;
    readonly kind: 'add' | 'change' | 'end';
    readonly relation: string;
    readonly from: string;
    readonly to: string;
    readonly category: RelationCategory;
    readonly label: string;
    readonly mutual: boolean;
    readonly description: string;
    readonly secret: boolean;
    readonly reason: string;
  }[];
  readonly cast: readonly { readonly chapter: string; readonly kind: 'enter' | 'exit' | 'return'; readonly name: string; readonly description: string; readonly reason: string }[];
};

/** 换好的一条建议。 */
export type ResolvedChange = {
  readonly kind: ChangeKind;
  readonly chapterId: string;
  readonly relationshipId: string | null;
  /** 关系的一端，或出场、退场、回归的人物。 */
  readonly from: Person;
  /** 关系的另一端；人物的出场、退场与回归为 null。 */
  readonly to: Person | null;
  readonly category: RelationCategory | null;
  readonly label: string;
  readonly oldLabel: string;
  readonly mutual: boolean;
  readonly secret: boolean;
  readonly description: string;
  readonly validToChapterId: string | null;
  readonly reason: string;
};

export type ResolveInput = {
  readonly chapters: readonly ChangeChapter[];
  /** 人物（含待确认的新人物）与别名。 */
  readonly people: readonly (Person & { readonly aliases: readonly string[] })[];
  readonly relations: readonly LabeledRelation[];
  readonly draft: RelationChangeDraft;
  /** 说明里照抄的标签（C2、R3）换成的说法。 */
  readonly rewrite?: (text: string) => string;
};

/**
 * 把模型找出的变化换成建议。丢弃的：章节标签对不上、名字对不上人物、两端是同一人、称谓为空、与已有的关系相同、没有变化、
 * 重复的、已有人物又列为新人物。同一批里先新增、后改变或结束的两人：新增的那条到改变的前一章（或结束的那一章）为止。
 */
export function resolveRelationChanges({ chapters, people, relations, draft, rewrite = (t) => t }: ResolveInput): { readonly changes: ResolvedChange[]; readonly dropped: number } {
  const chapterOf = new Map(chapters.map((c) => [c.label.trim().toUpperCase(), c]));
  const relationOf = new Map(relations.map((r) => [r.tag.trim().toUpperCase(), r]));
  const known = new Map<string, Person>();
  for (const p of people) for (const n of [p.name, ...p.aliases]) if (n.trim() !== '' && !known.has(n.trim())) known.set(n.trim(), { id: p.id, name: p.name });
  let dropped = 0;
  type Item = { readonly at: ChangeChapter; readonly rank: number; readonly seq: number; readonly run: () => void };
  const items: Item[] = [];
  const changes: (ResolvedChange & { at: number })[] = [];
  const text = (t: string) => rewrite(t.trim());
  const base = (at: ChangeChapter, reason: string) => ({ chapterId: at.chapterId, relationshipId: null, oldLabel: '', mutual: false, secret: false, validToChapterId: null, reason: text(reason), at: at.index });

  for (const [seq, c] of draft.cast.entries()) {
    const at = chapterOf.get(c.chapter.trim().toUpperCase());
    if (at === undefined) {
      dropped += 1;
      continue;
    }
    items.push({
      at,
      rank: c.kind === 'enter' ? 0 : 4,
      seq,
      run: () => {
        const name = c.name.trim();
        if (c.kind === 'enter') {
          // 已有的人物（含前面几批找到、还没确认的新人物）不算新出场。
          if (name === '' || known.has(name)) return void (dropped += 1);
          const person: Person = { id: null, name };
          known.set(name, person);
          changes.push({ ...base(at, c.reason), kind: 'cast_enter', from: person, to: null, category: null, label: '', description: text(c.description) });
          return;
        }
        const person = known.get(name);
        const kind = c.kind === 'exit' ? 'cast_exit' : 'cast_return';
        if (person === undefined || changes.some((x) => x.kind === kind && x.chapterId === at.chapterId && samePerson(x.from, person))) return void (dropped += 1);
        changes.push({ ...base(at, c.reason), kind, from: person, to: null, category: null, label: '', description: text(c.description) });
      },
    });
  }

  // 同一批里新增的关系：后面改变或结束同样两人时，接在它上面。
  const added: (ResolvedChange & { at: number })[] = [];
  for (const [seq, r] of draft.relations.entries()) {
    const at = chapterOf.get(r.chapter.trim().toUpperCase());
    if (at === undefined) {
      dropped += 1;
      continue;
    }
    items.push({
      at,
      rank: 1,
      seq,
      run: () => {
        const from = known.get(r.from.trim());
        const to = known.get(r.to.trim());
        const label = r.label.trim();
        if (from === undefined || to === undefined || samePerson(from, to)) return void (dropped += 1);
        const fields = { category: r.category, label, mutual: r.mutual, secret: r.secret, description: text(r.description) };
        const add = () => {
          if (label === '') return void (dropped += 1);
          const exists = relations.some((x) => samePair(x.from, x.to, from, to) && x.label === label) || added.some((x) => x.to !== null && samePair(x.from, x.to, from, to) && x.label === label && x.validToChapterId === null);
          if (exists) return void (dropped += 1);
          const change = { ...base(at, r.reason), kind: 'relation_add' as const, from, to, ...fields };
          changes.push(change);
          added.push(change);
        };
        // 同一批里新增过的同样两人（最近的一条，还没结束的）。
        const earlier = [...added].reverse().find((x) => x.to !== null && x.validToChapterId === null && samePair(x.from, x.to, from, to));
        // 模型指认的关系两端须是这两人，对不上时不信它，按两人重新找。
        const tagged = r.relation.trim() === '' ? undefined : relationOf.get(r.relation.trim().toUpperCase());
        const trusted = tagged !== undefined && samePair(tagged.from, tagged.to, from, to) ? tagged : undefined;
        const target = trusted ?? (earlier === undefined ? onlyBetween(relations, from, to, label) : undefined);
        if (r.kind === 'add') return add();
        if (target === undefined && earlier !== undefined) {
          const i = changes.indexOf(earlier);
          if (r.kind === 'end') {
            changes[i] = { ...earlier, validToChapterId: at.chapterId };
            added[added.indexOf(earlier)] = changes[i]!;
            return;
          }
          if (earlier.at === at.index) {
            // 同一章里新增又改变：只留改变后的样子。
            if (label === '') return void (dropped += 1);
            changes[i] = { ...earlier, ...fields };
            added[added.indexOf(earlier)] = changes[i]!;
            return;
          }
          changes[i] = { ...earlier, validToChapterId: at.prevId };
          added[added.indexOf(earlier)] = changes[i]!;
          return add();
        }
        if (target === undefined) {
          // 找不到原来的关系：改变当作从这一章起的新关系，结束无从说起。
          return r.kind === 'change' ? add() : void (dropped += 1);
        }
        if (r.kind === 'end') {
          // 结束的是原来那条：方向与称谓照原来的。
          changes.push({ ...base(at, r.reason), kind: 'relation_end', relationshipId: target.relationshipId, from: target.from, to: target.to, category: target.category, label: target.label, mutual: target.mutual, secret: target.secret, description: target.description });
          return;
        }
        if (label === '' || (label === target.label && r.category === target.category && r.mutual === target.mutual)) return void (dropped += 1);
        changes.push({ ...base(at, r.reason), kind: 'relation_change', relationshipId: target.relationshipId, from, to, oldLabel: target.label, ...fields });
      },
    });
  }

  items.sort((x, y) => x.at.index - y.at.index || x.rank - y.rank || x.seq - y.seq);
  for (const item of items) item.run();
  const sorted = [...changes].sort((x, y) => x.at - y.at || KIND_RANK[x.kind] - KIND_RANK[y.kind]);
  return { changes: sorted.map(({ at: _at, ...c }) => c), dropped };
}

/** 两人之间唯一的一条关系；有几条时取称谓相同的那条，仍分不出时为 undefined。 */
function onlyBetween(relations: readonly LabeledRelation[], from: Person, to: Person, label: string): LabeledRelation | undefined {
  const pair = relations.filter((r) => samePair(r.from, r.to, from, to));
  return pair.length === 1 ? pair[0] : pair.find((r) => r.label === label);
}

/**
 * 采用改变与结束时找原来的关系：在第 index 章成立、两端是这两人的；hint（模型指认的那条）仍成立时取它，
 * 否则取称谓为 label 的，只有一条时取它。
 */
export function relationToChange<R extends RelationLike & { readonly label: string }>(relations: readonly R[], hint: string | null, fromId: string, toId: string, label: string, index: number, order: ChapterOrder): R | undefined {
  const live = relations.filter((r) => relationApplies(r, index, order) && ((r.fromId === fromId && r.toId === toId) || (r.fromId === toId && r.toId === fromId)));
  return live.find((r) => r.id === hint) ?? live.find((r) => r.label === label) ?? (live.length === 1 ? live[0] : undefined);
}

// 写作类 AI 任务的上下文输入（需求 B18）：从作品中收集作品信息、本章与前面的章节、选区前后的正文、出现的设定与相关事实，
// 交给 packages/context 按预算选入。设定的提及用编辑器的设定名匹配器计算，与正文高亮的规则一致。
import type { WritingContextInput } from '@fudiao/context';
import { createEntityMatcher } from '@fudiao/editor';
import type { Chapter, Entity, Fact, Project, Relationship, StoredModel } from '@fudiao/store';
import { relationApplies } from '@fudiao/writing';

/** 编辑器中的选区（或光标，此时 from 与 to 相同），位置是段落标识加段内下标。 */
export type EditorSelection = {
  readonly from: { readonly paragraphId: string; readonly offset: number };
  readonly to: { readonly paragraphId: string; readonly offset: number };
};

/** 选区前后纳入的正文长度（字符）。 */
export const BEFORE_CHARS = 2_000;
export const AFTER_CHARS = 600;
/** 选区附近：前后各这么多字以内出现的设定相关性更高。 */
const NEAR_CHARS = 300;

/** 没有默认模型时的预算；有默认模型时取上下文长度的 60%，最多 32,000 Token，其余留给输出与提示词。 */
export const DEFAULT_CONTEXT_BUDGET = 8_000;
export const MAX_CONTEXT_BUDGET = 32_000;

export function contextBudget(model: StoredModel | null): number {
  if (model === null) return DEFAULT_CONTEXT_BUDGET;
  return Math.min(Math.floor(model.capabilities.contextWindow * 0.6), MAX_CONTEXT_BUDGET);
}

type Para = { readonly id: string; readonly text: string };

/** 按选区把本章正文分成前文、选中的文字与后文（段落之间以换行连接）；没有选区时从章末开始续写。 */
export function splitAround(paragraphs: readonly Para[], selection: EditorSelection | null): { before: string; selection: string; after: string } {
  const full = paragraphs.map((p) => p.text).join('\n');
  const position = (at: EditorSelection['from']): number | null => {
    let offset = 0;
    for (const p of paragraphs) {
      if (p.id === at.paragraphId) return offset + Math.min(at.offset, p.text.length);
      offset += p.text.length + 1;
    }
    return null;
  };
  const from = selection === null ? null : position(selection.from);
  const to = selection === null ? null : position(selection.to);
  const start = from ?? full.length;
  const end = Math.max(start, to ?? start);
  return {
    before: full.slice(Math.max(0, start - BEFORE_CHARS), start),
    selection: full.slice(start, end),
    after: full.slice(end, end + AFTER_CHARS),
  };
}

export type WritingSources = {
  readonly project: Project;
  /** 正常章节，按目录顺序。 */
  readonly chapters: readonly Chapter[];
  readonly chapterId: string;
  readonly paragraphs: readonly Para[];
  readonly entities: readonly Entity[];
  readonly facts: readonly Fact[];
  /** 人物关系网（B73）；省略时不带关系。 */
  readonly relationships?: readonly Relationship[];
};

export function gatherWritingInput(src: WritingSources, selection: EditorSelection | null): WritingContextInput | null {
  const index = src.chapters.findIndex((c) => c.id === src.chapterId);
  const chapter = src.chapters[index];
  if (chapter === undefined) return null;
  const parts = splitAround(src.paragraphs, selection);
  const chapterText = src.paragraphs.map((p) => p.text).join('\n');
  const near = parts.before.slice(-NEAR_CHARS) + parts.selection + parts.after.slice(0, NEAR_CHARS);

  const matcher = createEntityMatcher(src.entities.map((e) => ({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases })));
  const mentions = new Map<string, number>();
  for (const m of matcher.find(chapterText)) mentions.set(m.entityId, (mentions.get(m.entityId) ?? 0) + 1);
  const nearIds = new Set(matcher.find(near).map((m) => m.entityId));
  const present = src.entities.filter((e) => mentions.has(e.id));
  const presentIds = new Set(present.map((e) => e.id));

  // 适用于本章的事实：起始章节不在本章之后，结束章节不在本章之前；与本章出现的设定有关。
  const at = (id: string | null) => (id === null ? null : src.chapters.findIndex((c) => c.id === id));
  const facts = src.facts.filter((f) => {
    if (f.status === 'rejected') return false;
    const fromIndex = at(f.validFromChapterId);
    const toIndex = at(f.validToChapterId);
    if (fromIndex !== null && fromIndex > index) return false;
    if (toIndex !== null && toIndex >= 0 && toIndex < index) return false;
    return f.subjectIds.some((s) => presentIds.has(s)) || (f.holderId !== null && presentIds.has(f.holderId));
  });

  // 适用于本章、至少一端在本章出现的人物关系。
  const order = new Map(src.chapters.map((c, i) => [c.id, i]));
  const nameOf = new Map(src.entities.map((e) => [e.id, e.name]));
  const relations = (src.relationships ?? []).filter((r) => relationApplies(r, index, order) && (presentIds.has(r.fromId) || presentIds.has(r.toId)));

  return {
    project: { title: src.project.title, genre: src.project.genre, synopsis: src.project.synopsis, outline: src.project.outline },
    chapter: { id: chapter.id, title: chapter.title, summary: chapter.summary, notes: chapter.notes },
    ...parts,
    previousChapters: src.chapters
      .slice(0, index)
      .reverse()
      .map((c) => ({ id: c.id, title: c.title, summary: c.summary })),
    entities: present.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      description: e.description,
      attributes: e.attributes,
      mentions: mentions.get(e.id) ?? 0,
      nearSelection: nearIds.has(e.id),
    })),
    relations: relations.map((r) => ({
      id: r.id,
      from: nameOf.get(r.fromId) ?? '',
      to: nameOf.get(r.toId) ?? '',
      label: r.label,
      mutual: r.mutual,
      description: r.description,
      secret: r.secret,
      bothPresent: presentIds.has(r.fromId) && presentIds.has(r.toId),
    })),
    facts: facts.map((f) => ({
      id: f.id,
      content: f.content,
      kind: f.kind,
      status: f.status === 'confirmed' ? 'confirmed' : f.status === 'needs_review' ? 'needs_review' : 'candidate',
      subjects: f.subjectIds,
    })),
  };
}

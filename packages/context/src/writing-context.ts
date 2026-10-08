// 写作类 AI 任务的上下文构建（需求 B18，施工文档第五章“上下文构建”）：收集候选条目 → 按信息状态过滤 → 按相关性排序 →
// 按预算裁剪，同时产出上下文清单（纳入与排除的条目及原因），供作者查看与增减。纯函数，不访问存储与编辑器。

export type ContextKind = 'project' | 'chapter_notes' | 'before' | 'selection' | 'after' | 'previous_chapter' | 'entity' | 'fact';

export type ContextItem = {
  /** 在一次构建中唯一，作者的增减按它记录，例如 `entity:<设定标识>`。 */
  readonly id: string;
  readonly kind: ContextKind;
  readonly title: string;
  readonly text: string;
  /** 必需的条目（选区与紧邻的正文）不受预算裁剪，作者也不能移除。 */
  readonly required: boolean;
  /** 相关性，越大越优先；同分时按收集顺序。 */
  readonly relevance: number;
  /** 不纳入的原因（例如事实待复核）；为 null 时按预算决定。 */
  readonly blocked: string | null;
};

export type ContextEntry = { readonly item: ContextItem; readonly tokens: number; readonly reason: string };

export type ContextManifest = {
  readonly budget: number;
  readonly usedTokens: number;
  readonly included: readonly ContextEntry[];
  readonly excluded: readonly ContextEntry[];
};

export type ContextOverrides = { readonly include: readonly string[]; readonly exclude: readonly string[] };

export const NO_OVERRIDES: ContextOverrides = { include: [], exclude: [] };

/** Token 估算：按字符数，与 packages/llm 的 estimateInputTokens 相同（对中文偏保守）。 */
export const estimateTokens = (text: string): number => text.length;

/** 输入：由应用层从作品中收集，设定的提及次数也由应用层计算。 */
export type WritingContextInput = {
  readonly project: { readonly title: string; readonly genre: string; readonly synopsis: string; readonly outline: string };
  readonly chapter: { readonly id: string; readonly title: string; readonly summary: string; readonly notes: string };
  /** 选区（没有选区时为空串）与前后的正文。 */
  readonly before: string;
  readonly selection: string;
  readonly after: string;
  /** 之前的章节，从近到远。 */
  readonly previousChapters: readonly { readonly id: string; readonly title: string; readonly summary: string }[];
  /** 本章出现的设定；mentions 为本章中的提及次数，nearSelection 表示在选区附近出现。 */
  readonly entities: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly description: string;
    readonly attributes: readonly { readonly label: string; readonly value: string }[];
    readonly mentions: number;
    readonly nearSelection: boolean;
  }[];
  /** 与本章出现的设定相关、适用于本章的事实。 */
  readonly facts: readonly {
    readonly id: string;
    readonly content: string;
    readonly kind: string;
    readonly status: 'confirmed' | 'candidate' | 'needs_review';
    readonly subjects: readonly string[];
  }[];
};

const KIND_ORDER: readonly ContextKind[] = ['project', 'chapter_notes', 'previous_chapter', 'entity', 'fact', 'before', 'selection', 'after'];

/** 收集候选条目。相关性：选区附近的设定高于只在本章出现的；近的章节高于远的。 */
export function collectWritingCandidates(input: WritingContextInput): ContextItem[] {
  const items: ContextItem[] = [];
  const add = (item: Omit<ContextItem, 'blocked'> & { blocked?: string | null }) => {
    if (item.text.trim() !== '') items.push({ ...item, blocked: item.blocked ?? null });
  };
  const p = input.project;
  add({
    id: 'project',
    kind: 'project',
    title: '作品信息',
    text: [p.genre && `类型：${p.genre}`, p.synopsis && `梗概：${p.synopsis}`, p.outline && `大纲：${p.outline}`].filter(Boolean).join('\n'),
    required: false,
    relevance: 50,
  });
  const c = input.chapter;
  add({
    id: 'chapter_notes',
    kind: 'chapter_notes',
    title: `本章（${c.title}）的梗概与备注`,
    text: [c.summary && `梗概：${c.summary}`, c.notes && `备注：${c.notes}`].filter(Boolean).join('\n'),
    required: false,
    relevance: 90,
  });
  add({ id: 'selection', kind: 'selection', title: '选中的文字', text: input.selection, required: true, relevance: 100 });
  add({ id: 'before', kind: 'before', title: '前文', text: input.before, required: true, relevance: 100 });
  add({ id: 'after', kind: 'after', title: '后文', text: input.after, required: true, relevance: 100 });
  input.previousChapters.forEach((ch, i) =>
    add({ id: `chapter:${ch.id}`, kind: 'previous_chapter', title: `前面的章节：${ch.title}`, text: ch.summary, required: false, relevance: 40 - i }),
  );
  for (const e of input.entities) {
    const lines = [e.description, ...e.attributes.map((a) => `${a.label}：${a.value}`)].filter((x) => x.trim() !== '');
    add({
      id: `entity:${e.id}`,
      kind: 'entity',
      title: `设定：${e.name}`,
      text: lines.length === 0 ? '' : `${e.name}：${lines.join('；')}`,
      required: false,
      relevance: (e.nearSelection ? 80 : 60) + Math.min(e.mentions, 10),
    });
  }
  for (const f of input.facts) {
    add({
      id: `fact:${f.id}`,
      kind: 'fact',
      title: `事实：${f.content.slice(0, 20)}${f.content.length > 20 ? '……' : ''}`,
      text: f.content,
      required: false,
      relevance: 55 + Math.min(f.subjects.length, 5),
      // 只用已确认的事实（施工文档第四章：派生结论须经作者接受）。
      blocked: f.status === 'confirmed' ? null : f.status === 'needs_review' ? '待复核的事实不用' : '未确认的事实不用',
    });
  }
  return items;
}

/**
 * 按预算选入：必需条目总是纳入；作者加入的条目随后（即使超出预算，也纳入并标明）；其余按相关性纳入，放不下的标为超出预算。
 * 作者移除与被阻止的条目不纳入。
 */
export function selectContext(items: readonly ContextItem[], budget: number, overrides: ContextOverrides = NO_OVERRIDES): ContextManifest {
  const include = new Set(overrides.include);
  const exclude = new Set(overrides.exclude);
  const included: ContextEntry[] = [];
  const excluded: ContextEntry[] = [];
  let used = 0;
  const take = (item: ContextItem, reason: string) => {
    const tokens = estimateTokens(item.text);
    used += tokens;
    included.push({ item, tokens, reason });
  };

  for (const item of items.filter((i) => i.required)) take(item, '必需');
  const optional = items
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => !item.required)
    .sort((a, b) => b.item.relevance - a.item.relevance || a.order - b.order)
    .map(({ item }) => item);
  for (const item of optional.filter((i) => include.has(i.id) && i.blocked === null)) {
    take(item, used + estimateTokens(item.text) > budget ? '作者加入（超出预算）' : '作者加入');
  }
  for (const item of optional) {
    if (include.has(item.id) && item.blocked === null) continue;
    const tokens = estimateTokens(item.text);
    if (item.blocked !== null) excluded.push({ item, tokens, reason: item.blocked });
    else if (exclude.has(item.id)) excluded.push({ item, tokens, reason: '作者移除' });
    else if (used + tokens > budget) excluded.push({ item, tokens, reason: '超出预算' });
    else take(item, '相关');
  }
  const order = (e: ContextEntry) => KIND_ORDER.indexOf(e.item.kind);
  return {
    budget,
    usedTokens: used,
    included: [...included].sort((a, b) => order(a) - order(b)),
    excluded,
  };
}

export function buildWritingContext(input: WritingContextInput, budget: number, overrides: ContextOverrides = NO_OVERRIDES): ContextManifest {
  return selectContext(collectWritingCandidates(input), budget, overrides);
}

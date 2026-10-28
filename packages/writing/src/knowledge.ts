// 各出场人物知道什么（需求 B59 补充、B39 补充）的纯函数：写手与按章节计划建推演场景共用。
// 知道的：以他为持有者的人物认知与说法；在场与不在场：本章之前最近几章里已写、有长篇记忆的章，按出现记录分开。
// 不在场只是提示（前文可能写了他事后得知），由提示词说明怎么用。
import { factApplies, type FactRange } from './facts';
import type { ChapterOrder } from './types';

/** 一条事实中这里用到的部分。 */
export type KnowledgeFact = FactRange & {
  readonly kind: 'world' | 'belief' | 'claim';
  readonly holderId: string | null;
  readonly status: string;
};

export type CastKnowledgeInput<F extends KnowledgeFact> = {
  readonly castIds: readonly string[];
  /** 本章在书中的下标。 */
  readonly index: number;
  readonly order: ChapterOrder;
  /** 人物出现过的章节：章节计划的出场人物与长篇记忆的人物状态。 */
  readonly appearances: readonly { readonly chapterId: string; readonly entityId: string }[];
  /** 已写且有长篇记忆的章节：只有这些章才判断在场与不在场。 */
  readonly written: ReadonlySet<string>;
  readonly facts: readonly F[];
  /** 往前看几章，默认 KNOWLEDGE_WINDOW。 */
  readonly window?: number;
};

/** 一个人物在本章之前知道的与在不在场：present、absent 是章节在书中的下标，从远到近。 */
export type CastKnowledge<F> = { readonly knows: readonly F[]; readonly present: readonly number[]; readonly absent: readonly number[] };

/** 在场与不在场往前看几章。 */
export const KNOWLEDGE_WINDOW = 5;

export function knowledgeForCast<F extends KnowledgeFact>(input: CastKnowledgeInput<F>): Map<string, CastKnowledge<F>> {
  const { castIds, index, order, facts } = input;
  const window = input.window ?? KNOWLEDGE_WINDOW;
  const chapterAt = new Map<number, string>();
  for (const [id, i] of order) chapterAt.set(i, id);
  const recent: { readonly index: number; readonly chapterId: string }[] = [];
  for (let i = Math.max(0, index - window); i < index; i++) {
    const chapterId = chapterAt.get(i);
    if (chapterId !== undefined && input.written.has(chapterId)) recent.push({ index: i, chapterId });
  }
  const appeared = new Map<string, Set<string>>();
  for (const a of input.appearances) {
    const set = appeared.get(a.chapterId) ?? new Set<string>();
    set.add(a.entityId);
    appeared.set(a.chapterId, set);
  }
  const result = new Map<string, CastKnowledge<F>>();
  for (const id of castIds) {
    if (result.has(id)) continue;
    const knows = facts.filter((f) => f.holderId === id && f.kind !== 'world' && f.status === 'confirmed' && factApplies(f, index, order));
    const present: number[] = [];
    const absent: number[] = [];
    for (const c of recent) (appeared.get(c.chapterId)?.has(id) === true ? present : absent).push(c.index);
    result.set(id, { knows, present, absent });
  }
  return result;
}

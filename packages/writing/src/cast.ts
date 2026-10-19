// 人物小传与关系网补全（需求 B83）的缺口：纯函数。哪些人物卡片说明为空、在正文里出场却没有任何关系，
// 以及每个人物第一次出场的章节（取自各章长篇记忆的人物状态）。
import type { ChapterOrder } from './types';

export type CastGapInput = {
  readonly characters: readonly { readonly id: string; readonly name: string; readonly description: string }[];
  /** 关系的两端（设定标识）。 */
  readonly relations: readonly { readonly fromId: string; readonly toId: string }[];
  /** 各章长篇记忆里出场的人物：章节 → 人物标识。 */
  readonly appearances: ReadonlyMap<string, readonly string[]>;
  readonly order: ChapterOrder;
};

export type CastGap = {
  readonly id: string;
  readonly name: string;
  /** 说明为空。 */
  readonly noDescription: boolean;
  /** 出场过，却和谁都没有关系。 */
  readonly noRelation: boolean;
  /** 第一次出场的章节；长篇记忆里没有出场过时为 null。 */
  readonly firstChapterId: string | null;
  /** 出场的章数。 */
  readonly chapters: number;
};

export function castGaps({ characters, relations, appearances, order }: CastGapInput): CastGap[] {
  const related = new Set(relations.flatMap((r) => [r.fromId, r.toId]));
  const firstOf = new Map<string, string>();
  const count = new Map<string, number>();
  const chapters = [...appearances.keys()].filter((id) => order.has(id)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const chapterId of chapters) {
    for (const id of new Set(appearances.get(chapterId) ?? [])) {
      if (!firstOf.has(id)) firstOf.set(id, chapterId);
      count.set(id, (count.get(id) ?? 0) + 1);
    }
  }
  return characters
    .map((c) => ({
      id: c.id,
      name: c.name,
      noDescription: c.description.trim() === '',
      noRelation: count.has(c.id) && !related.has(c.id),
      firstChapterId: firstOf.get(c.id) ?? null,
      chapters: count.get(c.id) ?? 0,
    }))
    .filter((g) => g.noDescription || g.noRelation)
    .sort((a, b) => b.chapters - a.chapters);
}

// 人物关系网（需求 B73）的纯函数：某一章适用哪些关系，写手这一章要带哪些关系。
// 只依赖结构，不依赖存储层；章节的先后用书中顺序的下标表示。

/** 一条关系中这里用到的部分。 */
export type RelationLike = {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly validFromChapterId: string | null;
  readonly validToChapterId: string | null;
};

/**
 * 关系在书中第 index 章是否成立：起始章节在这一章或之前、结束章节在这一章或之后；没有给出的一端不限。
 * 起止章节已不在目录里（例如移入回收站）时当作不限。
 */
export function relationApplies(r: RelationLike, index: number, order: ReadonlyMap<string, number>): boolean {
  const from = r.validFromChapterId === null ? undefined : order.get(r.validFromChapterId);
  const to = r.validToChapterId === null ? undefined : order.get(r.validToChapterId);
  return !((from !== undefined && from > index) || (to !== undefined && to < index));
}

/**
 * 写手写第 index 章时带上的关系：在这一章成立、至少一端是出场人物。两端都出场的排在前面，其余按原来的顺序；最多 limit 条。
 */
export function relationsForCast<R extends RelationLike>(relations: readonly R[], castIds: ReadonlySet<string>, index: number, order: ReadonlyMap<string, number>, limit: number): R[] {
  const applicable = relations.filter((r) => relationApplies(r, index, order) && (castIds.has(r.fromId) || castIds.has(r.toId)));
  const both = applicable.filter((r) => castIds.has(r.fromId) && castIds.has(r.toId));
  const one = applicable.filter((r) => !(castIds.has(r.fromId) && castIds.has(r.toId)));
  return [...both, ...one].slice(0, limit);
}

/**
 * 故事时间：故事内部的时间，与系统时间无关（AGENTS.md 规则 22）。
 * 标签是作者写的说法（“第三年春”“雨夜二更”），只用于显示；排序键用于比较与按故事时间筛选。
 * 没有排序键的故事时间不可比较，不参与筛选。
 */
export type StoryTime = { readonly label: string; readonly order: number | null };

export const isStoryTime = (t: StoryTime): boolean => t.order === null || Number.isFinite(t.order);

/** 按排序键比较；任一方没有排序键时为 null。 */
export function compareStoryTime(a: StoryTime, b: StoryTime): -1 | 0 | 1 | null {
  if (a.order === null || b.order === null) return null;
  return a.order < b.order ? -1 : a.order > b.order ? 1 : 0;
}

/** t 是否落在区间内（两端包含，可缺省）；t 或用到的端点没有排序键时为 null。 */
export function withinStoryRange(t: StoryTime, from?: StoryTime, to?: StoryTime): boolean | null {
  if (t.order === null) return null;
  const afterStart = from === undefined ? 0 : compareStoryTime(t, from);
  const beforeEnd = to === undefined ? 0 : compareStoryTime(t, to);
  if (afterStart === null || beforeEnd === null) return null;
  return afterStart >= 0 && beforeEnd <= 0;
}

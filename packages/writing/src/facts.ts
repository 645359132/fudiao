// 事实（需求 B12）在某一章适用与否的纯函数：写手、审核与 AI 上下文共用，三处的判断保持一致。
import type { ChapterOrder } from './types';

/** 一条事实中这里用到的部分：适用的起止章节。 */
export type FactRange = { readonly validFromChapterId: string | null; readonly validToChapterId: string | null };

/**
 * 事实在书中第 index 章是否适用：起始章节在这一章或之前、结束章节在这一章或之后；没有给出的一端不限。
 * 起止章节已不在目录里（例如移入回收站）时当作不限。状态（已确认、待复核等）由调用方另判。
 */
export function factApplies(f: FactRange, index: number, order: ChapterOrder): boolean {
  const from = f.validFromChapterId === null ? undefined : order.get(f.validFromChapterId);
  const to = f.validToChapterId === null ? undefined : order.get(f.validToChapterId);
  return !((from !== undefined && from > index) || (to !== undefined && to < index));
}

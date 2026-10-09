// 章节计划与伏笔账本的规则（需求 B63、B65）：本章要埋、要收、还不能说破的伏笔；计划中的矛盾；下一章写哪章。
import type { ChapterOrder, ForeshadowItem, PlanItem } from './types';

const CLOSED = new Set<ForeshadowItem['status']>(['paid_off', 'dropped']);

export type ChapterForeshadows = {
  readonly toPlant: readonly ForeshadowItem[];
  readonly toPayoff: readonly ForeshadowItem[];
  /** 揭晓内容在本章不得说破的伏笔：尚未回收、不在本章回收、写明了揭晓内容。 */
  readonly mustNotReveal: readonly ForeshadowItem[];
};

export function foreshadowsForChapter(plan: PlanItem, foreshadows: readonly ForeshadowItem[], order: ChapterOrder): ChapterForeshadows {
  const byId = new Map(foreshadows.map((f) => [f.id, f]));
  const pick = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
  const here = order.get(plan.chapterId);
  const payoffHere = new Set(plan.foreshadowPayoff);
  const mustNotReveal = foreshadows.filter((f) => {
    if (CLOSED.has(f.status) || payoffHere.has(f.id) || f.reveal.trim() === '') return false;
    // 回收章节在本章之前（已过期）的伏笔由“到期未回收”提示，不再要求守住。
    const payoff = f.payoffChapterId === null ? undefined : order.get(f.payoffChapterId);
    return payoff === undefined || here === undefined || payoff > here;
  });
  return { toPlant: pick(plan.foreshadowPlant), toPayoff: pick(plan.foreshadowPayoff), mustNotReveal };
}

export type PlanProblem = {
  readonly code: 'unknown_foreshadow' | 'payoff_before_plant' | 'foreshadow_closed';
  readonly foreshadowId: string;
};

/** 计划中与伏笔账本对不上的地方，供作者在章节计划页修正。 */
export function checkPlan(plan: PlanItem, foreshadows: readonly ForeshadowItem[], order: ChapterOrder): PlanProblem[] {
  const byId = new Map(foreshadows.map((f) => [f.id, f]));
  const here = order.get(plan.chapterId);
  const problems: PlanProblem[] = [];
  for (const [ids, payoff] of [
    [plan.foreshadowPlant, false],
    [plan.foreshadowPayoff, true],
  ] as const) {
    for (const id of ids) {
      const f = byId.get(id);
      if (f === undefined) {
        problems.push({ code: 'unknown_foreshadow', foreshadowId: id });
        continue;
      }
      if (CLOSED.has(f.status)) {
        problems.push({ code: 'foreshadow_closed', foreshadowId: id });
        continue;
      }
      const plant = f.plantChapterId === null ? undefined : order.get(f.plantChapterId);
      if (payoff && here !== undefined && plant !== undefined && plant > here) problems.push({ code: 'payoff_before_plant', foreshadowId: id });
    }
  }
  return problems;
}

/** 按书中顺序第一章待写的章节；回收站中的章节不算。 */
export function nextChapterToWrite(plans: readonly PlanItem[], order: ChapterOrder): string | null {
  let best: { id: string; index: number } | null = null;
  for (const p of plans) {
    const index = order.get(p.chapterId);
    if (p.status !== 'todo' || index === undefined) continue;
    if (best === null || index < best.index) best = { id: p.chapterId, index };
  }
  return best?.id ?? null;
}

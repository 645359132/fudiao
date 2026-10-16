// 章节计划与伏笔账本的规则（需求 B63、B65）：本章要埋、要收、还不能说破的伏笔；计划中的矛盾；下一章写哪章。
import type { ChapterOrder, ForeshadowItem, PlanItem } from './types';

const CLOSED = new Set<ForeshadowItem['status']>(['paid_off', 'dropped']);

export type ChapterForeshadows<F extends ForeshadowItem = ForeshadowItem> = {
  readonly toPlant: readonly F[];
  readonly toPayoff: readonly F[];
  /** 揭晓内容在本章不得说破的伏笔：尚未回收、不在本章回收、写明了揭晓内容。 */
  readonly mustNotReveal: readonly F[];
};

/** 传入的伏笔原样返回（调用方的记录可以带更多字段）。 */
export function foreshadowsForChapter<F extends ForeshadowItem>(plan: PlanItem, foreshadows: readonly F[], order: ChapterOrder): ChapterForeshadows<F> {
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
  // 账本里写明在本章埋设或回收的也算：计划先做好、伏笔后来才记进账本时，计划里没有它。按账本顺序接在计划列出的后面。
  const union = (listed: readonly F[], fromLedger: (f: F) => boolean) => [...listed, ...foreshadows.filter((f) => fromLedger(f) && !listed.includes(f))];
  return {
    toPlant: union(pick(plan.foreshadowPlant), (f) => f.status === 'planned' && f.plantChapterId === plan.chapterId),
    toPayoff: union(pick(plan.foreshadowPayoff), (f) => !CLOSED.has(f.status) && f.payoffChapterId === plan.chapterId),
    mustNotReveal,
  };
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

export type ForeshadowSuggestion = { readonly foreshadowId: string; readonly status: 'planted' | 'paid_off'; readonly chapterId: string };

/**
 * 账本状态的建议：埋设或回收的章节已经写完（已写或已审核），而账本中的状态还没有跟上。
 * 只是建议：伏笔有没有真的埋下、回收，由作者看过正文后确认，再改账本。
 */
export function suggestForeshadowStatus(foreshadows: readonly ForeshadowItem[], plans: readonly PlanItem[]): ForeshadowSuggestion[] {
  const written = new Set(plans.filter((p) => p.status === 'written' || p.status === 'reviewed').map((p) => p.chapterId));
  const suggestions: ForeshadowSuggestion[] = [];
  for (const f of foreshadows) {
    if (CLOSED.has(f.status)) continue;
    if (f.payoffChapterId !== null && written.has(f.payoffChapterId)) suggestions.push({ foreshadowId: f.id, status: 'paid_off', chapterId: f.payoffChapterId });
    else if (f.status === 'planned' && f.plantChapterId !== null && written.has(f.plantChapterId)) suggestions.push({ foreshadowId: f.id, status: 'planted', chapterId: f.plantChapterId });
  }
  return suggestions;
}

// 全书体检的伏笔核对（需求 B80）：纯函数。按账本、章节顺序、哪些章已有正文与长篇记忆里的伏笔进展，
// 列出到期未回收、计划埋下却没有迹象、没有定章节的伏笔。只是提示，账本由作者改（B63）。
import type { ChapterOrder, ForeshadowItem } from './types';

export type ForeshadowFinding = {
  readonly foreshadowId: string;
  readonly title: string;
  /** overdue：回收的章节已写好仍未回收；not_planted：埋设的章节已写好，账本仍是计划、记忆里也没有提到；unscheduled：没有定埋设与回收的章节。 */
  readonly problem: 'overdue' | 'not_planted' | 'unscheduled';
  /** 相关的章节（回收或埋设的那一章）；没有定章节时为 null。 */
  readonly chapterId: string | null;
};

export type ForeshadowAuditInput = {
  readonly foreshadows: readonly ForeshadowItem[];
  readonly order: ChapterOrder;
  /** 已有正文的章节。 */
  readonly written: ReadonlySet<string>;
  /** 体检的范围（章节标识）；只核对相关章节在范围内的伏笔，没有定章节的一律列出。 */
  readonly range: ReadonlySet<string>;
  /** 各章长篇记忆里的伏笔进展：章节 → 伏笔 → 进展。 */
  readonly progress: ReadonlyMap<string, Readonly<Record<string, string>>>;
};

const OPEN = new Set(['planned', 'planted']);

export function foreshadowAudit({ foreshadows, order, written, range, progress }: ForeshadowAuditInput): ForeshadowFinding[] {
  const findings: ForeshadowFinding[] = [];
  const mentioned = (id: string, chapterId: string) => (progress.get(chapterId)?.[id] ?? '').trim() !== '';
  for (const f of foreshadows) {
    if (!OPEN.has(f.status)) continue;
    if (f.plantChapterId === null && f.payoffChapterId === null) {
      findings.push({ foreshadowId: f.id, title: f.title, problem: 'unscheduled', chapterId: null });
      continue;
    }
    const payoff = f.payoffChapterId;
    if (payoff !== null && order.has(payoff) && range.has(payoff) && written.has(payoff)) {
      findings.push({ foreshadowId: f.id, title: f.title, problem: 'overdue', chapterId: payoff });
      continue;
    }
    const plant = f.plantChapterId;
    if (f.status === 'planned' && plant !== null && order.has(plant) && range.has(plant) && written.has(plant) && !mentioned(f.id, plant)) {
      findings.push({ foreshadowId: f.id, title: f.title, problem: 'not_planted', chapterId: plant });
    }
  }
  // 按相关章节在书中的顺序，没有定章节的放最后。
  const rank = (x: ForeshadowFinding) => (x.chapterId === null ? Number.MAX_SAFE_INTEGER : (order.get(x.chapterId) ?? Number.MAX_SAFE_INTEGER));
  return findings.sort((a, b) => rank(a) - rank(b));
}

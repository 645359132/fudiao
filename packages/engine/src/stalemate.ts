import type { Action } from '@fudiao/domain';
import type { StalemateKind } from './events';
import type { RoundRecord } from './run-state';

const PASSIVE: ReadonlySet<Action['kind']> = new Set(['wait', 'observe', 'defend']);

// 说话算上内容：对话中每回合都对同一个人说话是常态，只有反复说同样的话才算重复。
const signature = (a: Action) => [a.kind, a.target ?? '', a.item ?? '', a.toZone ?? '', ...(a.utterance?.sentences ?? [])].join('|');

export type StalemateCheck =
  | { readonly kind: 'standoff' | 'repetition' }
  /** 世界状态没有变化但有对话：程序判断不了，交给僵局判断。 */
  | { readonly kind: 'needs_judgement' }
  | null;

/**
 * 僵局的程序判定（M0-07）。records 为按回合排序的记录（含当前回合），
 * lastDetected 为上一次检测到僵局的回合：检测到后窗口重新计数，避免每回合重复提示。
 */
export function detectStalemate(records: readonly RoundRecord[], window: number, lastDetected: number): StalemateCheck {
  const recent = records.filter((r) => r.round > lastDetected).slice(-window);
  if (recent.length < window) return null;
  const unchanged = recent.every((r) => !r.changed);

  if (unchanged && recent.every((r) => r.actions.every((a) => PASSIVE.has(a.kind)))) return { kind: 'standoff' };

  const actors = new Set(recent.flatMap((r) => r.actions.map((a) => a.actor)));
  for (const actor of actors) {
    const sigs = recent.map((r) => r.actions.find((a) => a.actor === actor));
    const first = sigs[0];
    if (first !== undefined && sigs.every((a) => a !== undefined && signature(a) === signature(first)) && !PASSIVE.has(first.kind)) {
      return { kind: 'repetition' };
    }
  }

  const spoke = recent.some((r) => r.occurrences.some((o) => o.kind === 'speak'));
  return unchanged && spoke ? { kind: 'needs_judgement' } : null;
}

/** 各类僵局给作者的建议（需求第五章）：注入事件、调整目标、提高情绪压力、结束场景。 */
export const STALEMATE_SUGGESTION: Readonly<Record<StalemateKind, string>> = {
  standoff: 'inject_event',
  repetition: 'adjust_goal',
  circling: 'inject_event',
  polite_resolution: 'raise_pressure',
  goal_unreachable: 'end_scene',
};

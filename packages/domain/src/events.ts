import { canonicalJson, err, ok, sha256, type Result } from '@novel-writer/shared';
import { applyEffects, type Effect, type InvariantViolation } from './effects';
import type { ActorId } from './ids';
import type { Occurrence } from './occurrence';
import type { Perception } from './perception';
import type { Scene } from './scene/validate';
import { initialState, type SimState } from './world';

/**
 * 领域内核关心的事件。引擎的事件记录还包含提案、裁决确认等，归约时只取这几种。
 * 事件一经写入不修改（硬性规则 8）。
 */
export type DomainEvent =
  | { readonly type: 'RoundStarted'; readonly round: number; readonly stateHash: string }
  | {
      readonly type: 'StateChanged';
      readonly round: number;
      readonly effects: readonly Effect[];
      readonly occurrences: readonly Occurrence[];
    }
  | {
      readonly type: 'PerceptionDelivered';
      readonly round: number;
      readonly actor: ActorId;
      readonly perceptions: readonly Perception[];
    };

type StepError =
  | { readonly code: 'round_mismatch' | 'hash_mismatch' }
  | { readonly code: 'invariant'; readonly violation: InvariantViolation };

/** index 是出错事件在列表中的位置。 */
export type ReplayError = StepError & { readonly index: number };

export const stateHash = (state: SimState): string => sha256(canonicalJson(state));

/** 开始下一回合。哈希取开始前的状态，回放时据此发现分歧。 */
export const startRound = (state: SimState): DomainEvent => ({
  type: 'RoundStarted',
  round: state.round + 1,
  stateHash: stateHash(state),
});

function step(scene: Scene, state: SimState, event: DomainEvent): Result<SimState, StepError> {
  switch (event.type) {
    case 'RoundStarted':
      if (event.round !== state.round + 1) return err({ code: 'round_mismatch' });
      if (event.stateHash !== stateHash(state)) return err({ code: 'hash_mismatch' });
      return ok({ ...state, round: event.round });
    case 'StateChanged': {
      if (event.round !== state.round) return err({ code: 'round_mismatch' });
      const next = applyEffects(scene, state, event.effects);
      return next.ok ? next : err({ code: 'invariant', violation: next.error });
    }
    case 'PerceptionDelivered':
      // M0-03 起由此更新角色认知。
      return event.round === state.round ? ok(state) : err({ code: 'round_mismatch' });
  }
}

export function applyEvent(scene: Scene, state: SimState, event: DomainEvent): Result<SimState, ReplayError> {
  const next = step(scene, state, event);
  return next.ok ? next : err({ index: 0, ...next.error });
}

/** 从快照（或初始状态）出发，只应用记录的效果，不重新裁决、不重新抽取随机数。 */
export function replayFrom(
  scene: Scene,
  snapshot: SimState,
  events: readonly DomainEvent[],
): Result<SimState, ReplayError> {
  let state = snapshot;
  for (const [index, event] of events.entries()) {
    const next = step(scene, state, event);
    if (!next.ok) return err({ index, ...next.error });
    state = next.value;
  }
  return ok(state);
}

export const replay = (scene: Scene, seed: number, events: readonly DomainEvent[]) =>
  replayFrom(scene, initialState(scene, seed), events);

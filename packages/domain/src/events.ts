import { canonicalJson, err, ok, sha256, type Result } from '@novel-writer/shared';
import { applyEffects, type Effect, type InvariantViolation } from './effects';
import { claimsFromOccurrences, knowledgeFromObservations } from './cognition/knowledge';
import type { BeliefsUpdated, Observation } from './cognition/types';
import { applyBeliefsUpdated, type BeliefUpdateError } from './cognition/update';
import type { ActorId } from './ids';
import type { Occurrence } from './occurrence';
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
      /** 按感知通道裁剪后的观察；归约时直接生成认知条目。 */
      readonly observations: readonly Observation[];
    }
  | BeliefsUpdated;

type StepError =
  | { readonly code: 'round_mismatch' | 'hash_mismatch' | 'unknown_actor' }
  | { readonly code: 'invariant'; readonly violation: InvariantViolation }
  | { readonly code: 'invalid_belief_update'; readonly detail: BeliefUpdateError };

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
      if (!next.ok) return err({ code: 'invariant', violation: next.error });
      const claims = { ...next.value.claims };
      for (const claim of claimsFromOccurrences(scene, event.round, event.occurrences)) claims[claim.id] = claim;
      return ok({ ...next.value, claims });
    }
    case 'PerceptionDelivered': {
      if (event.round !== state.round) return err({ code: 'round_mismatch' });
      const existing = state.knowledge[event.actor];
      if (existing === undefined) return err({ code: 'unknown_actor' });
      const added = knowledgeFromObservations(event.actor, event.round, existing, event.observations);
      return ok({ ...state, knowledge: { ...state.knowledge, [event.actor]: [...existing, ...added] } });
    }
    case 'BeliefsUpdated': {
      if (event.round !== state.round) return err({ code: 'round_mismatch' });
      const existing = state.knowledge[event.actor];
      if (existing === undefined) return err({ code: 'unknown_actor' });
      const updated = applyBeliefsUpdated(event.actor, existing, event);
      if (!updated.ok) return err({ code: 'invalid_belief_update', detail: updated.error });
      return ok({ ...state, knowledge: { ...state.knowledge, [event.actor]: updated.value } });
    }
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

import { err, ok, type Result } from '@novel-writer/shared';
import type { Adjudication } from './adjudicate';
import { observe } from './cognition/observation';
import { applyEffects, type Effect, type InvariantViolation } from './effects';
import { replayFrom, type DomainEvent } from './events';
import { triggerOnEntry, type Entry } from './mechanisms';
import type { Occurrence, OccurrenceDraft } from './occurrence';
import { perceive, type Perception } from './perception';
import { checkRulingScope, type RuledOccurrence, type RulingScopeViolation, type SemanticRuling } from './rulings';
import type { Scene } from './scene/validate';
import type { SimState } from './world';

export type CommitError =
  | { readonly code: 'round_mismatch' }
  | { readonly code: 'missing_ruling' | 'unknown_request' | 'duplicate_ruling'; readonly ref: string }
  | ({ readonly requestId: string } & RulingScopeViolation)
  | { readonly code: 'invariant'; readonly requestId?: string; readonly violation: InvariantViolation };

export type RoundCommit = {
  readonly effects: readonly Effect[];
  readonly occurrences: readonly Occurrence[];
  readonly perceptions: readonly Perception[];
  /** 依次追加到事件记录：一条 StateChanged，随后每个收到感知的角色一条 PerceptionDelivered。 */
  readonly events: readonly DomainEvent[];
  readonly nextState: SimState;
};

/**
 * 提交一回合：先应用程序效果，再按请求顺序校验并应用语义裁决，然后检查机关、计算感知。
 * 新状态由产出的事件归约得到，提交与回放走同一条路径。
 */
export function commitRound(
  scene: Scene,
  state: SimState,
  adjudication: Adjudication,
  rulings: readonly SemanticRuling[],
): Result<RoundCommit, CommitError> {
  if (adjudication.round !== state.round) return err({ code: 'round_mismatch' });

  const byRequest = new Map<string, SemanticRuling>();
  for (const r of rulings) {
    if (!adjudication.pending.some((p) => p.id === r.requestId)) {
      return err({ code: 'unknown_request', ref: r.requestId });
    }
    if (byRequest.has(r.requestId)) return err({ code: 'duplicate_ruling', ref: r.requestId });
    byRequest.set(r.requestId, r);
  }
  const missing = adjudication.pending.find((p) => !byRequest.has(p.id));
  if (missing !== undefined) return err({ code: 'missing_ruling', ref: missing.id });

  const program = applyEffects(scene, state, adjudication.effects);
  if (!program.ok) return err({ code: 'invariant', violation: program.error });
  let current = program.value;
  const effects: Effect[] = [...adjudication.effects];
  const drafts: OccurrenceDraft[] = [...adjudication.occurrences];

  for (const request of adjudication.pending) {
    const ruling = byRequest.get(request.id);
    if (ruling === undefined) continue;
    const scope = checkRulingScope(scene, request, state, current, ruling);
    if (!scope.ok) return err({ requestId: request.id, ...scope.error });
    const next = applyEffects(scene, current, ruling.effects);
    if (!next.ok) return err({ code: 'invariant', requestId: request.id, violation: next.error });
    current = next.value;
    effects.push(...ruling.effects);
    for (const o of ruling.occurrences) {
      drafts.push({ kind: 'ruled', ruling: request.id, ...o });
    }
  }

  return finish(scene, state, current, effects, drafts);
}

export type ExternalEvent = {
  readonly effects: readonly Effect[];
  readonly occurrences: readonly RuledOccurrence[];
};

export type ExternalError =
  | { readonly code: 'effect_not_allowed' | 'invalid_occurrence'; readonly index: number }
  | { readonly code: 'invariant'; readonly violation: InvariantViolation };

/**
 * 注入外部事件：作者介入安排的事件或导演提议。效果按与裁决相同的不变式校验，
 * 但不限于某个请求的范围；不能推进随机数。感知按规则分发，机关照常触发。
 */
export function commitExternal(
  scene: Scene,
  state: SimState,
  external: ExternalEvent,
): Result<RoundCommit, ExternalError> {
  const rngIndex = external.effects.findIndex((e) => e.type === 'advanceRng');
  if (rngIndex >= 0) return err({ code: 'effect_not_allowed', index: rngIndex });
  const badOccurrence = external.occurrences.findIndex(
    (o) => o.zones.length === 0 || !Number.isInteger(o.loudness) || o.loudness < 0,
  );
  if (badOccurrence >= 0) return err({ code: 'invalid_occurrence', index: badOccurrence });

  const applied = applyEffects(scene, state, external.effects);
  if (!applied.ok) return err({ code: 'invariant', violation: applied.error });
  const drafts: OccurrenceDraft[] = external.occurrences.map((o) => ({ kind: 'external', ...o }));
  const result = finish(scene, state, applied.value, [...external.effects], drafts);
  return result.ok ? result : err({ code: 'invariant', violation: result.error.violation });
}

/** 两种提交的共同收尾：触发机关、分配标识、计算感知与观察、生成事件并归约出新状态。 */
function finish(
  scene: Scene,
  state: SimState,
  current: SimState,
  effects: Effect[],
  drafts: OccurrenceDraft[],
): Result<RoundCommit, { readonly code: 'invariant'; readonly violation: InvariantViolation }> {
  const entries: Entry[] = effects.flatMap((e) =>
    e.type === 'moveActor' ? [{ actor: e.actor, to: e.to }] : [],
  );
  const traps = triggerOnEntry(scene, current, entries);
  if (!traps.ok) return err({ code: 'invariant', violation: traps.error });
  effects.push(...traps.value.effects);
  drafts.push(...traps.value.occurrences);

  const occurrences: Occurrence[] = drafts.map((o, i) => ({ id: `${state.round}:${state.occurrences + i}`, ...o }));
  const perceptions = occurrences.flatMap((o) => perceive(scene, state.world, o));

  const byId = new Map(occurrences.map((o) => [o.id, o]));
  const recipients = [...new Set(perceptions.map((p) => p.actor))].sort();
  const events: DomainEvent[] = [
    { type: 'StateChanged', round: state.round, effects, occurrences },
    ...recipients.map(
      (actor): DomainEvent => ({
        type: 'PerceptionDelivered',
        round: state.round,
        actor,
        observations: perceptions
          .filter((p) => p.actor === actor)
          .flatMap((p) => {
            const occurrence = byId.get(p.occurrence);
            const zone = state.world.actors[actor]?.zone;
            return occurrence && zone ? [observe(scene, occurrence, p, zone)] : [];
          }),
      }),
    ),
  ];

  const nextState = replayFrom(scene, state, events);
  if (!nextState.ok) {
    // 上面已逐步应用过同样的效果，到这里失败说明归约与提交的实现不一致。
    throw new Error(`提交与回放结果不一致：${JSON.stringify(nextState.error)}`);
  }
  return ok({ effects, occurrences, perceptions, events, nextState: nextState.value });
}

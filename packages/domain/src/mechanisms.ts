import { err, ok, type Result } from '@fudiao/shared';
import { applyEffects, type Effect, type InvariantViolation } from './effects';
import type { ActorId, ZoneId } from './ids';
import type { OccurrenceDraft } from './occurrence';
import type { Scene } from './scene/validate';
import { worsenInjury, type SimState } from './world';

export type Entry = { readonly actor: ActorId; readonly to: ZoneId };

export type Triggered = {
  readonly state: SimState;
  readonly effects: readonly Effect[];
  readonly occurrences: readonly OccurrenceDraft[];
};

/**
 * 按进入顺序检查机关。机关触发一次后失效，因此同一回合的后来者不会再次触发。
 */
export function triggerOnEntry(
  scene: Scene,
  state: SimState,
  entries: readonly Entry[],
): Result<Triggered, InvariantViolation> {
  let current = state;
  const effects: Effect[] = [];
  const occurrences: OccurrenceDraft[] = [];

  for (const { actor, to } of entries) {
    for (const m of scene.mechanisms) {
      if (m.trigger !== 'enter' || m.zone !== to || m.exempt.includes(actor)) continue;
      if (current.world.mechanisms[m.id]?.armed !== true) continue;
      const injury = current.world.actors[actor]?.injury ?? 'none';
      const fired: Effect[] = [
        ...(m.effect.injury > 0
          ? [{ type: 'setInjury', actor, level: worsenInjury(injury, m.effect.injury) } as const]
          : []),
        { type: 'disarmMechanism', mechanism: m.id },
      ];
      const next = applyEffects(scene, current, fired);
      if (!next.ok) return err(next.error);
      current = next.value;
      effects.push(...fired);
      occurrences.push({
        kind: 'trap_triggered',
        actor,
        participants: [actor],
        zones: [to],
        visible: true,
        loudness: m.effect.loudness,
        mechanism: m.id,
      });
    }
  }
  return ok({ state: current, effects, occurrences });
}

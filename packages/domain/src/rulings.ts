import { err, ok, type Result } from '@novel-writer/shared';
import type { RulingRequest } from './adjudicate';
import type { Effect } from './effects';
import type { ActorId, ZoneId } from './ids';
import type { Scene } from './scene/validate';
import type { SimState } from './world';
import { canMove } from './zone-graph';

/** 语义裁决附带的“发生的事”，描述由模型撰写。 */
export type RuledOccurrence = {
  readonly participants: readonly ActorId[];
  readonly zones: readonly ZoneId[];
  readonly visible: boolean;
  readonly loudness: number;
  readonly description: { readonly visual?: string; readonly sound?: string };
};

/** 裁决模型提出、经作者确认（或自动模式下自动接受）的裁决结果。 */
export type SemanticRuling = {
  readonly requestId: string;
  readonly effects: readonly Effect[];
  readonly occurrences: readonly RuledOccurrence[];
};

export type RulingScopeViolation = {
  readonly code: 'effect_not_allowed' | 'out_of_scope' | 'not_adjacent' | 'invalid_occurrence';
  readonly part: 'effect' | 'occurrence';
  readonly index: number;
  readonly ref?: string;
};

/**
 * 裁决只能改变请求涉及的角色与物品，移动只能到相邻区域，不能推进随机数或拆除机关。
 * current 是程序效果与此前裁决应用后的状态；roundStart 是回合开始时的状态。
 */
export function checkRulingScope(
  scene: Scene,
  request: RulingRequest,
  roundStart: SimState,
  current: SimState,
  ruling: SemanticRuling,
): Result<void, RulingScopeViolation> {
  const actors = new Set(request.actors);
  const items = new Set(request.items);
  const zones = new Set<ZoneId>();
  for (const a of request.actors) {
    for (const s of [roundStart, current]) {
      const z = s.world.actors[a]?.zone;
      if (z !== undefined) zones.add(z);
    }
  }

  for (const [index, effect] of ruling.effects.entries()) {
    const fail = (code: RulingScopeViolation['code'], ref?: string) =>
      err<RulingScopeViolation>({ code, part: 'effect', index, ...(ref !== undefined && { ref }) });
    switch (effect.type) {
      case 'moveActor': {
        if (!actors.has(effect.actor)) return fail('out_of_scope', effect.actor);
        const from = current.world.actors[effect.actor]?.zone;
        if (from === undefined || !canMove(scene, current.world.flags, from, effect.to)) {
          return fail('not_adjacent', effect.to);
        }
        break;
      }
      case 'transferItem': {
        if (!items.has(effect.item)) return fail('out_of_scope', effect.item);
        const to = effect.to;
        if (to.kind === 'actor' && !actors.has(to.actor)) return fail('out_of_scope', to.actor);
        if (to.kind === 'zone' && !zones.has(to.zone)) return fail('out_of_scope', to.zone);
        break;
      }
      case 'adjustCounter':
        if (!items.has(effect.item)) return fail('out_of_scope', effect.item);
        break;
      case 'setInjury':
      case 'setActorStatus':
        if (!actors.has(effect.actor)) return fail('out_of_scope', effect.actor);
        break;
      case 'setFlag':
        break;
      case 'disarmMechanism':
      case 'advanceRng':
        return fail('effect_not_allowed', effect.type);
    }
  }

  for (const [index, o] of ruling.occurrences.entries()) {
    const fail = (code: RulingScopeViolation['code'], ref?: string) =>
      err<RulingScopeViolation>({ code, part: 'occurrence', index, ...(ref !== undefined && { ref }) });
    if (o.zones.length === 0 || !Number.isInteger(o.loudness) || o.loudness < 0) {
      return fail('invalid_occurrence');
    }
    const outsider = o.participants.find((a) => !actors.has(a));
    if (outsider !== undefined) return fail('out_of_scope', outsider);
    const elsewhere = o.zones.find((z) => !zones.has(z));
    if (elsewhere !== undefined) return fail('out_of_scope', elsewhere);
  }

  return ok(undefined);
}

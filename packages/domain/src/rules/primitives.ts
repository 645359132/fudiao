import type { ActorId, ItemId, ZoneId } from '../ids';
import type { OnUnmet } from '../scene/schema';
import type { Scene } from '../scene/validate';
import { holds, injuryRank } from '../world';
import { canMove, canSee, edgeBetween } from '../zone-graph';
import type { RuleCheck } from './rule-check';
import { PASS, type CheckResult, type RuleViolation } from './types';

const reject = (violation: RuleViolation): CheckResult => ({ kind: 'reject', violation });
const unmet = (mode: OnUnmet, violation: RuleViolation): CheckResult => ({ kind: mode, violation });

export const knownTarget = (scene: Scene, target: string): boolean =>
  scene.actors.some((a) => a.id === target) ||
  scene.zones.some((z) => z.id === target) ||
  scene.items.some((i) => i.id === target) ||
  scene.mechanisms.some((m) => m.id === target);

/** 行动者存在、在场，且失去行动力时只能等待。 */
export const presence: RuleCheck = (_scene, { world }, action) => {
  const actor = world.actors[action.actor];
  if (actor === undefined) return reject({ code: 'actor_unknown', ref: action.actor });
  if (actor.status === 'withdrawn') return reject({ code: 'actor_withdrawn', ref: action.actor });
  if (actor.injury === 'incapacitated' && action.kind !== 'wait') {
    return reject({ code: 'incapacitated', ref: action.actor });
  }
  return PASS;
};

/** 行动引用的对象与物品必须存在；除拾取外，引用物品就要持有它。 */
export const references: RuleCheck = (scene, { world }, action) => {
  if (action.target !== undefined && !knownTarget(scene, action.target)) {
    return reject({ code: 'target_unknown', ref: action.target });
  }
  if (action.item !== undefined) {
    if (world.items[action.item] === undefined) return reject({ code: 'target_unknown', ref: action.item });
    if (action.kind !== 'take' && !holds(world, action.actor, action.item)) {
      return reject({ code: 'not_holding', ref: action.item });
    }
  }
  return PASS;
};

export const kindSpecific: RuleCheck = (scene, { world }, action) => {
  const here = world.actors[action.actor]?.zone;
  if (here === undefined) return reject({ code: 'actor_unknown', ref: action.actor });

  switch (action.kind) {
    case 'move':
      return checkMove(scene, world.flags, here, action.toZone);
    case 'take': {
      if (action.item === undefined) return reject({ code: 'missing_field', ref: 'item' });
      const location = world.items[action.item]?.location;
      if (location?.kind === 'actor') return reject({ code: 'item_held', ref: action.item });
      if (location?.zone !== here) return reject({ code: 'item_not_here', ref: action.item });
      return PASS;
    }
    case 'drop':
    case 'use_item':
      return action.item === undefined ? reject({ code: 'missing_field', ref: 'item' }) : PASS;
    case 'attack':
      return checkAttack(scene, world, action.actor, here, action.target, action.item);
    case 'speak': {
      const u = action.utterance;
      if (u === undefined) return reject({ code: 'missing_field', ref: 'utterance' });
      if (u.sentences.length === 0) return reject({ code: 'empty_utterance' });
      const delivered = u.deliveredCount;
      if (delivered !== undefined && (!Number.isInteger(delivered) || delivered < 0 || delivered > u.sentences.length)) {
        return reject({ code: 'invalid_delivery' });
      }
      return PASS;
    }
    case 'withdraw':
      return scene.exits.length === 0 || scene.exits.includes(here)
        ? PASS
        : reject({ code: 'not_at_exit', ref: here });
    case 'observe':
    case 'probe':
    case 'defend':
    case 'wait':
    case 'other':
      return PASS;
  }
};

function checkMove(
  scene: Scene,
  flags: Parameters<typeof canMove>[1],
  here: ZoneId,
  to: ZoneId | undefined,
): CheckResult {
  if (to === undefined) return reject({ code: 'missing_field', ref: 'toZone' });
  if (!scene.zones.some((z) => z.id === to)) return reject({ code: 'target_unknown', ref: to });
  if (to === here) return reject({ code: 'same_zone', ref: to });
  if (canMove(scene, flags, here, to)) return PASS;
  const edge = edgeBetween(scene, here, to);
  return edge?.adjacent === true
    ? reject({ code: 'path_blocked', ref: edge.requiresFlag ?? to })
    : reject({ code: 'not_adjacent', ref: to });
}

function checkAttack(
  scene: Scene,
  world: Parameters<typeof holds>[0],
  self: ActorId,
  here: ZoneId,
  target: string | undefined,
  weapon: ItemId | undefined,
): CheckResult {
  if (target === undefined) return reject({ code: 'missing_field', ref: 'target' });
  const victim = world.actors[target as ActorId];
  if (victim === undefined) return reject({ code: 'target_not_actor', ref: target });
  if (target === self) return reject({ code: 'target_self', ref: target });
  if (victim.status === 'withdrawn') return reject({ code: 'target_absent', ref: target });
  const reach = (weapon && scene.items.find((i) => i.id === weapon)?.reach) ?? 'melee';
  if (reach === 'melee') {
    return victim.zone === here ? PASS : reject({ code: 'out_of_reach', ref: target });
  }
  return canSee(scene, here, victim.zone) ? PASS : reject({ code: 'out_of_sight', ref: target });
}

export const injuryLimits: RuleCheck = (scene, { world }, action) => {
  const injury = world.actors[action.actor]?.injury ?? 'none';
  for (const [i, limit] of scene.rules.injuryLimits.entries()) {
    if (limit.actor !== undefined && limit.actor !== action.actor) continue;
    if (injuryRank(injury) < injuryRank(limit.atLeast)) continue;
    const forbidden =
      limit.forbidKinds.includes(action.kind) ||
      (action.item !== undefined && limit.forbidItems.includes(action.item));
    if (forbidden) return reject({ code: 'injury_forbids', rule: `injuryLimits:${i}` });
  }
  return PASS;
};

export const requirements: RuleCheck = (scene, { world }, action) => {
  for (const [i, req] of matchingRequirements(scene, action.target, action.kind)) {
    if (!holds(world, action.actor, req.requiresHolding)) {
      return unmet(req.whenMissing, { code: 'requirement_unmet', rule: `requirements:${i}`, ref: req.requiresHolding });
    }
  }
  return PASS;
};

export const consumption: RuleCheck = (scene, { world }, action) => {
  for (const [i, rule] of matchingConsumption(scene, action.item, action.kind)) {
    const left = world.items[rule.item]?.counters[rule.counter] ?? 0;
    if (left < rule.amount) {
      return unmet(rule.whenEmpty, { code: 'resource_exhausted', rule: `consumption:${i}`, ref: rule.counter });
    }
  }
  return PASS;
};

export function matchingRequirements(
  scene: Scene,
  target: string | undefined,
  kind: Parameters<RuleCheck>[2]['kind'],
): [number, Scene['rules']['requirements'][number]][] {
  if (target === undefined) return [];
  return [...scene.rules.requirements.entries()].filter(
    ([, req]) => req.target === target && (req.kinds === undefined || req.kinds.includes(kind)),
  );
}

export function matchingConsumption(
  scene: Scene,
  item: ItemId | undefined,
  kind: Parameters<RuleCheck>[2]['kind'],
): [number, Scene['rules']['consumption'][number]][] {
  if (item === undefined) return [];
  return [...scene.rules.consumption.entries()].filter(
    ([, rule]) => rule.item === item && rule.kinds.includes(kind),
  );
}

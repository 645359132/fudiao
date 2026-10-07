import { err, ok, type Result } from '@fudiao/shared';
import { deliveredSentences, type Action } from './actions';
import type { Effect, RngDraw } from './effects';
import type { ActorId, ItemId } from './ids';
import type { OccurrenceDraft } from './occurrence';
import { drawInt, type RngState } from './rng';
import { checkAction } from './rules/check';
import { matchingConsumption, matchingRequirements } from './rules/primitives';
import type { RuleViolation } from './rules/types';
import type { Scene } from './scene/validate';
import type { SimState } from './world';

/** 失败尝试照常发生，但没有效果。 */
export type CheckedAction =
  | { readonly action: Action; readonly result: 'pass' }
  | { readonly action: Action; readonly result: 'fail'; readonly violation: RuleViolation };

/** 需要语义裁决的一组相互关联的行动。 */
export type RulingRequest = {
  /** `${回合}:r${序号}` */
  readonly id: string;
  /** 涉及的角色；裁决只能改变这些角色与下列物品。 */
  readonly actors: readonly ActorId[];
  readonly items: readonly ItemId[];
  /** 涉及角色本回合的全部行动，按角色标识排序。 */
  readonly actions: readonly Action[];
  /** 其行动需要裁决的角色。 */
  readonly semantic: readonly ActorId[];
  /** 未声明随机对抗、交给裁决的争夺物品。 */
  readonly contested: readonly ItemId[];
};

export type Adjudication = {
  readonly round: number;
  readonly actions: readonly CheckedAction[];
  /** 程序结算的效果，按角色标识顺序排列。 */
  readonly effects: readonly Effect[];
  readonly occurrences: readonly OccurrenceDraft[];
  readonly pending: readonly RulingRequest[];
};

export type AdjudicationError =
  | { readonly code: 'duplicate_actor'; readonly actor: ActorId }
  | { readonly code: 'rejected_action'; readonly actor: ActorId; readonly violation: RuleViolation };

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 同轮行动的统一裁决。全部基于回合开始时的状态检查，按角色标识的固定顺序处理，
 * 结果与提案到达顺序无关（硬性规则 6）。
 */
export function adjudicate(
  scene: Scene,
  state: SimState,
  actions: readonly Action[],
): Result<Adjudication, AdjudicationError> {
  const sorted = [...actions].sort((a, b) => byString(a.actor, b.actor));
  const checked: CheckedAction[] = [];
  for (const [i, action] of sorted.entries()) {
    if (i > 0 && sorted[i - 1]?.actor === action.actor) {
      return err({ code: 'duplicate_actor', actor: action.actor });
    }
    const result = checkAction(scene, state, action);
    if (result.kind === 'reject') {
      return err({ code: 'rejected_action', actor: action.actor, violation: result.violation });
    }
    checked.push(
      result.kind === 'pass'
        ? { action, result: 'pass' }
        : { action, result: 'fail', violation: result.violation },
    );
  }

  const contests = resolveContests(scene, state, checked);
  const effects: Effect[] = [];
  const occurrences: OccurrenceDraft[] = [];
  const semantic = new Set<ActorId>();
  if (contests.draws.length > 0) {
    effects.push({ type: 'advanceRng', to: contests.rng, draws: contests.draws });
  }

  for (const entry of checked) {
    const { action } = entry;
    const zone = state.world.actors[action.actor]?.zone;
    if (zone === undefined) continue;
    const base = { actor: action.actor, participants: [action.actor], zones: [zone], visible: true } as const;
    const loud = scene.loudness;

    if (entry.result === 'fail') {
      occurrences.push({
        ...base,
        kind: 'failed_attempt',
        attempted: action.kind,
        loudness: loud.failed,
        ...(action.item && { item: action.item }),
        ...(action.target && { target: action.target }),
        violation: entry.violation,
      });
      continue;
    }

    for (const [, rule] of matchingConsumption(scene, action.item, action.kind)) {
      effects.push({ type: 'adjustCounter', item: rule.item, counter: rule.counter, delta: -rule.amount });
    }

    const declared = matchingRequirements(scene, action.target, action.kind).flatMap(([, req]) =>
      req.onSuccess ? [req.onSuccess] : [],
    );
    for (const flag of declared) effects.push({ type: 'setFlag', flag: flag.setFlag, value: flag.value });

    switch (action.kind) {
      case 'move':
        if (action.toZone === undefined) break;
        effects.push({ type: 'moveActor', actor: action.actor, to: action.toZone });
        occurrences.push({ ...base, kind: 'move', zones: [zone, action.toZone], loudness: loud.move });
        break;
      case 'take': {
        if (action.item === undefined) break;
        const outcome = contests.outcome.get(action.actor);
        if (outcome === 'ruling') {
          semantic.add(action.actor);
        } else if (outcome === 'lost') {
          occurrences.push({
            ...base,
            kind: 'failed_attempt',
            attempted: 'take',
            item: action.item,
            loudness: loud.failed,
            violation: { code: 'contest_lost', ref: action.item },
          });
        } else {
          effects.push({ type: 'transferItem', item: action.item, to: { kind: 'actor', actor: action.actor } });
          occurrences.push({ ...base, kind: 'take', item: action.item, loudness: loud.take });
        }
        break;
      }
      case 'drop':
        if (action.item === undefined) break;
        effects.push({ type: 'transferItem', item: action.item, to: { kind: 'zone', zone } });
        occurrences.push({ ...base, kind: 'drop', item: action.item, loudness: loud.drop });
        break;
      case 'use_item': {
        const use = scene.items.find((i) => i.id === action.item)?.use;
        if (use === undefined && declared.length === 0) {
          semantic.add(action.actor);
          break;
        }
        occurrences.push({
          ...base,
          kind: 'use_item',
          loudness: use?.loudness ?? loud.use_item,
          ...(action.item && { item: action.item }),
          ...(action.target && { target: action.target }),
        });
        break;
      }
      case 'observe':
        occurrences.push({ ...base, kind: 'observe', loudness: loud.observe, ...(action.target && { target: action.target }) });
        for (const m of scene.mechanisms) {
          if (m.hidden && m.zone === zone && state.world.mechanisms[m.id]?.armed === true) {
            occurrences.push({ ...base, kind: 'discovered', mechanism: m.id, visible: false, loudness: 0 });
          }
        }
        break;
      case 'defend':
        occurrences.push({ ...base, kind: 'defend', loudness: loud.defend });
        break;
      case 'speak': {
        const u = action.utterance;
        if (u === undefined) break;
        occurrences.push({
          ...base,
          kind: 'speak',
          loudness: loud.speak[u.volume],
          speech: { sentences: deliveredSentences(u), volume: u.volume },
          ...(action.target && { target: action.target }),
        });
        break;
      }
      case 'withdraw':
        effects.push({ type: 'setActorStatus', actor: action.actor, status: 'withdrawn' });
        occurrences.push({ ...base, kind: 'withdraw', loudness: loud.withdraw });
        break;
      case 'wait':
        break;
      case 'attack':
      case 'probe':
      case 'other':
        // 声明了成功效果的前提条件由程序结算，其余交给语义裁决。
        if (declared.length > 0) {
          occurrences.push({ ...base, kind: action.kind, loudness: loud[action.kind], ...(action.target && { target: action.target }) });
        } else {
          semantic.add(action.actor);
        }
        break;
    }
  }

  return ok({
    round: state.round,
    actions: checked,
    effects,
    occurrences,
    pending: groupRequests(state, checked, semantic, contests.ruled),
  });
}

type ContestResolution = {
  readonly outcome: ReadonlyMap<ActorId, 'won' | 'lost' | 'ruling'>;
  readonly ruled: ReadonlyMap<ItemId, readonly ActorId[]>;
  readonly draws: readonly RngDraw[];
  readonly rng: RngState;
};

/** 多人同轮拾取同一物品。按物品标识顺序处理，随机抽取按序推进状态中的随机数。 */
function resolveContests(scene: Scene, state: SimState, checked: readonly CheckedAction[]): ContestResolution {
  const takers = new Map<ItemId, ActorId[]>();
  for (const { action, result } of checked) {
    if (result !== 'pass' || action.kind !== 'take' || action.item === undefined) continue;
    takers.set(action.item, [...(takers.get(action.item) ?? []), action.actor]);
  }

  const outcome = new Map<ActorId, 'won' | 'lost' | 'ruling'>();
  const ruled = new Map<ItemId, readonly ActorId[]>();
  const draws: RngDraw[] = [];
  let rng = state.rng;

  for (const item of [...takers.keys()].sort(byString)) {
    const contenders = takers.get(item) ?? [];
    if (contenders.length < 2) continue;
    if (scene.rules.contests.take === 'ruling') {
      ruled.set(item, contenders);
      for (const a of contenders) outcome.set(a, 'ruling');
      continue;
    }
    const drawn = drawInt(rng, contenders.length);
    rng = drawn.rng;
    draws.push({ purpose: `contest:${item}`, bound: contenders.length, value: drawn.value });
    contenders.forEach((a, i) => outcome.set(a, i === drawn.value ? 'won' : 'lost'));
  }
  return { outcome, ruled, draws, rng };
}

/** 用并查集把相互指向的行动并成一个请求：攻击对象、争夺同一物品。 */
function groupRequests(
  state: SimState,
  checked: readonly CheckedAction[],
  semantic: ReadonlySet<ActorId>,
  ruled: ReadonlyMap<ItemId, readonly ActorId[]>,
): RulingRequest[] {
  const parent = new Map<ActorId, ActorId>();
  const members = new Set<ActorId>(semantic);
  const find = (a: ActorId): ActorId => {
    const p = parent.get(a) ?? a;
    if (p === a) return a;
    const root = find(p);
    parent.set(a, root);
    return root;
  };
  // 根总是取字典序较小者，分组结果与合并顺序无关。
  const union = (a: ActorId, b: ActorId) => {
    members.add(a);
    members.add(b);
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const { action } of checked) {
    if (!semantic.has(action.actor) || action.target === undefined) continue;
    const target = action.target as ActorId;
    if (state.world.actors[target]?.status === 'present') union(action.actor, target);
  }
  for (const contenders of ruled.values()) {
    for (const a of contenders.slice(1)) union(contenders[0]!, a);
  }

  const groups = new Map<ActorId, ActorId[]>();
  for (const a of [...members].sort(byString)) {
    const root = find(a);
    groups.set(root, [...(groups.get(root) ?? []), a]);
  }

  return [...groups.keys()].sort(byString).map((root, index) => {
    const actors = groups.get(root) ?? [];
    const inGroup = new Set(actors);
    const actions = checked.map((c) => c.action).filter((a) => inGroup.has(a.actor));
    const contested = [...ruled.entries()]
      .filter(([, contenders]) => contenders.some((a) => inGroup.has(a)))
      .map(([item]) => item);
    const items = new Set<ItemId>(contested);
    for (const a of actions) if (a.item !== undefined) items.add(a.item);
    for (const [id, item] of Object.entries(state.world.items) as [ItemId, (typeof state.world.items)[ItemId]][]) {
      if (item.location.kind === 'actor' && inGroup.has(item.location.actor)) items.add(id);
    }
    return {
      id: `${state.round}:r${index}`,
      actors,
      items: [...items].sort(byString),
      actions,
      semantic: actors.filter((a) => semantic.has(a)),
      contested: contested.sort(byString),
    };
  });
}

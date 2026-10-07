import type { Action } from '../actions';
import type { Scene } from '../scene/validate';
import type { SimState } from '../world';
import {
  consumption,
  injuryLimits,
  kindSpecific,
  presence,
  references,
  requirements,
} from './primitives';
import type { RuleCheck } from './rule-check';
import { PASS, type CheckResult } from './types';

export type { RuleCheck } from './rule-check';
export type { CheckResult, RuleViolation, RuleViolationCode } from './types';

// 责任链：按顺序检查，第一个不通过的结果即为结论。
const CHAIN: readonly RuleCheck[] = [
  presence,
  references,
  kindSpecific,
  injuryLimits,
  requirements,
  consumption,
];

/** 按回合开始时的状态检查行动前提。 */
export function checkAction(scene: Scene, state: SimState, action: Action): CheckResult {
  for (const rule of CHAIN) {
    const result = rule(scene, state, action);
    if (result.kind !== 'pass') return result;
  }
  return PASS;
}

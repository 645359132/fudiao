export type RuleViolationCode =
  | 'actor_unknown'
  | 'actor_withdrawn'
  | 'incapacitated'
  | 'missing_field'
  | 'target_unknown'
  | 'target_not_actor'
  | 'target_self'
  | 'target_absent'
  | 'same_zone'
  | 'not_adjacent'
  | 'path_blocked'
  | 'item_not_here'
  | 'item_held'
  | 'not_holding'
  | 'out_of_reach'
  | 'out_of_sight'
  | 'not_at_exit'
  | 'empty_utterance'
  | 'invalid_delivery'
  | 'injury_forbids'
  | 'requirement_unmet'
  | 'resource_exhausted'
  | 'contest_lost';

export type RuleViolation = {
  readonly code: RuleViolationCode;
  /** 触发的场景规则，例如 `consumption:0`；内置检查为空。 */
  readonly rule?: string;
  readonly ref?: string;
};

/** reject：提案非法，请求角色修正；fail：行动照常发生，但以失败告终。 */
export type CheckResult =
  | { readonly kind: 'pass' }
  | { readonly kind: 'reject'; readonly violation: RuleViolation }
  | { readonly kind: 'fail'; readonly violation: RuleViolation };

export const PASS: CheckResult = { kind: 'pass' };

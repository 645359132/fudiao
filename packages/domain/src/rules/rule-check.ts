import type { Action } from '../actions';
import type { Scene } from '../scene/validate';
import type { SimState } from '../world';
import type { CheckResult } from './types';

// 与 types.ts 分开：types.ts 被认知类型引用，不能依赖世界状态，否则形成循环依赖。
export type RuleCheck = (scene: Scene, state: SimState, action: Action) => CheckResult;

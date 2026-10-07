// 测试辅助：直接用效果构造局面。仅供测试使用。
import { applyEffects, type Effect } from '../effects';
import type { Scene } from '../scene/validate';
import type { SimState } from '../world';

export function withEffects(scene: Scene, state: SimState, effects: readonly Effect[]): SimState {
  const result = applyEffects(scene, state, effects);
  if (!result.ok) throw new Error(`测试局面无效：${JSON.stringify(result.error)}`);
  return result.value;
}

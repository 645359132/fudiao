// 测试辅助：裁决并提交一回合。仅供测试使用。
import type { Action } from '../actions';
import { adjudicate } from '../adjudicate';
import { commitRound, type RoundCommit } from '../commit';
import type { SemanticRuling } from '../rulings';
import type { Scene } from '../scene/validate';
import type { SimState } from '../world';
import { warehouse } from './warehouse';

export function run(
  scene: Scene,
  state: SimState,
  actions: readonly Action[],
  rulings: readonly SemanticRuling[] = [],
): RoundCommit {
  const adjudication = adjudicate(scene, state, actions);
  if (!adjudication.ok) throw new Error(JSON.stringify(adjudication.error));
  const commit = commitRound(scene, state, adjudication.value, rulings);
  if (!commit.ok) throw new Error(JSON.stringify(commit.error));
  return commit.value;
}

/** 废仓库加一名站在仓库中央的巡夜人，用来观察受众与裁决范围。 */
export const crowded = (): Scene =>
  warehouse((s) => {
    s.actors.push({ id: 'watchman', name: '巡夜人', zone: 'center' });
  });

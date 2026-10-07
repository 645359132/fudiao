// 测试辅助：随机运行若干回合。仅供测试使用。
import { adjudicate } from '../adjudicate';
import { commitRound } from '../commit';
import { applyEvent, startRound, type DomainEvent } from '../events';
import type { Scene } from '../scene/validate';
import { initialState, type SimState } from '../world';
import { deepFreeze, randomActions, randomRulings, type Tape } from './arbitraries';

export type Simulation = {
  readonly events: readonly DomainEvent[];
  /** 每回合开始前的状态与此时的事件数，用作快照。 */
  readonly snapshots: readonly { readonly state: SimState; readonly eventCount: number }[];
  readonly final: SimState;
};

/** 运行若干回合。每一步都冻结状态，任何对不可变数据的修改都会抛出异常。 */
export function simulate(scene: Scene, seed: number, rounds: number, tape: Tape): Simulation {
  let state = deepFreeze(initialState(scene, seed));
  const events: DomainEvent[] = [];
  const snapshots: { state: SimState; eventCount: number }[] = [];

  for (let r = 0; r < rounds; r++) {
    snapshots.push({ state, eventCount: events.length });
    const started = startRound(state);
    const next = applyEvent(scene, state, started);
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    events.push(started);
    state = deepFreeze(next.value);

    const actions = deepFreeze(randomActions(scene, state, tape));
    const adjudication = adjudicate(scene, state, actions);
    if (!adjudication.ok) throw new Error(JSON.stringify(adjudication.error));
    const rulings = deepFreeze(randomRulings(scene, state, adjudication.value, tape));
    const commit = commitRound(scene, state, deepFreeze(adjudication.value), rulings);
    if (!commit.ok) throw new Error(JSON.stringify(commit.error));
    events.push(...commit.value.events);
    state = deepFreeze(commit.value.nextState);
  }
  return { events, snapshots, final: state };
}

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { adjudicate } from './adjudicate';
import { commitRound } from './commit';
import { applyEvent, replay, replayFrom, startRound, stateHash, type DomainEvent } from './events';
import type { ActorId } from './ids';
import type { Scene } from './scene/validate';
import { deepFreeze, randomActions, randomRulings, sceneArb, Tape, tapeArb } from './testing/arbitraries';
import { initialState, type SimState } from './world';

type Simulation = {
  readonly events: readonly DomainEvent[];
  /** 每回合开始前的状态与此时的事件数，用作快照。 */
  readonly snapshots: readonly { readonly state: SimState; readonly eventCount: number }[];
  readonly final: SimState;
};

/** 运行若干回合。每一步都冻结状态，任何对不可变数据的修改都会抛出异常。 */
function simulate(scene: Scene, seed: number, rounds: number, tape: Tape): Simulation {
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

const seedArb = fc.integer({ min: 0, max: 0xffffffff });
const roundsArb = fc.integer({ min: 1, max: 6 });

describe('领域内核的属性', () => {
  it('同轮行动：打乱提案到达顺序，裁决与提交结果相同', () => {
    fc.assert(
      fc.property(sceneArb, seedArb, roundsArb, tapeArb, (scene, seed, rounds, values) => {
        const tape = new Tape(values);
        const { final } = simulate(scene, seed, rounds, tape);
        const state = { ...final, round: final.round + 1 };
        const actions = randomActions(scene, state, tape);
        const shuffled = [...actions];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = tape.next() % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }

        const a = adjudicate(scene, state, actions);
        const b = adjudicate(scene, state, shuffled);
        expect(b).toEqual(a);
        if (!a.ok || !b.ok) return;

        const rulings = randomRulings(scene, state, a.value, tape);
        expect(commitRound(scene, state, b.value, [...rulings].reverse())).toEqual(
          commitRound(scene, state, a.value, rulings),
        );
      }),
    );
  });

  it('重放与快照一致：从初始状态或任一回合快照重放，得到相同的状态与哈希', () => {
    fc.assert(
      fc.property(sceneArb, seedArb, roundsArb, tapeArb, fc.nat(), (scene, seed, rounds, values, pick) => {
        const { events, snapshots, final } = simulate(scene, seed, rounds, new Tape(values));

        const full = replay(scene, seed, events);
        expect(full).toEqual({ ok: true, value: final });

        const snapshot = snapshots[pick % snapshots.length]!;
        const partial = replayFrom(scene, snapshot.state, events.slice(snapshot.eventCount));
        expect(partial.ok && stateHash(partial.value)).toBe(stateHash(final));
      }),
    );
  });

  it('世界状态一致：每件物品恰有一处位置，同一物品最多一个持有者，计数不为负', () => {
    fc.assert(
      fc.property(sceneArb, seedArb, roundsArb, tapeArb, (scene, seed, rounds, values) => {
        const { snapshots, final } = simulate(scene, seed, rounds, new Tape(values));
        for (const state of [...snapshots.map((s) => s.state), final]) {
          const { world } = state;
          for (const spec of scene.items) {
            const item = world.items[spec.id];
            expect(item).toBeDefined();
            if (item === undefined) continue;
            const loc = item.location;
            if (loc.kind === 'actor') expect(world.actors[loc.actor]).toBeDefined();
            else expect(scene.zones.some((z) => z.id === loc.zone)).toBe(true);

            const holders = (Object.keys(world.actors) as ActorId[]).filter(
              (a) => loc.kind === 'actor' && loc.actor === a,
            );
            expect(holders.length).toBeLessThanOrEqual(1);

            for (const value of Object.values(item.counters)) {
              expect(Number.isInteger(value)).toBe(true);
              expect(value).toBeGreaterThanOrEqual(0);
            }
          }
        }
      }),
    );
  });

  it('语义裁决请求包含语义行动所指向的在场角色，且每个角色至多属于一个请求', () => {
    fc.assert(
      fc.property(sceneArb, seedArb, roundsArb, tapeArb, (scene, seed, rounds, values) => {
        const tape = new Tape(values);
        const { final } = simulate(scene, seed, rounds, tape);
        const state = { ...final, round: final.round + 1 };
        const result = adjudicate(scene, state, randomActions(scene, state, tape));
        if (!result.ok) throw new Error(JSON.stringify(result.error));

        const seen = new Set<ActorId>();
        for (const request of result.value.pending) {
          for (const a of request.actors) {
            expect(seen.has(a)).toBe(false);
            seen.add(a);
          }
          for (const action of request.actions) {
            if (!request.semantic.includes(action.actor) || action.target === undefined) continue;
            if (state.world.actors[action.target as ActorId]?.status === 'present') {
              expect(request.actors).toContain(action.target);
            }
          }
        }
      }),
    );
  });

  it('回放不重新抽取随机数：随机数状态只随记录的效果变化', () => {
    fc.assert(
      fc.property(sceneArb, seedArb, roundsArb, tapeArb, (scene, seed, rounds, values) => {
        const { events, final } = simulate(scene, seed, rounds, new Tape(values));
        const recorded = events.flatMap((e) =>
          e.type === 'StateChanged' ? e.effects.filter((x) => x.type === 'advanceRng') : [],
        );
        const expected = recorded.at(-1)?.to ?? initialState(scene, seed).rng;
        expect(final.rng).toEqual(expected);
      }),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { applyEvent } from '../events';
import { crowded, run } from '../testing/round';
import { withEffects } from '../testing/state';
import { A, P, zone } from '../testing/warehouse';
import { initialState, type SimState } from '../world';
import { screenSecretInferences } from './evidence';
import { planBeliefUpdate } from './update';
import type { ActorId } from '../ids';

const scene = crowded();
const start: SimState = { ...initialState(scene, 3), round: 1 };

/** 让角色提出一条推测，返回应用后的状态与新条目。 */
function infer(state: SimState, actor: ActorId, text: string, about: string[]) {
  const planned = planBeliefUpdate(scene, state, actor, { add: [{ text, confidence: 0.6, about }] });
  if (!planned.ok) throw new Error(JSON.stringify(planned.error));
  const next = applyEvent(scene, state, planned.value);
  if (!next.ok) throw new Error(JSON.stringify(next.error));
  return { state: next.value, items: planned.value.added };
}

describe('证据链筛选', () => {
  it('没有相关观察却推测出与秘密相关的内容：被筛出，证据为空', () => {
    const { state, items } = infer(start, P, '南门恐怕有埋伏', ['south_gate']);
    expect(screenSecretInferences(scene, state, P, items)).toEqual([
      { secret: 'tripwire_secret', inference: items[0]!.id, evidence: [] },
    ]);
  });

  it('知道秘密的角色不被筛出', () => {
    const { state, items } = infer(start, A, '主角会从南门走', ['south_gate']);
    expect(screenSecretInferences(scene, state, A, items)).toEqual([]);
  });

  it('与秘密无关的推测不被筛出', () => {
    const { state, items } = infer(start, P, '账房里可能有账本', ['office']);
    expect(screenSecretInferences(scene, state, P, items)).toEqual([]);
  });

  it('附上涉及同一对象的观察作为可能的证据，由命中判断决定是否充分', () => {
    const atGate = withEffects(scene, start, [{ type: 'moveActor', actor: P, to: zone('south_gate') }]);
    const looked = run(scene, atGate, [{ actor: P, kind: 'observe' }]).nextState;
    const { state, items } = infer({ ...looked, round: 2 }, P, '南门有绊索', ['south_gate', 'tripwire']);
    const [candidate] = screenSecretInferences(scene, state, P, items);
    expect(candidate?.evidence.length).toBeGreaterThan(0);
    const evidence = (state.knowledge[P] ?? []).filter((k) => candidate?.evidence.includes(k.id));
    expect(evidence.every((k) => k.modality !== 'inferred')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { applyEvent, replay, startRound, stateHash } from './events';
import { warehouse, zone, P } from './testing/warehouse';
import { initialState } from './world';

const scene = warehouse();
const start = initialState(scene, 5);

describe('领域事件与归约', () => {
  it('RoundStarted 记录开始前的状态哈希并推进回合号', () => {
    const event = startRound(start);
    expect(event).toEqual({ type: 'RoundStarted', round: 1, stateHash: stateHash(start) });
    expect(applyEvent(scene, start, event)).toEqual({ ok: true, value: { ...start, round: 1 } });
  });

  it('状态哈希与键顺序无关，状态不同则哈希不同', () => {
    const reordered = { ...start, world: { flags: start.world.flags, mechanisms: start.world.mechanisms, items: start.world.items, actors: start.world.actors } };
    expect(stateHash(reordered)).toBe(stateHash(start));
    expect(stateHash({ ...start, round: 1 })).not.toBe(stateHash(start));
  });

  it('回放时状态哈希不符即报错', () => {
    const result = replay(scene, 5, [{ type: 'RoundStarted', round: 1, stateHash: 'deadbeef' }]);
    expect(result).toEqual({ ok: false, error: { index: 0, code: 'hash_mismatch' } });
  });

  it('回合号不连续即报错', () => {
    const result = replay(scene, 5, [{ type: 'RoundStarted', round: 2, stateHash: stateHash(start) }]);
    expect(result).toEqual({ ok: false, error: { index: 0, code: 'round_mismatch' } });
  });

  it('StateChanged 只能属于当前回合', () => {
    const result = replay(scene, 5, [
      startRound(start),
      { type: 'StateChanged', round: 2, effects: [], occurrences: [] },
    ]);
    expect(result).toEqual({ ok: false, error: { index: 1, code: 'round_mismatch' } });
  });

  it('记录的效果违反不变式时报错', () => {
    const result = replay(scene, 5, [
      startRound(start),
      { type: 'StateChanged', round: 1, effects: [{ type: 'moveActor', actor: P, to: zone('roof') }], occurrences: [] },
    ]);
    expect(result).toEqual({
      ok: false,
      error: { index: 1, code: 'invariant', violation: expect.objectContaining({ code: 'unknown_ref' }) },
    });
  });
});

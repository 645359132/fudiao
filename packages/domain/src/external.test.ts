import { describe, expect, it } from 'vitest';
import { commitExternal } from './commit';
import { replayFrom } from './events';
import type { FlagKey } from './ids';
import { crowded } from './testing/round';
import { A, P, actor, zone } from './testing/warehouse';
import { initialState, type SimState } from './world';

const W = actor('watchman');
const scene = crowded();
const start: SimState = { ...initialState(scene, 3), round: 2 };

describe('外部事件注入', () => {
  it('按感知规则分发：看得见的看到，听得见的听到', () => {
    const result = commitExternal(scene, start, {
      effects: [],
      occurrences: [
        { participants: [], zones: [zone('office')], visible: true, loudness: 3, description: { visual: '账房的灯忽然灭了', sound: '账房里传来瓷器碎裂声' } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurrences).toEqual([expect.objectContaining({ id: '2:0', kind: 'external' })]);
    // 中央与账房互相看不见；声音经衰减 2 的边到中央，余量 1。
    const toP = result.value.perceptions.filter((p) => p.actor === P);
    expect(toP).toEqual([expect.objectContaining({ saw: false, heard: true })]);
    // 南门离账房更远：中央 2 加 1 为 3，余量 0，听不到。
    expect(result.value.perceptions.filter((p) => p.actor === A)).toEqual([]);
  });

  it('应用效果并检查不变式，新状态与回放一致', () => {
    const result = commitExternal(scene, start, {
      effects: [{ type: 'setFlag', flag: 'office_open' as FlagKey, value: true }],
      occurrences: [{ participants: [W], zones: [zone('center')], visible: true, loudness: 1, description: { visual: '巡夜人打开了账房的门' } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextState.world.flags['office_open' as FlagKey]).toBe(true);
    expect(replayFrom(scene, start, result.value.events)).toEqual({ ok: true, value: result.value.nextState });
  });

  it('外部事件不能推进随机数', () => {
    const result = commitExternal(scene, start, {
      effects: [{ type: 'advanceRng', to: [1, 2, 3, 4], draws: [] }],
      occurrences: [],
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'effect_not_allowed' }) });
  });

  it('违反不变式的效果被拒绝', () => {
    const result = commitExternal(scene, start, {
      effects: [{ type: 'moveActor', actor: P, to: zone('roof') }],
      occurrences: [],
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'invariant' }) });
  });

  it('外部事件造成的移动同样会触发机关', () => {
    const result = commitExternal(scene, start, {
      effects: [{ type: 'moveActor', actor: P, to: zone('south_gate') }],
      occurrences: [{ participants: [P], zones: [zone('center')], visible: true, loudness: 2, description: { visual: '一阵穿堂风把主角推向南门' } }],
    });
    expect(result.ok && result.value.occurrences.map((o) => o.kind)).toEqual(['external', 'trap_triggered']);
  });
});

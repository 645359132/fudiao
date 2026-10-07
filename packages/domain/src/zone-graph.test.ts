import { describe, expect, it } from 'vitest';
import type { FlagKey } from './ids';
import { canMove, canSee, soundReach } from './zone-graph';
import { warehouse, zone } from './testing/warehouse';

const scene = warehouse();
const closed: Readonly<Record<FlagKey, boolean>> = { ['office_open' as FlagKey]: false };
const open: Readonly<Record<FlagKey, boolean>> = { ['office_open' as FlagKey]: true };

describe('区域图', () => {
  it('同区域与有可见边的区域互相可见，视线不传递', () => {
    expect(canSee(scene, zone('center'), zone('center'))).toBe(true);
    expect(canSee(scene, zone('center'), zone('shelves'))).toBe(true);
    expect(canSee(scene, zone('shelves'), zone('center'))).toBe(true);
    expect(canSee(scene, zone('shelves'), zone('south_gate'))).toBe(false);
  });

  it('只能移动到相邻且可通行的区域', () => {
    expect(canMove(scene, closed, zone('center'), zone('shelves'))).toBe(true);
    expect(canMove(scene, closed, zone('shelves'), zone('south_gate'))).toBe(false);
    expect(canMove(scene, closed, zone('center'), zone('center'))).toBe(false);
    expect(canMove(scene, closed, zone('center'), zone('office'))).toBe(false);
    expect(canMove(scene, open, zone('office'), zone('center'))).toBe(true);
  });

  it('声音沿最短衰减路径传播，只保留余量大于零的区域', () => {
    expect(soundReach(scene, [zone('shelves')], 5)).toEqual({
      shelves: 5,
      center: 4,
      south_gate: 3,
      office: 2,
    });
    expect(soundReach(scene, [zone('shelves')], 2)).toEqual({ shelves: 2, center: 1 });
    expect(soundReach(scene, [zone('shelves')], 0)).toEqual({});
  });

  it('多个发声区域取最大余量', () => {
    expect(soundReach(scene, [zone('shelves'), zone('center')], 1)).toEqual({
      shelves: 1,
      center: 1,
    });
  });

  it('sound 为 null 的边阻断声音', () => {
    const muffled = warehouse((s) => {
      for (const e of s.edges ?? []) if (e.between.includes('office')) e.sound = null;
    });
    expect(soundReach(muffled, [zone('center')], 10)).not.toHaveProperty('office');
  });
});

import type { FlagKey, ZoneId } from './ids';
import type { EdgeSpec } from './scene/schema';
import type { Scene } from './scene/validate';

export function edgeBetween(scene: Scene, a: ZoneId, b: ZoneId): EdgeSpec | undefined {
  return scene.edges.find(
    ({ between: [x, y] }) => (x === a && y === b) || (x === b && y === a),
  );
}

/** 两个区域互相可见：同一区域，或有一条可见的边。视线不传递。 */
export function canSee(scene: Scene, a: ZoneId, b: ZoneId): boolean {
  return a === b || edgeBetween(scene, a, b)?.visible === true;
}

/** 一回合内能否从 from 移动到 to：相邻，且边要求的标记已满足。 */
export function canMove(
  scene: Scene,
  flags: Readonly<Record<FlagKey, boolean>>,
  from: ZoneId,
  to: ZoneId,
): boolean {
  if (from === to) return false;
  const edge = edgeBetween(scene, from, to);
  if (edge?.adjacent !== true) return false;
  return edge.requiresFlag === undefined || flags[edge.requiresFlag] === true;
}

/**
 * 从若干发声区域出发，按边的衰减累计（最短路径），返回余量大于零的区域及其余量。
 * 最短距离唯一，结果与遍历顺序无关。
 */
export function soundReach(
  scene: Scene,
  sources: readonly ZoneId[],
  loudness: number,
): Readonly<Record<ZoneId, number>> {
  const cost = new Map<ZoneId, number>();
  for (const s of sources) cost.set(s, 0);
  const done = new Set<ZoneId>();

  for (;;) {
    let current: ZoneId | undefined;
    let best = Infinity;
    for (const [zone, c] of cost) {
      if (!done.has(zone) && c < best) {
        best = c;
        current = zone;
      }
    }
    if (current === undefined || best >= loudness) break;
    done.add(current);
    for (const edge of scene.edges) {
      if (edge.sound === null) continue;
      const [x, y] = edge.between;
      const other = x === current ? y : y === current ? x : undefined;
      if (other === undefined || done.has(other)) continue;
      const candidate = best + edge.sound;
      if (candidate < (cost.get(other) ?? Infinity)) cost.set(other, candidate);
    }
  }

  const reach: Record<ZoneId, number> = {};
  for (const zone of scene.zones) {
    const c = cost.get(zone.id);
    if (c !== undefined && loudness - c > 0) reach[zone.id] = loudness - c;
  }
  return reach;
}

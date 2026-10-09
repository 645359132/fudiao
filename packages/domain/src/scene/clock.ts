import type { Scene } from './validate';

/**
 * 场景时钟：第 round 回合大约是什么时辰。时辰是在场的人都能感知的公开信息（天色、更鼓），
 * 让有期限的目标在推演中有时间压力。没有时钟或尚未到第一个时点时为 null。
 */
export function clockAt(scene: Scene, round: number): string | null {
  let label: string | null = null;
  for (const point of scene.clock) {
    if (point.fromRound > round) break;
    label = point.label;
  }
  return label;
}

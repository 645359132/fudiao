import { deliveredSentences, type Action } from './actions';
import type { ActorId } from './ids';
import type { Occurrence } from './occurrence';
import type { Scene } from './scene/validate';
import type { SimState, WorldState } from './world';
import { canSee, soundReach } from './zone-graph';

/** 某个角色对一件事的感知。只看见的角色得到视觉信息，只听见的得到声音信息。 */
export type Perception = {
  readonly actor: ActorId;
  readonly occurrence: string;
  /** 当事人总能得知自己行动的结果。 */
  readonly participant: boolean;
  readonly saw: boolean;
  readonly heard: boolean;
  /** 台词：同区域或余量足够时听清已说出的句子；否则只听到有人在说话。 */
  readonly speech?: 'full' | 'muffled';
};

/**
 * 计算一件事的感知受众。观察者的位置取回合开始时的状态：同轮行动发生时他们在那里。
 * 已撤离的角色不再接收感知。
 */
export function perceive(scene: Scene, roundStart: WorldState, occurrence: Occurrence): Perception[] {
  const reach = occurrence.loudness > 0 ? soundReach(scene, occurrence.zones, occurrence.loudness) : {};
  const origin = occurrence.zones[0];
  const perceptions: Perception[] = [];

  for (const actor of (Object.keys(roundStart.actors) as ActorId[]).sort()) {
    const observer = roundStart.actors[actor];
    if (observer === undefined || observer.status !== 'present') continue;

    const participant = occurrence.participants.includes(actor);
    const saw = occurrence.visible && occurrence.zones.some((z) => canSee(scene, observer.zone, z));
    const remaining = reach[observer.zone] ?? 0;
    const heard = remaining > 0;
    if (!participant && !saw && !heard) continue;

    const speech =
      occurrence.speech === undefined
        ? undefined
        : participant || (heard && (observer.zone === origin || remaining >= scene.loudness.speechClarity))
          ? 'full'
          : heard
            ? 'muffled'
            : undefined;

    perceptions.push({
      actor,
      occurrence: occurrence.id,
      participant,
      saw,
      heard,
      ...(speech !== undefined && { speech }),
    });
  }
  return perceptions;
}

/**
 * 轮流对话中，一个行动的台词在说出之前，其余在场的人里谁听得清（full）、谁只听得到有人说话（muffled）。
 * 与提交时分发台词的感知规则相同：说话发生在说话者回合开始时所在的区域。说话者自己不在其中，听不到的人不在其中。
 */
export function speechAudience(scene: Scene, state: SimState, action: Action): ReadonlyMap<ActorId, 'full' | 'muffled'> {
  const u = action.utterance;
  const zone = state.world.actors[action.actor]?.zone;
  if (u === undefined || zone === undefined || deliveredSentences(u).length === 0) return new Map();
  const speech: Occurrence = {
    id: 'pending',
    kind: 'speak',
    actor: action.actor,
    participants: [action.actor],
    zones: [zone],
    visible: true,
    loudness: scene.loudness.speak[u.volume],
    speech: { sentences: deliveredSentences(u), volume: u.volume },
  };
  return new Map(
    perceive(scene, state.world, speech).flatMap((p) =>
      p.actor !== action.actor && (p.speech === 'full' || p.speech === 'muffled') ? [[p.actor, p.speech] as const] : [],
    ),
  );
}

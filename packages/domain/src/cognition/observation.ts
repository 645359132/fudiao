import type { ZoneId } from '../ids';
import type { Occurrence, OccurrenceKind } from '../occurrence';
import type { Perception } from '../perception';
import type { Scene } from '../scene/validate';
import { soundReach } from '../zone-graph';
import type { Observation, ObservedSpeech, SoundCategory } from './types';

const SOUND_OF: Readonly<Record<OccurrenceKind, SoundCategory>> = {
  move: 'footsteps',
  withdraw: 'footsteps',
  take: 'handling',
  drop: 'handling',
  use_item: 'handling',
  attack: 'combat',
  defend: 'combat',
  speak: 'voice',
  trap_triggered: 'mechanism',
  observe: 'noise',
  probe: 'noise',
  other: 'noise',
  wait: 'noise',
  failed_attempt: 'noise',
  discovered: 'noise',
  ruled: 'noise',
  external: 'noise',
};

/** 看见时能认出物品的行动：物品被拿在手里、放下或使用。 */
const ITEM_SHOWN: ReadonlySet<OccurrenceKind> = new Set(['take', 'drop', 'use_item', 'attack', 'failed_attempt']);

/**
 * 把一件事按感知通道裁剪为某个角色的观察。这是信息隔离的第一道关：
 * 角色认知只由观察生成，观察中没有的内容，角色就无从得知。
 */
export function observe(
  scene: Scene,
  occurrence: Occurrence,
  perception: Perception,
  observerZone: ZoneId,
): Observation {
  const o = occurrence;
  const failed = o.kind === 'failed_attempt' ? ({ failed: true } as const) : {};

  if (perception.participant) {
    return {
      occurrence: o.id,
      channel: 'participant',
      kind: o.kind,
      zones: o.zones,
      ...(o.actor && { actor: o.actor }),
      ...(o.item && { item: o.item }),
      ...(o.target && { target: o.target }),
      ...(o.mechanism && { mechanism: o.mechanism }),
      ...(o.attempted && { attempted: o.attempted }),
      ...failed,
      ...(o.violation && { violation: o.violation }),
      ...(o.speech && { speech: { clarity: 'full', sentences: o.speech.sentences, volume: o.speech.volume } }),
      ...(o.description && { description: o.description }),
    };
  }

  const speech = (): ObservedSpeech | undefined => {
    if (o.speech === undefined) return undefined;
    if (perception.speech === 'full') {
      return { clarity: 'full', sentences: o.speech.sentences, volume: o.speech.volume };
    }
    return perception.heard ? { clarity: 'muffled' } : { clarity: 'unheard' };
  };
  const heardSpeech = speech();

  if (perception.saw) {
    const visual = o.description?.visual;
    const sound = perception.heard ? o.description?.sound : undefined;
    return {
      occurrence: o.id,
      channel: 'sight',
      kind: o.kind,
      zones: o.zones,
      ...(o.actor && { actor: o.actor }),
      ...(o.item && ITEM_SHOWN.has(o.kind) && { item: o.item }),
      ...(o.target && { target: o.target }),
      ...(o.mechanism && { mechanism: o.mechanism }),
      ...(o.attempted && { attempted: o.attempted }),
      ...failed,
      ...(heardSpeech && { speech: heardSpeech }),
      ...((visual !== undefined || sound !== undefined) && {
        description: { ...(visual !== undefined && { visual }), ...(sound !== undefined && { sound }) },
      }),
    };
  }

  // 只听见：声音类别与离观察者最近的声源区域，不含行动者与对象。
  const noisyItem = o.kind === 'use_item' && o.item !== undefined && scene.items.some((i) => i.id === o.item && i.use);
  const sound = o.description?.sound;
  return {
    occurrence: o.id,
    channel: 'sound',
    sound: noisyItem ? 'noise' : SOUND_OF[o.kind],
    zones: [nearestSource(scene, o, observerZone)],
    ...(noisyItem && { item: o.item }),
    ...(heardSpeech && { speech: heardSpeech }),
    ...(sound !== undefined && { description: { sound } }),
  };
}

function nearestSource(scene: Scene, o: Occurrence, observerZone: ZoneId): ZoneId {
  let best = o.zones[0] ?? observerZone;
  let loudest = -Infinity;
  for (const zone of o.zones) {
    const remaining = soundReach(scene, [zone], o.loudness)[observerZone] ?? 0;
    if (remaining > loudest) {
      loudest = remaining;
      best = zone;
    }
  }
  return best;
}

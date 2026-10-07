import type { ActorId, ClaimId, KnowledgeId } from '../ids';
import type { Occurrence } from '../occurrence';
import type { Scene } from '../scene/validate';
import type { Claim, KnowledgeItem, Observation } from './types';

export const knowledgeId = (holder: ActorId, round: number, index: number): KnowledgeId =>
  `${holder}:${round}:${index}` as KnowledgeId;

/** 角色卡中的初始认知，回合记为 0。 */
export function initialKnowledge(scene: Scene): Readonly<Record<ActorId, readonly KnowledgeItem[]>> {
  return Object.fromEntries(
    scene.actors.map((a) => [
      a.id,
      a.card.initialKnowledge.map(
        (k, i): KnowledgeItem => ({
          id: knowledgeId(a.id, 0, i),
          holder: a.id,
          round: 0,
          modality: k.modality,
          confidence: k.confidence,
          order: k.order,
          ...(k.concerning !== undefined && { concerning: k.concerning }),
          about: k.about,
          body: { kind: 'text', text: k.text },
          status: 'active',
        }),
      ),
    ]),
  );
}

/** 观察涉及的标识，排序去重。 */
export function observationAbout(o: Observation): string[] {
  const refs = [...o.zones, o.actor, o.target, o.item, o.mechanism].filter(
    (r): r is NonNullable<typeof r> => r !== undefined,
  );
  return [...new Set<string>(refs)].sort();
}

/**
 * 由观察生成认知条目：看见或当事人为 observed，只听见为 heard。
 * 听清别人的台词时另加一条 claimed，指向人物说法，相信程度留待认知更新评估。
 * 标识按该角色已有条目数递增，因此只取决于事件内容。
 */
export function knowledgeFromObservations(
  holder: ActorId,
  round: number,
  existing: readonly KnowledgeItem[],
  observations: readonly Observation[],
): KnowledgeItem[] {
  const items: KnowledgeItem[] = [];
  const next = (item: Omit<KnowledgeItem, 'id' | 'holder' | 'round' | 'status' | 'order'>) =>
    items.push({
      id: knowledgeId(holder, round, existing.length + items.length),
      holder,
      round,
      order: 1,
      status: 'active',
      ...item,
    });

  for (const o of observations) {
    next({
      modality: o.channel === 'sound' ? 'heard' : 'observed',
      confidence: 1,
      about: observationAbout(o),
      body: { kind: 'observation', observation: o },
    });
    if (o.channel !== 'participant' && o.speech?.clarity === 'full' && o.actor !== undefined) {
      next({
        modality: 'claimed',
        confidence: null,
        about: [o.actor],
        body: { kind: 'claim', claim: o.occurrence as ClaimId },
      });
    }
  }
  return items;
}

/** 每句已说出的台词都记为一条人物说法；听清的听者由观察决定。 */
export function claimsFromOccurrences(
  scene: Scene,
  round: number,
  occurrences: readonly Occurrence[],
): Claim[] {
  return occurrences.flatMap((o): Claim[] => {
    if (o.kind !== 'speak' || o.speech === undefined || o.actor === undefined) return [];
    const addressee = o.target !== undefined && scene.actors.some((a) => a.id === o.target) ? (o.target as ActorId) : undefined;
    return [
      {
        id: o.id as ClaimId,
        speaker: o.actor,
        round,
        sentences: o.speech.sentences,
        ...(addressee !== undefined && { addressee }),
      },
    ];
  });
}

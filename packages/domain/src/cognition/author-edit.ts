import { err, ok, type Result } from '@novel-writer/shared';
import type { ActorId, KnowledgeId } from '../ids';
import type { Scene } from '../scene/validate';
import type { SimState } from '../world';
import { knowledgeId } from './knowledge';
import type { KnowledgeItem } from './types';

/**
 * 作者介入时修改角色认知（B30）。与模型的认知更新不同，作者可以让角色“亲眼见过”或“听说过”某事，
 * 例如让主角提前知道绊索的位置；人物说法仍只能来自台词。
 */
export type KnowledgeEdited = {
  readonly type: 'KnowledgeEdited';
  readonly round: number;
  readonly actor: ActorId;
  readonly added: readonly KnowledgeItem[];
  readonly retracted: readonly KnowledgeId[];
};

export type AuthorKnowledge = {
  readonly text: string;
  readonly modality: 'observed' | 'heard' | 'inferred';
  readonly confidence: number;
  readonly about: readonly string[];
};

export type KnowledgeEditError = {
  readonly code: 'unknown_actor' | 'unknown_ref' | 'not_active' | 'invalid_item';
  readonly ref?: string;
};

const knownIds = (scene: Scene) =>
  new Set<string>([...scene.zones, ...scene.actors, ...scene.items, ...scene.mechanisms].map((e) => e.id));

export function planKnowledgeEdit(
  scene: Scene,
  state: SimState,
  actor: ActorId,
  edit: { readonly add: readonly AuthorKnowledge[]; readonly retract: readonly KnowledgeId[] },
): Result<KnowledgeEdited, KnowledgeEditError> {
  const existing = state.knowledge[actor];
  if (existing === undefined) return err({ code: 'unknown_actor', ref: actor });
  const ids = knownIds(scene);
  for (const a of edit.add) {
    if (a.text.trim() === '' || !(a.confidence >= 0 && a.confidence <= 1)) return err({ code: 'invalid_item' });
    const unknown = a.about.find((ref) => !ids.has(ref));
    if (unknown !== undefined) return err({ code: 'unknown_ref', ref: unknown });
  }
  for (const id of edit.retract) {
    const item = existing.find((k) => k.id === id);
    if (item === undefined) return err({ code: 'unknown_ref', ref: id });
    if (item.status !== 'active') return err({ code: 'not_active', ref: id });
  }
  return ok({
    type: 'KnowledgeEdited',
    round: state.round,
    actor,
    added: edit.add.map(
      (a, i): KnowledgeItem => ({
        id: knowledgeId(actor, state.round, existing.length + i),
        holder: actor,
        round: state.round,
        modality: a.modality,
        confidence: a.confidence,
        order: 1,
        about: [...new Set(a.about)].sort(),
        body: { kind: 'text', text: a.text },
        status: 'active',
      }),
    ),
    retracted: edit.retract,
  });
}

/** 归约时应用作者的修改，并再次检查结构。 */
export function applyKnowledgeEdited(
  existing: readonly KnowledgeItem[],
  event: KnowledgeEdited,
): Result<readonly KnowledgeItem[], KnowledgeEditError> {
  const ids = new Set(existing.map((k) => k.id));
  for (const k of event.added) {
    if (k.holder !== event.actor || k.modality === 'claimed' || ids.has(k.id)) return err({ code: 'invalid_item', ref: k.id });
    ids.add(k.id);
  }
  const retracted = new Set(event.retracted);
  for (const id of retracted) {
    const item = existing.find((k) => k.id === id);
    if (item === undefined) return err({ code: 'unknown_ref', ref: id });
    if (item.status !== 'active') return err({ code: 'not_active', ref: id });
  }
  return ok([
    ...existing.map((k): KnowledgeItem => (retracted.has(k.id) ? { ...k, status: 'retracted' } : k)),
    ...event.added,
  ]);
}

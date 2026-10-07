import { err, ok, type Result } from '@novel-writer/shared';
import type { ActorId, KnowledgeId } from '../ids';
import type { Modality } from '../scene/schema';
import type { Scene } from '../scene/validate';
import type { SimState } from '../world';
import { knowledgeId } from './knowledge';
import type { BeliefRevision, BeliefsUpdated, KnowledgeItem } from './types';
import { buildCharacterView, viewIds } from './view';

/** 模型提出的认知更新（认知更新任务，或行动提案中的推测）。 */
export type BeliefProposal = {
  readonly add?: readonly {
    readonly text: string;
    readonly confidence: number;
    readonly about: readonly string[];
    readonly order?: 1 | 2;
    readonly concerning?: ActorId;
    /** 模型只能新增推测；其他来源方式只来自感知。 */
    readonly modality?: Modality;
  }[];
  readonly revise?: readonly BeliefRevision[];
  readonly retract?: readonly KnowledgeId[];
};

export type BeliefUpdateError = {
  readonly code:
    | 'unknown_actor'
    | 'not_inferred'
    | 'empty_text'
    | 'invalid_confidence'
    | 'invalid_order'
    /** 引用了视图中没有的标识，可能是凭键名猜到的信息，视为泄露迹象。 */
    | 'unknown_ref'
    | 'not_own'
    | 'not_active'
    | 'duplicate_ref'
    | 'id_conflict';
  readonly part?: 'add' | 'revise' | 'retract';
  readonly index?: number;
  readonly ref?: string;
};

const validConfidence = (c: number) => Number.isFinite(c) && c >= 0 && c <= 1;

/** 校验模型提出的认知更新，生成可以追加的事件。条目标识在此分配。 */
export function planBeliefUpdate(
  scene: Scene,
  state: SimState,
  actor: ActorId,
  proposal: BeliefProposal,
): Result<BeliefsUpdated, BeliefUpdateError> {
  const existing = state.knowledge[actor];
  if (existing === undefined) return err({ code: 'unknown_actor', ref: actor });
  const known = viewIds(buildCharacterView(scene, state, actor));

  const added: KnowledgeItem[] = [];
  for (const [index, a] of (proposal.add ?? []).entries()) {
    const fail = (code: BeliefUpdateError['code'], ref?: string) =>
      err<BeliefUpdateError>({ code, part: 'add', index, ...(ref !== undefined && { ref }) });
    if (a.modality !== undefined && a.modality !== 'inferred') return fail('not_inferred', a.modality);
    if (a.text.trim() === '') return fail('empty_text');
    if (!validConfidence(a.confidence)) return fail('invalid_confidence');
    const order = a.order ?? 1;
    if (order === 2) {
      if (a.concerning === undefined || a.concerning === actor || state.knowledge[a.concerning] === undefined) {
        return fail('invalid_order', a.concerning);
      }
      if (!known.has(a.concerning)) return fail('unknown_ref', a.concerning);
    } else if (a.concerning !== undefined) {
      return fail('invalid_order', a.concerning);
    }
    const unknownRef = a.about.find((ref) => !known.has(ref));
    if (unknownRef !== undefined) return fail('unknown_ref', unknownRef);

    added.push({
      id: knowledgeId(actor, state.round, existing.length + added.length),
      holder: actor,
      round: state.round,
      modality: 'inferred',
      confidence: a.confidence,
      order,
      ...(a.concerning !== undefined && { concerning: a.concerning }),
      about: [...new Set(a.about)].sort(),
      body: { kind: 'text', text: a.text },
      status: 'active',
    });
  }

  const touched = new Set<KnowledgeId>();
  const checkRef = (part: 'revise' | 'retract', index: number, id: KnowledgeId): BeliefUpdateError | undefined => {
    if (touched.has(id)) return { code: 'duplicate_ref', part, index, ref: id };
    touched.add(id);
    const own = existing.find((k) => k.id === id);
    if (own === undefined) {
      const elsewhere = Object.values(state.knowledge).some((list) => list.some((k) => k.id === id));
      return { code: elsewhere ? 'not_own' : 'unknown_ref', part, index, ref: id };
    }
    return own.status === 'active' ? undefined : { code: 'not_active', part, index, ref: id };
  };

  for (const [index, r] of (proposal.revise ?? []).entries()) {
    const problem = checkRef('revise', index, r.id);
    if (problem) return err(problem);
    if (!validConfidence(r.confidence)) return err({ code: 'invalid_confidence', part: 'revise', index });
  }
  for (const [index, id] of (proposal.retract ?? []).entries()) {
    const problem = checkRef('retract', index, id);
    if (problem) return err(problem);
  }

  return ok({
    type: 'BeliefsUpdated',
    round: state.round,
    actor,
    added,
    revised: proposal.revise ?? [],
    retracted: proposal.retract ?? [],
  });
}

/** 归约时应用认知更新。再次检查结构，防止事件记录被改坏后静默产生错误状态。 */
export function applyBeliefsUpdated(
  actor: ActorId,
  existing: readonly KnowledgeItem[],
  event: BeliefsUpdated,
): Result<readonly KnowledgeItem[], BeliefUpdateError> {
  const ids = new Set(existing.map((k) => k.id));
  for (const [index, k] of event.added.entries()) {
    if (k.holder !== actor || k.modality !== 'inferred') return err({ code: 'not_inferred', part: 'add', index });
    if (ids.has(k.id)) return err({ code: 'id_conflict', part: 'add', index, ref: k.id });
    if (k.confidence === null || !validConfidence(k.confidence)) {
      return err({ code: 'invalid_confidence', part: 'add', index });
    }
    ids.add(k.id);
  }

  const revised = new Map(event.revised.map((r) => [r.id, r.confidence]));
  const retracted = new Set(event.retracted);
  for (const id of [...revised.keys(), ...retracted]) {
    const item = existing.find((k) => k.id === id);
    if (item === undefined) return err({ code: 'unknown_ref', ref: id });
    if (item.status !== 'active') return err({ code: 'not_active', ref: id });
  }

  const updated = existing.map((k): KnowledgeItem => {
    const confidence = revised.get(k.id);
    const next = confidence === undefined ? k : { ...k, confidence };
    return retracted.has(k.id) ? { ...next, status: 'retracted' } : next;
  });
  return ok([...updated, ...event.added]);
}

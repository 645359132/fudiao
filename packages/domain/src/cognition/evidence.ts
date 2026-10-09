import type { ActorId, KnowledgeId, SecretId } from '../ids';
import type { Scene } from '../scene/validate';
import type { SimState } from '../world';
import type { KnowledgeItem } from './types';

/** 与秘密相关的推测，及该角色涉及同一对象、可能构成线索的条目。 */
export type SecretCandidate = {
  readonly secret: SecretId;
  readonly inference: KnowledgeId;
  readonly evidence: readonly KnowledgeId[];
};

/**
 * 证据链检查的程序部分（B44）：按涉及对象筛出与秘密相关的推测，排除合法知情者，
 * 并附上可能构成证据的观察、听闻、说法与先前回合的推测（含角色卡中的初始推测）。
 * 同一回合提出的推测不互为线索，免得几条猜测互相支撑。是否命中、证据是否充分由命中判断决定，
 * 领域内核不下结论。
 */
export function screenSecretInferences(
  scene: Scene,
  state: SimState,
  actor: ActorId,
  inferences: readonly KnowledgeItem[],
): SecretCandidate[] {
  const own = (state.knowledge[actor] ?? []).filter((k) => k.status === 'active');
  const candidates: SecretCandidate[] = [];

  for (const inference of inferences) {
    if (inference.holder !== actor || inference.modality !== 'inferred') continue;
    for (const secret of scene.secrets) {
      if (secret.knownBy.includes(actor)) continue;
      const subjects = new Set(secret.subjects);
      if (!inference.about.some((ref) => subjects.has(ref))) continue;
      const evidence = own
        .filter((k) => (k.modality !== 'inferred' || k.round < inference.round) && k.about.some((ref) => subjects.has(ref)))
        .map((k) => k.id);
      candidates.push({ secret: secret.id, inference: inference.id, evidence });
    }
  }
  return candidates;
}

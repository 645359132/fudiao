import type { ActorId, ClaimId, ItemId, KnowledgeId, MechanismId, ZoneId } from '../ids';
import type { OccurrenceKind } from '../occurrence';
import type { RuleViolation } from '../rules/types';
import type { ActionKind, Modality, Volume } from '../scene/schema';

/** 只听见时能分辨的声音类别。 */
export type SoundCategory = 'footsteps' | 'handling' | 'combat' | 'voice' | 'mechanism' | 'noise';

export type ObservedSpeech =
  | { readonly clarity: 'full'; readonly sentences: readonly string[]; readonly volume: Volume }
  /** 听到有人在说话，听不清内容。 */
  | { readonly clarity: 'muffled' }
  /** 看见对方在说话，听不到声音。 */
  | { readonly clarity: 'unheard' };

/**
 * 某个角色对一件事的观察：按感知通道从“发生的事”裁剪而来，是该角色认知的唯一来源。
 * 当事人得到全部；看见的得到可见部分；只听见的得到声音类别与声源区域。
 */
export type Observation = {
  readonly occurrence: string;
  readonly channel: 'participant' | 'sight' | 'sound';
  /** 当事人与看见者知道发生了什么。 */
  readonly kind?: OccurrenceKind;
  /** 只听见时的声音类别。 */
  readonly sound?: SoundCategory;
  readonly actor?: ActorId;
  /** 只听见时只有声源区域（离观察者最近的那一处）。 */
  readonly zones: readonly ZoneId[];
  readonly item?: ItemId;
  readonly target?: string;
  readonly mechanism?: MechanismId;
  readonly attempted?: ActionKind;
  readonly failed?: true;
  /** 失败原因只有当事人知道。 */
  readonly violation?: RuleViolation;
  readonly speech?: ObservedSpeech;
  readonly description?: { readonly visual?: string; readonly sound?: string };
  /** 读到的物品内容；只有读的人（当事人）的观察中才有。 */
  readonly content?: string;
};

export type KnowledgeBody =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'observation'; readonly observation: Observation }
  | { readonly kind: 'claim'; readonly claim: ClaimId };

/** 角色认知条目。可以与世界事实不同；只有本人的视图中出现。 */
export type KnowledgeItem = {
  /** `${holder}:${回合}:${序号}`，由事件内容确定，回放可复现。 */
  readonly id: KnowledgeId;
  readonly holder: ActorId;
  /** 获得时的回合；初始认知为 0。 */
  readonly round: number;
  readonly modality: Modality;
  /** 0 到 1；人物说法在认知更新评估前为 null。 */
  readonly confidence: number | null;
  readonly order: 1 | 2;
  /** 二阶认知：“concerning 认为我……”。 */
  readonly concerning?: ActorId;
  /** 涉及的角色、区域、物品或机关。 */
  readonly about: readonly string[];
  readonly body: KnowledgeBody;
  readonly status: 'active' | 'retracted';
};

/** 人物说法：说出的内容，不是事实（B42）。标识取台词所属“发生的事”的标识。 */
export type Claim = {
  readonly id: ClaimId;
  readonly speaker: ActorId;
  readonly round: number;
  readonly sentences: readonly string[];
  readonly addressee?: ActorId;
};

export type BeliefRevision = { readonly id: KnowledgeId; readonly confidence: number };

/** 认知更新事件：新增推测、修改相信程度、撤回条目。由 planBeliefUpdate 校验后生成。 */
export type BeliefsUpdated = {
  readonly type: 'BeliefsUpdated';
  readonly round: number;
  readonly actor: ActorId;
  readonly added: readonly KnowledgeItem[];
  readonly revised: readonly BeliefRevision[];
  readonly retracted: readonly KnowledgeId[];
};

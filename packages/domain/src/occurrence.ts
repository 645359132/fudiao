import type { ActorId, ItemId, MechanismId, ZoneId } from './ids';
import type { RuleViolation } from './rules/types';
import type { ActionKind, Volume } from './scene/schema';

export type OccurrenceKind =
  | ActionKind
  | 'failed_attempt'
  | 'trap_triggered'
  | 'discovered'
  | 'ruled'
  /** 作者安排的外部事件或导演提议。 */
  | 'external';

/**
 * 裁决产生的“发生的事”，是感知分发的单位。全部为结构化数据，不含程序生成的文字；
 * 只有语义裁决附带模型写的描述。
 */
export type Occurrence = {
  /** `${回合}:${序号}`，序号在整次运行中递增，由提交时分配。 */
  readonly id: string;
  readonly kind: OccurrenceKind;
  readonly actor?: ActorId;
  /** 总能得知结果的角色。 */
  readonly participants: readonly ActorId[];
  /** 发生的区域；移动有起点与终点两个区域。 */
  readonly zones: readonly ZoneId[];
  /** 能否被看见。发现机关这类只有当事人知道的事不可见。 */
  readonly visible: boolean;
  readonly loudness: number;
  readonly item?: ItemId;
  readonly target?: string;
  readonly mechanism?: MechanismId;
  readonly speech?: { readonly sentences: readonly string[]; readonly volume: Volume };
  /** 失败尝试的原行动种类与原因。 */
  readonly attempted?: ActionKind;
  readonly violation?: RuleViolation;
  /** 来自语义裁决的请求标识与描述。 */
  readonly ruling?: string;
  readonly description?: { readonly visual?: string; readonly sound?: string };
};

export type OccurrenceDraft = Omit<Occurrence, 'id'>;

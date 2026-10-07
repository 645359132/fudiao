import type { ActorId, ItemId, ZoneId } from './ids';
import type { ActionKind, Volume } from './scene/schema';

export type Utterance = {
  /** 台词按句切分，用于轮流对话中的打断。 */
  readonly sentences: readonly string[];
  readonly volume: Volume;
  /** 实际说出的句数；被打断时由引擎的回合协议填写，未填写表示全部说完。 */
  readonly deliveredCount?: number;
};

/**
 * 领域层的行动：标识已解析，可直接交给规则检查与裁决。
 * 模型输出的行动提案 schema 在 packages/prompts，由引擎转换为本类型。
 */
export type Action = {
  readonly actor: ActorId;
  readonly kind: ActionKind;
  /** 行动对象，可以是角色、区域、物品或机关的键。 */
  readonly target?: string;
  readonly item?: ItemId;
  readonly toZone?: ZoneId;
  readonly utterance?: Utterance;
};

export const deliveredSentences = (u: Utterance): readonly string[] =>
  u.sentences.slice(0, u.deliveredCount ?? u.sentences.length);

import {
  viewIds,
  type Action,
  type ActorId,
  type BeliefProposal,
  type CharacterView,
  type Effect,
  type ExternalEvent,
  type FlagKey,
  type ItemId,
  type KnowledgeId,
  type CounterKey,
  type Scene,
  type SemanticRuling,
  type SimState,
  type ZoneId,
} from '@fudiao/domain';
import type { ActionProposal, BeliefUpdateOutput, DirectorProposalOutput, SemanticRulingOutput } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';

/**
 * 模型的行动提案转换为领域行动。标识是否存在、行动是否合法由 checkAction 判断，
 * 这里只做结构转换；不合法的提案会被拒绝并请求修正。
 */
export function proposalToAction(proposal: ActionProposal, actor: ActorId): Action {
  const sentences = proposal.utterance?.sentences.map((s) => s.trim()).filter((s) => s !== '') ?? [];
  return {
    actor,
    kind: proposal.kind,
    ...(proposal.target !== null && { target: proposal.target }),
    ...(proposal.item !== null && { item: proposal.item as ItemId }),
    ...(proposal.toZone !== null && { toZone: proposal.toZone as ZoneId }),
    // 任何行动都可以附带台词（边做事边说话）；只有说话类行动才把空台词当作没有行动内容。
    ...(proposal.utterance !== null && (proposal.kind === 'speak' || sentences.length > 0) && { utterance: { sentences, volume: proposal.utterance.volume } }),
    ...(proposal.description !== null && proposal.description.trim() !== '' && { description: proposal.description.trim() }),
  };
}

/** 提案中的推测与认知更新的输出合并为一次认知更新提议；只保留视图中出现过的标识。 */
export function beliefProposal(
  view: CharacterView,
  inferences: ActionProposal['inferences'],
  update: BeliefUpdateOutput | null,
): BeliefProposal {
  const known = viewIds(view);
  const own = new Set(view.knowledge.map((k) => k.id as string));
  const adds = [...inferences, ...(update?.add ?? [])].flatMap((a) => {
    const concerning = a.concerning;
    if (concerning !== null && (concerning === view.actorId || !known.has(concerning))) return [];
    return [
      {
        text: a.content,
        confidence: a.confidence,
        about: a.about.filter((ref) => known.has(ref)),
        ...(concerning !== null && { order: 2 as const, concerning: concerning as ActorId }),
      },
    ];
  });
  const touched = new Set<string>();
  const once = (id: string) => (touched.has(id) ? false : (touched.add(id), true));
  return {
    add: adds.filter((a) => a.text.trim() !== ''),
    revise: (update?.revise ?? [])
      .filter((r) => own.has(r.id) && once(r.id))
      .map((r) => ({ id: r.id as KnowledgeId, confidence: r.confidence })),
    retract: (update?.retract ?? []).filter((id) => own.has(id) && once(id)).map((id) => id as KnowledgeId),
  };
}

/**
 * 导演提议转换为外部事件。导演只能设置场景已声明的标记并产生一件外部事件，
 * 不能移动角色、转移物品或改变伤势；未声明的标记被丢弃，区域不存在时视为没有提议。
 */
export function directorEvent(output: DirectorProposalOutput, scene: Scene, state: SimState): ExternalEvent | null {
  const e = output.event;
  if (!output.propose || e === null) return null;
  if (!scene.zones.some((z) => z.id === e.zone)) return null;
  const effects: Effect[] = e.setFlags
    .filter((f) => f.flag in state.world.flags)
    .map((f) => ({ type: 'setFlag', flag: f.flag as FlagKey, value: f.value }));
  return {
    effects,
    occurrences: [
      {
        participants: [],
        zones: [e.zone as ZoneId],
        visible: e.visible,
        loudness: e.loudness,
        description: { ...(e.visual !== null && { visual: e.visual }), ...(e.sound !== null && { sound: e.sound }) },
      },
    ],
  };
}

export type RulingConversionError = { readonly index: number; readonly issue: string };

/** 裁决模型的输出转换为领域的语义裁决。范围与不变式由 checkRulingScope 与提交时检查。 */
export function rulingFromOutput(
  requestId: string,
  output: SemanticRulingOutput,
): Result<SemanticRuling, RulingConversionError> {
  const effects: Effect[] = [];
  for (const [index, e] of output.effects.entries()) {
    switch (e.type) {
      case 'moveActor':
        effects.push({ type: 'moveActor', actor: e.actor as ActorId, to: e.to as ZoneId });
        break;
      case 'transferItem':
        if ((e.toActor === null) === (e.toZone === null)) {
          return err({ index, issue: 'transferItem 的 toActor 与 toZone 必须恰好填一个' });
        }
        effects.push({
          type: 'transferItem',
          item: e.item as ItemId,
          to: e.toActor !== null ? { kind: 'actor', actor: e.toActor as ActorId } : { kind: 'zone', zone: e.toZone as ZoneId },
        });
        break;
      case 'adjustCounter':
        effects.push({ type: 'adjustCounter', item: e.item as ItemId, counter: e.counter as CounterKey, delta: e.delta });
        break;
      case 'setInjury':
        effects.push({ type: 'setInjury', actor: e.actor as ActorId, level: e.level });
        break;
      case 'setActorStatus':
        effects.push({ type: 'setActorStatus', actor: e.actor as ActorId, status: e.status });
        break;
      case 'setFlag':
        effects.push({ type: 'setFlag', flag: e.flag as FlagKey, value: e.value });
        break;
    }
  }
  return ok({
    requestId,
    effects,
    occurrences: output.occurrences.map((o) => ({
      participants: o.participants as ActorId[],
      zones: o.zones as ZoneId[],
      visible: o.visible,
      loudness: o.loudness,
      description: { ...(o.visual !== null && { visual: o.visual }), ...(o.sound !== null && { sound: o.sound }) },
    })),
  });
}

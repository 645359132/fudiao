import { applyEvent, initialState, type ActorId, type RuleViolation, type Scene, type SimState } from '@novel-writer/domain';
import { err, ok, type Result } from '@novel-writer/shared';
import type { RunConfig } from './config';
import { isDomainEvent, type EndReason, type EngineEvent, type PauseReason, type RunEvent } from './events';

/** 回合阶段（施工文档第五章状态图）。“校验”在提交提案时即时完成，并入收集提案。 */
export type Phase =
  | 'BuildingViews'
  | 'AwaitingProposals'
  | 'Adjudicating'
  | 'AwaitingAuthor'
  | 'Committing'
  | 'UpdatingBeliefs'
  | 'CheckingEnd'
  | 'Paused'
  | 'Ended';

export type ProposalRecord = Extract<EngineEvent, { type: 'ProposalSubmitted' }>;
export type RulingProposal = Extract<EngineEvent, { type: 'AdjudicationProposed' }>;
export type RulingConfirmation = Extract<EngineEvent, { type: 'AdjudicationConfirmed' }>;

export type RunState = {
  readonly runId: string;
  readonly config: RunConfig;
  readonly sceneHash: string;
  readonly lastSeq: number;
  readonly sim: SimState;
  readonly phase: Phase;
  readonly endReason: EndReason | null;
  readonly pause: { readonly reason: PauseReason; readonly actor?: ActorId; readonly detail?: string } | null;
  /** 当前回合是否已开始（RoundStarted 之后、RoundEnded 之前）。 */
  readonly inRound: boolean;
  readonly views: ReadonlySet<ActorId>;
  /** 本回合已通过检查、将要裁决的行动。 */
  readonly proposals: ReadonlyMap<ActorId, ProposalRecord>;
  /** 轮流对话中留到下一回合的回应。 */
  readonly prepared: ReadonlyMap<ActorId, ProposalRecord>;
  /** 本回合被规则拒绝的提案，按尝试顺序；用于在同一对话中请求修正。 */
  readonly rejections: ReadonlyMap<ActorId, readonly { readonly proposal: ProposalRecord; readonly violation: RuleViolation }[]>;
  readonly proposalsComplete: Extract<EngineEvent, { type: 'ProposalsComplete' }> | null;
  readonly rulingsProposed: ReadonlyMap<string, RulingProposal>;
  readonly rulingsConfirmed: ReadonlyMap<string, RulingConfirmation>;
  readonly committed: boolean;
  readonly reviewed: ReadonlySet<ActorId>;
  readonly evidenceChecked: boolean;
  /** 轮流对话中持有发言权的人。 */
  readonly floor: ActorId | null;
  /** 自动接受、待作者复核的裁决。 */
  readonly needsReview: readonly RulingConfirmation[];
};

export type ReduceError = { readonly seq: number; readonly code: string; readonly detail?: string };

const presentActors = (sim: SimState): ActorId[] =>
  (Object.keys(sim.world.actors) as ActorId[]).filter((a) => sim.world.actors[a]?.status === 'present');

function phaseOf(s: Omit<RunState, 'phase'>, awaitingAuthor: boolean): Phase {
  if (s.endReason !== null) return 'Ended';
  if (s.pause !== null) return 'Paused';
  if (!s.inRound) return 'BuildingViews';
  const present = presentActors(s.sim);
  if (present.some((a) => !s.views.has(a))) return 'BuildingViews';
  if (s.proposalsComplete === null) return 'AwaitingProposals';
  if (!s.committed) {
    if (awaitingAuthor) return 'AwaitingAuthor';
    return [...s.rulingsProposed.keys()].every((id) => s.rulingsConfirmed.has(id)) && s.rulingsProposed.size > 0
      ? 'Committing'
      : 'Adjudicating';
  }
  if (!s.evidenceChecked) return 'UpdatingBeliefs';
  return 'CheckingEnd';
}

// 各阶段允许出现的事件。不在表中的事件说明记录损坏或实现有误，归约直接报错。
const ALLOWED: Readonly<Record<Phase, ReadonlySet<RunEvent['type']>>> = {
  BuildingViews: new Set([
    'RoundStarted',
    'ViewBuilt',
    'AuthorIntervened',
    'Committed',
    'StateChanged',
    'PerceptionDelivered',
    'KnowledgeEdited',
    'RunPaused',
    'RunEnded',
  ]),
  AwaitingProposals: new Set([
    'ProposalSubmitted',
    'ProposalRejected',
    'ProposalsComplete',
    'AuthorIntervened',
    'KnowledgeEdited',
    'RunPaused',
    'RunEnded',
  ]),
  Adjudicating: new Set(['AdjudicationProposed', 'AdjudicationConfirmed', 'Committed', 'RunPaused', 'RunEnded']),
  AwaitingAuthor: new Set(['AdjudicationProposed', 'AdjudicationConfirmed', 'RunPaused', 'RunEnded']),
  Committing: new Set(['Committed', 'StateChanged', 'PerceptionDelivered', 'RunPaused', 'RunEnded']),
  UpdatingBeliefs: new Set([
    'StateChanged',
    'PerceptionDelivered',
    'BeliefsUpdated',
    'BeliefsReviewed',
    'EvidenceGapFlagged',
    'EvidenceChecked',
    'RunPaused',
    'RunEnded',
  ]),
  CheckingEnd: new Set(['RoundEnded', 'RunEnded', 'RunPaused']),
  Paused: new Set([
    'RunResumed',
    'RunEnded',
    'AuthorIntervened',
    'ProposalSubmitted',
    'KnowledgeEdited',
    'Committed',
    'StateChanged',
    'PerceptionDelivered',
  ]),
  Ended: new Set(),
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** 由事件归约出运行状态。纯函数：同样的事件总得到同样的状态，回放不调用模型。 */
export function reduceRun(scene: Scene, runId: string, events: readonly { seq: number; payload: unknown }[]): Result<RunState, ReduceError> {
  const first = events[0];
  const start = first?.payload as RunEvent | undefined;
  if (first === undefined || start?.type !== 'RunStarted') return err({ seq: first?.seq ?? 0, code: 'not_started' });

  const config = start.config;
  const firstFloor = config.protocol === 'turn_based' ? (config.firstSpeaker ?? scene.actors[0]?.id ?? null) : null;
  const s: Mutable<Omit<RunState, 'phase'>> = {
    runId,
    config,
    sceneHash: start.sceneHash,
    lastSeq: first.seq,
    sim: initialState(scene, config.seed),
    endReason: null,
    pause: null,
    inRound: false,
    views: new Set(),
    proposals: new Map(),
    prepared: new Map(),
    rejections: new Map(),
    proposalsComplete: null,
    rulingsProposed: new Map(),
    rulingsConfirmed: new Map(),
    committed: false,
    reviewed: new Set(),
    evidenceChecked: false,
    floor: firstFloor,
    needsReview: [],
  };
  let awaitingAuthor = false;

  for (const stored of events.slice(1)) {
    const event = stored.payload as RunEvent;
    const phase = phaseOf(s, awaitingAuthor);
    if (!ALLOWED[phase].has(event.type)) {
      return err({ seq: stored.seq, code: 'illegal_transition', detail: `${phase} 阶段不允许 ${event.type}` });
    }
    s.lastSeq = stored.seq;

    if (isDomainEvent(event)) {
      const next = applyEvent(scene, s.sim, event);
      if (!next.ok) return err({ seq: stored.seq, code: 'domain', detail: next.error.code });
      s.sim = next.value;
      if (event.type === 'RoundStarted') {
        s.inRound = true;
        s.views = new Set();
        s.proposals = new Map();
        // 轮流对话：留到本回合及以后的回应保留，持有发言权时经检查后成为行动。
        s.prepared = new Map([...s.prepared].filter(([, p]) => p.forRound >= event.round));
        s.rejections = new Map();
        s.proposalsComplete = null;
        s.rulingsProposed = new Map();
        s.rulingsConfirmed = new Map();
        s.committed = false;
        s.reviewed = new Set();
        s.evidenceChecked = false;
      }
      continue;
    }

    switch (event.type) {
      case 'RunStarted':
        return err({ seq: stored.seq, code: 'duplicate_start' });
      case 'ViewBuilt':
        s.views = new Set([...s.views, event.actor]);
        break;
      case 'ProposalSubmitted':
        if (event.forRound === s.sim.round) {
          s.proposals = new Map([...s.proposals, [event.actor, event]]);
        } else {
          s.prepared = new Map([...s.prepared, [event.actor, event]]);
        }
        break;
      case 'ProposalRejected': {
        const rejected = s.proposals.get(event.actor);
        if (rejected === undefined) return err({ seq: stored.seq, code: 'reject_without_proposal' });
        const proposals = new Map(s.proposals);
        proposals.delete(event.actor);
        s.proposals = proposals;
        s.rejections = new Map([
          ...s.rejections,
          [event.actor, [...(s.rejections.get(event.actor) ?? []), { proposal: rejected, violation: event.violation }]],
        ]);
        break;
      }
      case 'ProposalsComplete':
        s.proposalsComplete = event;
        break;
      case 'AdjudicationProposed':
        s.rulingsProposed = new Map([...s.rulingsProposed, [event.requestId, event]]);
        awaitingAuthor = config.mode === 'interactive';
        break;
      case 'AdjudicationConfirmed':
        if (!s.rulingsProposed.has(event.requestId)) return err({ seq: stored.seq, code: 'confirm_without_proposal' });
        s.rulingsConfirmed = new Map([...s.rulingsConfirmed, [event.requestId, event]]);
        if (event.needsReview) s.needsReview = [...s.needsReview, event];
        awaitingAuthor = [...s.rulingsProposed.keys()].some((id) => !s.rulingsConfirmed.has(id));
        break;
      case 'Committed':
        if (event.origin === 'round') {
          if (s.committed) return err({ seq: stored.seq, code: 'duplicate_commit' });
          s.committed = true;
          awaitingAuthor = false;
        }
        break;
      case 'BeliefsReviewed':
        s.reviewed = new Set([...s.reviewed, event.actor]);
        break;
      case 'EvidenceGapFlagged':
        break;
      case 'EvidenceChecked':
        s.evidenceChecked = true;
        break;
      case 'AuthorIntervened':
        break;
      case 'RoundEnded':
        s.inRound = false;
        s.floor = event.nextFloor;
        break;
      case 'RunPaused':
        s.pause = {
          reason: event.reason,
          ...(event.actor !== undefined && { actor: event.actor }),
          ...(event.detail !== undefined && { detail: event.detail }),
        };
        break;
      case 'RunResumed':
        s.pause = null;
        break;
      case 'RunEnded':
        s.endReason = event.reason;
        break;
    }
  }

  return ok({ ...s, phase: phaseOf(s, awaitingAuthor) });
}

export { presentActors };

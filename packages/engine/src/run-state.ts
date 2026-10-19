import {
  adjudicate,
  applyEvent,
  initialState,
  type Action,
  type Adjudication,
  type ActorId,
  type Occurrence,
  type RuleViolation,
  type Scene,
  type SimState,
} from '@fudiao/domain';
import { err, ok, type Result } from '@fudiao/shared';
import type { RunConfig } from './config';
import {
  isDomainEvent,
  type EndReason,
  type EngineEvent,
  type PauseReason,
  type RunEvent,
  type StalemateKind,
} from './events';

/** 回合阶段（施工文档第五章状态图）。“校验”在提交提案时即时完成，并入收集提案。 */
export type Phase =
  | 'BuildingViews'
  /** 回合之间询问导演（M0-07）。 */
  | 'Directing'
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
  /**
   * 提案收齐时的程序裁决与待语义裁决的请求（失败时为错误码）。回合内到提交前世界不变（裁决不读认知），
   * 归约时算一次，恢复时据此判断哪些请求还没有提出或确认。
   */
  readonly adjudication: Result<Adjudication, string> | null;
  readonly rulingsProposed: ReadonlyMap<string, RulingProposal>;
  readonly rulingsConfirmed: ReadonlyMap<string, RulingConfirmation>;
  readonly committed: boolean;
  readonly reviewed: ReadonlySet<ActorId>;
  readonly evidenceChecked: boolean;
  /** 轮流对话中持有发言权的人。 */
  readonly floor: ActorId | null;
  /** 自动接受、待作者复核的裁决。 */
  readonly needsReview: readonly RulingConfirmation[];
  /** 已结束各回合的记录，用于僵局分类。 */
  readonly history: readonly RoundRecord[];
  /** 当前回合的累计：世界状态是否变化、发生的事。回合之间的导演与作者事件计入下一回合。 */
  readonly current: { readonly changed: boolean; readonly occurrences: readonly Occurrence[] };
  readonly stalemates: readonly { readonly round: number; readonly kind: StalemateKind }[];
  /** 当前回合边界上的导演提议及是否已决定。 */
  readonly director: { readonly proposed: DirectorProposal | null; readonly decided: boolean; readonly adopted: number };
  /**
   * 本回合各对象（角色，或裁决、僵局、导演的 all）的重做次数：作者在截断、拒答等暂停后继续，或修改了该角色的认知。
   * 次数大于零时步骤键换新后缀，不再复用失败或已过时的调用结果。回合开始时清零。
   */
  readonly redo: ReadonlyMap<ActorId | 'all', number>;
};

export type RoundRecord = {
  readonly round: number;
  readonly actions: readonly Action[];
  readonly changed: boolean;
  readonly occurrences: readonly Occurrence[];
};

export type DirectorProposal = Extract<EngineEvent, { type: 'DirectorProposed' }>;

export type ReduceError = { readonly seq: number; readonly code: string; readonly detail?: string };

/** 本回合实际裁决的行动：轮流对话中被打断的台词只算打断点之前的句子。 */
export function roundActions(s: Pick<RunState, 'proposals' | 'proposalsComplete'>): Action[] {
  const actions = [...s.proposals.values()].map((p) => p.action);
  const cut = s.proposalsComplete?.interruption;
  if (cut === null || cut === undefined) return actions;
  return actions.map((a) => (a.utterance === undefined ? a : { ...a, utterance: { ...a.utterance, deliveredCount: cut.after } }));
}

const presentActors = (sim: SimState): ActorId[] =>
  (Object.keys(sim.world.actors) as ActorId[]).filter((a) => sim.world.actors[a]?.status === 'present');

function phaseOf(s: Omit<RunState, 'phase'>, awaitingAuthor: boolean): Phase {
  if (s.endReason !== null) return 'Ended';
  if (s.pause !== null) return 'Paused';
  if (!s.inRound) {
    const { proposed, decided } = s.director;
    if (proposed !== null && !decided) {
      return s.config.mode === 'interactive' && proposed.event !== null ? 'AwaitingAuthor' : 'Directing';
    }
    return needsDirector(s) ? 'Directing' : 'BuildingViews';
  }
  const present = presentActors(s.sim);
  if (present.some((a) => !s.views.has(a))) return 'BuildingViews';
  if (s.proposalsComplete === null) return 'AwaitingProposals';
  if (!s.committed) {
    if (awaitingAuthor) return 'AwaitingAuthor';
    // 以本回合需要的全部请求为准：只看“已提出的都已确认”会在后一条还没提出时就去提交。
    const pending = s.adjudication?.ok === true ? s.adjudication.value.pending : [];
    return pending.length > 0 && pending.every((r) => s.rulingsConfirmed.has(r.id)) ? 'Committing' : 'Adjudicating';
  }
  if (!s.evidenceChecked) return 'UpdatingBeliefs';
  return 'CheckingEnd';
}

/** 当前回合（尚未结束）的记录：本回合裁决的行动与累计的变化。 */
export function currentRecord(s: Pick<RunState, 'sim' | 'proposals' | 'current'>): RoundRecord {
  return {
    round: s.sim.round,
    actions: [...s.proposals.values()].map((p) => p.action),
    changed: s.current.changed,
    occurrences: s.current.occurrences,
  };
}

/** 刚结束的回合边界上是否需要询问导演。 */
function needsDirector(s: Omit<RunState, 'phase'>): boolean {
  const d = s.config.director;
  const round = s.sim.round;
  if (!d.enabled || round === 0 || s.director.proposed !== null || s.director.adopted >= d.maxProposals) return false;
  if (s.history.at(-1)?.round !== round || round >= s.config.maxRounds) return false;
  return d.trigger === 'curve' || s.stalemates.some((x) => x.round === round && x.kind !== 'goal_unreachable');
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
    'ViewBuilt',
    'ProposalSubmitted',
    'ProposalRejected',
    'ProposalsComplete',
    'AuthorIntervened',
    'KnowledgeEdited',
    'RunPaused',
    'RunEnded',
  ]),
  Adjudicating: new Set(['AdjudicationProposed', 'AdjudicationConfirmed', 'Committed', 'RunPaused', 'RunEnded']),
  AwaitingAuthor: new Set(['AdjudicationProposed', 'AdjudicationConfirmed', 'DirectorDecided', 'RunPaused', 'RunEnded']),
  Directing: new Set(['DirectorProposed', 'DirectorDecided', 'RunPaused', 'RunEnded']),
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
  CheckingEnd: new Set(['StalemateDetected', 'RoundEnded', 'RunEnded', 'RunPaused']),
  Paused: new Set([
    'ViewBuilt',
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
    adjudication: null,
    rulingsProposed: new Map(),
    rulingsConfirmed: new Map(),
    committed: false,
    reviewed: new Set(),
    evidenceChecked: false,
    floor: firstFloor,
    needsReview: [],
    history: [],
    current: { changed: false, occurrences: [] },
    stalemates: [],
    director: { proposed: null, decided: false, adopted: 0 },
    redo: new Map(),
  };
  let awaitingAuthor = false;
  const redoOnce = (subject: ActorId | 'all') => {
    s.redo = new Map([...s.redo, [subject, (s.redo.get(subject) ?? 0) + 1]]);
  };

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
        s.adjudication = null;
        s.rulingsProposed = new Map();
        s.rulingsConfirmed = new Map();
        s.committed = false;
        s.reviewed = new Set();
        s.evidenceChecked = false;
        s.director = { proposed: null, decided: false, adopted: s.director.adopted };
        s.redo = new Map();
      }
      // 作者改了认知，这个人之后的请求内容随之改变：换新的步骤键，不与改之前（取消或崩溃时）留下的记录冲突。
      if (event.type === 'KnowledgeEdited') redoOnce(event.actor);
      if (event.type === 'StateChanged') {
        // 回合之间的导演与作者事件也累计进来，计入下一回合的记录。
        s.current = {
          changed: s.current.changed || event.effects.some((e) => e.type !== 'advanceRng'),
          occurrences: [...s.current.occurrences, ...event.occurrences],
        };
      }
      continue;
    }

    switch (event.type) {
      case 'RunStarted':
        return err({ seq: stored.seq, code: 'duplicate_start' });
      case 'ViewBuilt':
        // 回合内作者改认知后会再记一次，记下改后的视图哈希。
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
      case 'ProposalsComplete': {
        s.proposalsComplete = event;
        const adj = adjudicate(scene, s.sim, roundActions(s));
        s.adjudication = adj.ok ? adj : err(adj.error.code);
        // 被打断时，本回合听者的回应都是看过没说出口的句子后形成的，作废；轮到他们发言时按实际听到的再问。
        if (event.interruption !== null) s.prepared = new Map([...s.prepared].filter(([, p]) => p.round !== event.round));
        break;
      }
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
        s.history = [...s.history, currentRecord(s)];
        s.current = { changed: false, occurrences: [] };
        break;
      case 'StalemateDetected':
        s.stalemates = [...s.stalemates, { round: event.round, kind: event.kind }];
        break;
      case 'DirectorProposed':
        s.director = { proposed: event, decided: false, adopted: s.director.adopted };
        break;
      case 'DirectorDecided':
        if (s.director.proposed === null) return err({ seq: stored.seq, code: 'decide_without_proposal' });
        s.director = { ...s.director, decided: true, adopted: s.director.adopted + (event.accepted ? 1 : 0) };
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
        if (event.retry !== undefined) redoOnce(event.retry);
        break;
      case 'RunEnded':
        s.endReason = event.reason;
        break;
    }
  }

  return ok({ ...s, phase: phaseOf(s, awaitingAuthor) });
}

export { presentActors };

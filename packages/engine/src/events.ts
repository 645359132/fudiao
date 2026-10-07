import type {
  Action,
  ActorId,
  DomainEvent,
  KnowledgeEdited,
  RuleViolation,
  SecretId,
  SemanticRuling,
} from '@novel-writer/domain';
import type { ActionProposal } from '@novel-writer/prompts';
import type { RunConfig } from './config';

export type EndReason = 'max_rounds' | 'actors_left' | 'budget' | 'author_stop';

export type PauseReason =
  | 'author'
  | 'proposal_invalid'
  | 'llm_error'
  | 'refused'
  | 'truncated'
  | 'invalid_output'
  | 'ruling_invalid';

/** 引擎自己的事件。与领域事件一起组成推演运行的事件记录（sim_event），只追加。 */
export type EngineEvent =
  | {
      readonly type: 'RunStarted';
      readonly sceneHash: string;
      readonly config: RunConfig;
      /** 由分支生成时的来源。 */
      readonly parent?: { readonly runId: string; readonly seq: number };
    }
  | { readonly type: 'ViewBuilt'; readonly round: number; readonly actor: ActorId; readonly viewHash: string }
  | {
      readonly type: 'ProposalSubmitted';
      readonly round: number;
      readonly actor: ActorId;
      /** 这次提案用于哪一回合：轮流对话中听者的回应留到他持有发言权的回合。 */
      readonly forRound: number;
      readonly attempt: number;
      readonly source: 'model' | 'author' | 'prepared';
      readonly stepKey: string | null;
      readonly proposal: ActionProposal | null;
      readonly action: Action;
    }
  | {
      readonly type: 'ProposalRejected';
      readonly round: number;
      readonly actor: ActorId;
      readonly attempt: number;
      readonly violation: RuleViolation;
    }
  | {
      readonly type: 'ProposalsComplete';
      readonly round: number;
      /** 轮流对话中最早的打断：谁在第几句之后打断了持有发言权的人。 */
      readonly interruption: { readonly by: ActorId; readonly after: number } | null;
    }
  | {
      readonly type: 'AdjudicationProposed';
      readonly round: number;
      readonly requestId: string;
      readonly ruling: SemanticRuling;
      readonly rationale: string;
      readonly uncertainties: readonly string[];
    }
  | {
      readonly type: 'AdjudicationConfirmed';
      readonly round: number;
      readonly requestId: string;
      readonly ruling: SemanticRuling;
      readonly by: 'author' | 'auto';
      /** 自动接受的裁决在采纳进作品前必须逐项经作者复核。 */
      readonly needsReview: boolean;
    }
  | { readonly type: 'Committed'; readonly round: number; readonly origin: 'round' | 'intervention' }
  | { readonly type: 'BeliefsReviewed'; readonly round: number; readonly actor: ActorId }
  | {
      readonly type: 'EvidenceGapFlagged';
      readonly round: number;
      readonly actor: ActorId;
      readonly secret: SecretId;
      readonly inference: string;
      readonly explanation: string;
    }
  | { readonly type: 'EvidenceChecked'; readonly round: number }
  | {
      readonly type: 'AuthorIntervened';
      readonly round: number;
      readonly kind: 'replace_action' | 'edit_knowledge' | 'external_event';
      readonly reason: string;
      readonly stateHashBefore: string;
      readonly actor?: ActorId;
    }
  | { readonly type: 'RoundEnded'; readonly round: number; readonly stateHash: string; readonly nextFloor: ActorId | null }
  | { readonly type: 'RunPaused'; readonly reason: PauseReason; readonly actor?: ActorId; readonly detail?: string }
  | { readonly type: 'RunResumed' }
  | { readonly type: 'RunEnded'; readonly reason: EndReason };

export type RunEvent = EngineEvent | DomainEvent | KnowledgeEdited;

const DOMAIN_TYPES: ReadonlySet<string> = new Set([
  'RoundStarted',
  'StateChanged',
  'PerceptionDelivered',
  'BeliefsUpdated',
  'KnowledgeEdited',
]);

export const isDomainEvent = (e: RunEvent): e is DomainEvent | KnowledgeEdited => DOMAIN_TYPES.has(e.type);

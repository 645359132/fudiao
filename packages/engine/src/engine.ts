import {
  adjudicate,
  applyEffects,
  buildCharacterView,
  checkAction,
  checkRulingScope,
  commitExternal,
  commitRound,
  deliveredSentences,
  planBeliefUpdate,
  planKnowledgeEdit,
  screenSecretInferences,
  startRound,
  stateHash,
  type Action,
  type ActorId,
  type Adjudication,
  type AuthorKnowledge,
  type ExternalEvent,
  type KnowledgeId,
  type RulingRequest,
  type Scene,
  type SemanticRuling,
  type SimState,
  applyEvent,
} from '@fudiao/domain';
import {
  structured,
  withBudget,
  withCallLog,
  type BudgetGuard,
  type CallLog,
  type LlmMessage,
  type LlmPort,
  type LlmRequest,
  type StructuredError,
  type TaskKind,
} from '@fudiao/llm';
import {
  ActionProposal,
  BeliefUpdateOutput,
  DirectorProposalOutput,
  EvidenceJudgementOutput,
  SemanticRulingOutput,
  StalemateJudgementOutput,
  renderActionRejected,
  renderBeliefUpdate,
  renderCharacterAction,
  renderDirectorProposal,
  renderEvidenceJudgement,
  renderSemanticRuling,
  renderStalemateJudgement,
  renderStructuredRepair,
  type RenderedPrompt,
} from '@fudiao/prompts';
import type { EventStore } from '@fudiao/store';
import { canonicalJson, err, ok, sha256, type Result } from '@fudiao/shared';
import type { z } from 'zod';
import type { RunConfig, TaskModel } from './config';
import { beliefProposal, directorEvent, proposalToAction, rulingFromOutput } from './convert';
import type { EndReason, EngineEvent, PauseReason, RunEvent, StalemateKind } from './events';
import {
  currentRecord,
  presentActors,
  reduceRun,
  type DirectorProposal,
  type Phase,
  type RunState,
  type RulingProposal,
} from './run-state';
import { detectStalemate } from './stalemate';

export type EngineDeps = {
  readonly llm: LlmPort;
  readonly events: EventStore;
  readonly calls: CallLog;
  /** 当前 UTC 时间（ISO 字符串）。 */
  readonly now: () => string;
  readonly budget?: BudgetGuard;
};

export type RunStatus = {
  readonly runId: string;
  readonly round: number;
  readonly phase: Phase;
  readonly state: RunState;
  /** 等待作者确认的裁决。 */
  readonly awaiting: readonly RulingProposal[];
  /** 等待作者决定是否采用的导演提议。 */
  readonly awaitingDirector: DirectorProposal | null;
};

export type EngineError = {
  readonly code:
    | 'not_started'
    | 'already_started'
    | 'scene_mismatch'
    | 'corrupt_log'
    | 'conflict'
    | 'invalid_phase'
    | 'invalid_ruling'
    | 'invalid_intervention';
  readonly detail?: string;
};

export type Intervention =
  | { readonly kind: 'replace_action'; readonly action: Action; readonly reason: string }
  | {
      readonly kind: 'edit_knowledge';
      readonly actor: ActorId;
      readonly add: readonly AuthorKnowledge[];
      readonly retract: readonly KnowledgeId[];
      readonly reason: string;
    }
  | { readonly kind: 'external_event'; readonly event: ExternalEvent; readonly reason: string };

export const sceneHash = (scene: Scene): string => sha256(canonicalJson(scene));

const byActor = <T extends { readonly actor: string }>(a: T, b: T) => (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0);

const STOP_PHASES: ReadonlySet<Phase> = new Set(['AwaitingAuthor', 'Paused', 'Ended']);

/** 一次模型步骤的结果：成功、需要暂停或结束运行、或被取消（不写入任何事件）。 */
type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'stop'; readonly event: EngineEvent }
  | { readonly kind: 'cancelled' };

function stopFor(error: StructuredError, actor?: ActorId): Outcome<never> {
  const withActor = actor === undefined ? {} : { actor };
  switch (error.code) {
    case 'call_failed':
      if (error.error.code === 'budget_exceeded') return { kind: 'stop', event: { type: 'RunEnded', reason: 'budget' } };
      return { kind: 'stop', event: { type: 'RunPaused', reason: 'llm_error', ...withActor, detail: error.error.code } };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'invalid_output':
      return { kind: 'stop', event: { type: 'RunPaused', reason: 'invalid_output', ...withActor, detail: error.issues.join('；') } };
    case 'refused':
      return {
        kind: 'stop',
        event: { type: 'RunPaused', reason: 'refused', ...withActor, detail: error.result.refusal?.category ?? '' },
      };
    case 'truncated':
      return { kind: 'stop', event: { type: 'RunPaused', reason: 'truncated', ...withActor } };
  }
}

function unwrapPrompt<T>(rendered: Result<T, string>): T {
  // 模板渲染失败说明模板或渲染模型有缺陷，由提示词测试覆盖；运行中出现即为程序错误。
  if (!rendered.ok) throw new Error(`提示词渲染失败：${rendered.error}`);
  return rendered.value;
}

/** 推演引擎：编排回合状态机，状态只由事件记录归约得到，任何时刻中断都能从记录恢复。 */
export function createEngine(deps: EngineDeps) {
  const port = withCallLog(deps.budget ? withBudget(deps.llm, deps.budget) : deps.llm, deps.calls, deps.now);
  const repairMessage = (issues: readonly string[]) => unwrapPrompt(renderStructuredRepair(issues));

  async function load(runId: string, scene: Scene): Promise<Result<RunState, EngineError>> {
    const stored = await deps.events.read(runId);
    if (stored.length === 0) return err({ code: 'not_started' });
    const state = reduceRun(scene, runId, stored);
    if (!state.ok) return err({ code: 'corrupt_log', detail: `${state.error.seq}: ${state.error.code} ${state.error.detail ?? ''}` });
    if (state.value.sceneHash !== sceneHash(scene)) return err({ code: 'scene_mismatch' });
    return state;
  }

  async function append(state: RunState, payloads: readonly RunEvent[]): Promise<Result<void, EngineError>> {
    if (payloads.length === 0) return ok(undefined);
    const result = await deps.events.append(state.runId, state.lastSeq, payloads, deps.now());
    return result.ok ? ok(undefined) : err({ code: 'conflict', detail: `${result.error.expected}/${result.error.actual}` });
  }

  const status = (state: RunState): RunStatus => ({
    runId: state.runId,
    round: state.sim.round,
    phase: state.phase,
    state,
    awaiting: [...state.rulingsProposed.values()].filter((p) => !state.rulingsConfirmed.has(p.requestId)),
    awaitingDirector:
      !state.inRound && (state.director.proposed?.event ?? null) !== null && !state.director.decided ? state.director.proposed : null,
  });

  function request(
    task: TaskKind,
    model: TaskModel,
    prompt: RenderedPrompt,
    stepKey: string,
    extra: readonly LlmMessage[] = [],
    repairOf?: readonly string[],
  ): LlmRequest {
    return {
      task,
      model: model.profile,
      template: prompt.template,
      system: prompt.system,
      messages: [...prompt.messages, ...extra],
      ...(prompt.output !== undefined && { output: prompt.output }),
      maxOutputTokens: model.maxOutputTokens,
      ...(model.effort !== undefined && { effort: model.effort }),
      stepKey,
      ...(repairOf !== undefined && { repairOf }),
    };
  }

  async function call<T>(
    schema: z.ZodType<T>,
    req: LlmRequest,
    config: RunConfig,
    signal: AbortSignal | undefined,
    actor?: ActorId,
  ): Promise<Outcome<T>> {
    const result = await structured(port, schema, req, {
      maxRepairs: config.maxRepairs,
      repairMessage,
      ...(signal !== undefined && { signal }),
    });
    return result.ok ? { kind: 'ok', value: result.value.value } : stopFor(result.error, actor);
  }

  // —— 收集提案 ——

  async function askProposal(
    state: RunState,
    scene: Scene,
    actor: ActorId,
    options: { readonly forRound: number; readonly pendingSpeech?: { speaker: ActorId; sentences: readonly string[] } },
    signal: AbortSignal | undefined,
  ): Promise<Outcome<{ proposal: ActionProposal; action: Action; attempt: number; stepKey: string }>> {
    const { config, sim, runId } = state;
    const view = buildCharacterView(scene, sim, actor);
    const prompt = unwrapPrompt(
      renderCharacterAction(
        view,
        config.protocol === 'simultaneous'
          ? { protocol: 'simultaneous' }
          : { protocol: 'turn_based', ...(options.pendingSpeech && { pendingSpeech: options.pendingSpeech }) },
      ),
    );
    const responding = options.forRound !== sim.round;
    const rejections = responding ? [] : (state.rejections.get(actor) ?? []);
    const extra: LlmMessage[] = rejections.flatMap((r) => [
      { role: 'assistant' as const, content: JSON.stringify(r.proposal.proposal ?? r.proposal.action) },
      {
        role: 'user' as const,
        content: unwrapPrompt(renderActionRejected(view, r.violation)).messages.map((m) => m.content).join('\n'),
      },
    ]);
    const attempt = rejections.length;
    const stepKey = `${runId}:${sim.round}:${responding ? 'respond' : 'propose'}:${actor}:${attempt}`;
    const outcome = await call(
      ActionProposal,
      request('character_action', config.models.character_action, prompt, stepKey, extra),
      config,
      signal,
      actor,
    );
    if (outcome.kind !== 'ok') return outcome;
    return { kind: 'ok', value: { proposal: outcome.value, action: proposalToAction(outcome.value, actor), attempt, stepKey } };
  }

  function submission(
    state: RunState,
    scene: Scene,
    record: Omit<Extract<EngineEvent, { type: 'ProposalSubmitted' }>, 'type' | 'round'>,
  ): EngineEvent[] {
    const submitted: EngineEvent = { type: 'ProposalSubmitted', round: state.sim.round, ...record };
    if (record.forRound !== state.sim.round) return [submitted];
    const check = checkAction(scene, state.sim, record.action);
    if (check.kind !== 'reject') return [submitted];
    return [submitted, { type: 'ProposalRejected', round: state.sim.round, actor: record.actor, attempt: record.attempt, violation: check.violation }];
  }

  async function stepProposals(state: RunState, scene: Scene, signal?: AbortSignal): Promise<RunEvent[] | 'cancelled'> {
    const { config, sim } = state;
    const present = presentActors(sim).sort();

    for (const [actor, rejections] of state.rejections) {
      if (!state.proposals.has(actor) && rejections.length > config.maxProposalAttempts) {
        return [{ type: 'RunPaused', reason: 'proposal_invalid', actor, detail: rejections.at(-1)?.violation.code ?? '' }];
      }
    }

    const events: RunEvent[] = [];
    const gather = async (
      jobs: readonly { actor: ActorId; forRound: number; pendingSpeech?: { speaker: ActorId; sentences: readonly string[] } }[],
    ): Promise<'cancelled' | 'stopped' | Map<ActorId, EngineEvent[]>> => {
      const results = await Promise.all(
        jobs.map(async (job) => ({ job, outcome: await askProposal(state, scene, job.actor, job, signal) })),
      );
      const accepted = new Map<ActorId, EngineEvent[]>();
      let stop: EngineEvent | undefined;
      // 按角色标识排序后写入，与响应到达顺序无关（硬性规则 6）。
      for (const { job, outcome } of [...results].sort((a, b) => byActor(a.job, b.job))) {
        if (outcome.kind === 'cancelled') return 'cancelled';
        if (outcome.kind === 'stop') {
          stop ??= outcome.event;
          continue;
        }
        const recorded = submission(state, scene, {
          actor: job.actor,
          forRound: job.forRound,
          attempt: outcome.value.attempt,
          source: 'model',
          stepKey: outcome.value.stepKey,
          proposal: outcome.value.proposal,
          action: outcome.value.action,
        });
        accepted.set(job.actor, recorded);
        events.push(...recorded);
      }
      if (stop !== undefined) {
        events.push(stop);
        return 'stopped';
      }
      return accepted;
    };

    if (config.protocol === 'simultaneous') {
      const missing = present.filter((a) => !state.proposals.has(a));
      const result = await gather(missing.map((actor) => ({ actor, forRound: sim.round })));
      if (result === 'cancelled') return 'cancelled';
      if (result === 'stopped') return events;
      const passedAll = missing.every((a) => result.get(a)?.every((e) => e.type !== 'ProposalRejected') === true);
      if (passedAll) events.push({ type: 'ProposalsComplete', round: sim.round, interruption: null });
      return events;
    }

    // 轮流对话：持有发言权的人先行动；他说话时，其余在场的人用一次调用决定回应与打断点。
    const floor = state.floor;
    if (floor === null || !present.includes(floor)) {
      return [{ type: 'ProposalsComplete', round: sim.round, interruption: null }];
    }
    const own = state.proposals.get(floor);
    if (own === undefined) {
      const prepared = state.prepared.get(floor);
      if (prepared !== undefined && prepared.forRound === sim.round && !state.rejections.has(floor)) {
        events.push(
          ...submission(state, scene, {
            actor: floor,
            forRound: sim.round,
            attempt: 0,
            source: 'prepared',
            stepKey: prepared.stepKey,
            proposal: prepared.proposal,
            action: prepared.action,
          }),
        );
        return events;
      }
      const result = await gather([{ actor: floor, forRound: sim.round }]);
      return result === 'cancelled' ? 'cancelled' : events;
    }

    const sentences = own.action.kind === 'speak' && own.action.utterance ? own.action.utterance.sentences : [];
    const listeners = present.filter((a) => a !== floor);
    if (sentences.length > 0) {
      const waiting = listeners.filter((a) => state.prepared.get(a)?.round !== sim.round);
      if (waiting.length > 0) {
        const result = await gather(
          waiting.map((actor) => ({ actor, forRound: sim.round + 1, pendingSpeech: { speaker: floor, sentences } })),
        );
        if (result === 'cancelled') return 'cancelled';
        if (result === 'stopped') return events;
      }
    }

    // 最早的打断点决定说话者实际说出的句数；同一句之后打断的，按角色标识取第一个。
    const responses = listeners
      .map((a) => {
        const fromBatch = events.find((e) => e.type === 'ProposalSubmitted' && e.actor === a);
        return (fromBatch?.type === 'ProposalSubmitted' ? fromBatch : state.prepared.get(a)) ?? undefined;
      })
      .filter((p) => p !== undefined && p.round === sim.round);
    let interruption: { by: ActorId; after: number } | null = null;
    for (const p of responses) {
      const after = p?.proposal?.interruptAfter ?? null;
      if (p === undefined || after === null || after >= sentences.length) continue;
      if (interruption === null || after < interruption.after) interruption = { by: p.actor, after };
    }
    events.push({ type: 'ProposalsComplete', round: sim.round, interruption });
    return events;
  }

  // —— 裁决 ——

  function roundActions(state: RunState): Action[] {
    const actions = [...state.proposals.values()].map((p) => p.action);
    const cut = state.proposalsComplete?.interruption;
    if (cut === null || cut === undefined) return actions;
    return actions.map((a) =>
      a.utterance === undefined ? a : { ...a, utterance: { ...a.utterance, deliveredCount: cut.after } },
    );
  }

  function adjudication(state: RunState, scene: Scene): Result<Adjudication, string> {
    const result = adjudicate(scene, state.sim, roundActions(state));
    return result.ok ? result : err(result.error.code);
  }

  /** 校验一条裁决：范围、不变式。返回问题描述，交给模型修正或报告给作者。 */
  function rulingIssue(scene: Scene, state: RunState, adj: Adjudication, req: RulingRequest, ruling: SemanticRuling): string | null {
    const afterProgram = applyEffects(scene, state.sim, adj.effects);
    if (!afterProgram.ok) return `program: ${afterProgram.error.code}`;
    const scope = checkRulingScope(scene, req, state.sim, afterProgram.value, ruling);
    if (!scope.ok) return `${scope.error.part}s[${scope.error.index}]: ${scope.error.code} ${scope.error.ref ?? ''}`.trim();
    const applied = applyEffects(scene, afterProgram.value, ruling.effects);
    if (!applied.ok) return `effects[${applied.error.index}]: ${applied.error.code} ${applied.error.ref ?? ''}`.trim();
    return null;
  }

  async function askRuling(
    state: RunState,
    scene: Scene,
    adj: Adjudication,
    req: RulingRequest,
    signal: AbortSignal | undefined,
  ): Promise<Outcome<{ ruling: SemanticRuling; rationale: string; uncertainties: readonly string[] }>> {
    const { config, sim, runId } = state;
    const prompt = unwrapPrompt(renderSemanticRuling({ scene, state: sim, adjudication: adj, request: req }));
    const extra: LlmMessage[] = [];
    let previousIssue: string | undefined;
    for (let attempt = 0; attempt <= config.maxRepairs; attempt++) {
      const stepKey = `${runId}:${sim.round}:rule:${req.id}:${attempt}`;
      const repairOf = previousIssue === undefined ? undefined : [previousIssue];
      const outcome = await call(SemanticRulingOutput, request('semantic_ruling', config.models.semantic_ruling, prompt, stepKey, extra, repairOf), config, signal);
      if (outcome.kind !== 'ok') return outcome;
      const converted = rulingFromOutput(req.id, outcome.value);
      const issue = converted.ok ? rulingIssue(scene, state, adj, req, converted.value) : `effects[${converted.error.index}]: ${converted.error.issue}`;
      if (issue === null && converted.ok) {
        return { kind: 'ok', value: { ruling: converted.value, rationale: outcome.value.rationale, uncertainties: outcome.value.uncertainties } };
      }
      previousIssue = issue ?? '';
      extra.push({ role: 'assistant', content: JSON.stringify(outcome.value) }, { role: 'user', content: repairMessage([previousIssue]) });
    }
    return { kind: 'stop', event: { type: 'RunPaused', reason: 'ruling_invalid', detail: req.id } };
  }

  async function stepAdjudicating(state: RunState, scene: Scene, signal?: AbortSignal): Promise<RunEvent[] | 'cancelled'> {
    const adj = adjudication(state, scene);
    if (!adj.ok) return [{ type: 'RunPaused', reason: 'ruling_invalid', detail: adj.error }];
    const round = state.sim.round;
    if (adj.value.pending.length === 0) return commitEvents(state, scene, adj.value);

    const missing = adj.value.pending.filter((r) => !state.rulingsProposed.has(r.id));
    const events: RunEvent[] = [];
    const results = await Promise.all(missing.map(async (req) => ({ req, outcome: await askRuling(state, scene, adj.value, req, signal) })));
    for (const { req, outcome } of results) {
      if (outcome.kind === 'cancelled') return 'cancelled';
      if (outcome.kind === 'stop') return [...events, outcome.event];
      events.push({ type: 'AdjudicationProposed', round, requestId: req.id, ...outcome.value });
      if (state.config.mode === 'auto') {
        // 自动模式：自动接受并标记待复核，采纳进作品前必须逐项经作者复核。
        events.push({ type: 'AdjudicationConfirmed', round, requestId: req.id, ruling: outcome.value.ruling, by: 'auto', needsReview: true });
      }
    }
    return events;
  }

  function commitEvents(state: RunState, scene: Scene, adj: Adjudication): RunEvent[] {
    const rulings = adj.pending.flatMap((r) => {
      const confirmed = state.rulingsConfirmed.get(r.id);
      return confirmed === undefined ? [] : [confirmed.ruling];
    });
    const committed = commitRound(scene, state.sim, adj, rulings);
    if (!committed.ok) return [{ type: 'RunPaused', reason: 'ruling_invalid', detail: committed.error.code }];
    return [{ type: 'Committed', round: state.sim.round, origin: 'round' }, ...committed.value.events];
  }

  // —— 更新认知与证据链 ——

  async function stepBeliefs(state: RunState, scene: Scene, signal?: AbortSignal): Promise<RunEvent[] | 'cancelled'> {
    const { sim, config, runId } = state;
    const round = sim.round;
    const pending = [...state.views].filter((a) => !state.reviewed.has(a)).sort();

    if (pending.length > 0) {
      const results = await Promise.all(
        pending.map(async (actor) => {
          const present = sim.world.actors[actor]?.status === 'present';
          const fresh = (sim.knowledge[actor] ?? []).filter((k) => k.round === round && k.status === 'active').map((k) => k.id);
          const own = state.proposals.get(actor);
          const inferences = own?.proposal?.inferences ?? [];
          if (!present || (fresh.length === 0 && inferences.length === 0)) {
            return { actor, outcome: { kind: 'ok' as const, value: [] as RunEvent[] } };
          }
          const view = buildCharacterView(scene, sim, actor);
          let output: BeliefUpdateOutput | null = null;
          if (fresh.length > 0) {
            const prompt = unwrapPrompt(renderBeliefUpdate(view, fresh));
            const outcome = await call(
              BeliefUpdateOutput,
              request('belief_update', config.models.belief_update, prompt, `${runId}:${round}:beliefs:${actor}:0`),
              config,
              signal,
              actor,
            );
            if (outcome.kind !== 'ok') return { actor, outcome };
            output = outcome.value;
          }
          const plan = planBeliefUpdate(scene, sim, actor, beliefProposal(view, inferences, output));
          // 模型提出的条目无法通过校验时只保留修改与撤回；推测已按视图过滤，通常不会走到这里。
          const fallback = plan.ok ? plan : planBeliefUpdate(scene, sim, actor, { revise: [], retract: [] });
          return { actor, outcome: { kind: 'ok' as const, value: fallback.ok ? [fallback.value] : [] } };
        }),
      );
      const events: RunEvent[] = [];
      // 新增条目的标识按该角色已有条目数分配，各角色互不影响，按角色顺序写入即可。
      for (const { actor, outcome } of results) {
        if (outcome.kind === 'cancelled') return 'cancelled';
        if (outcome.kind === 'stop') return [...events, outcome.event];
        events.push(...outcome.value, { type: 'BeliefsReviewed', round, actor });
      }
      return events;
    }

    // 证据链：本回合新增的推测与秘密有关时，请求命中判断；只作提示，不作结论（B44）。
    // 各人的判断互不依赖，同时发出；结果按角色标识的顺序写入，与响应的到达顺序无关。
    const results = await Promise.all(
      [...state.views].sort().map(async (actor) => {
        const inferred = (sim.knowledge[actor] ?? []).filter((k) => k.round === round && k.modality === 'inferred' && k.status === 'active');
        const candidates = screenSecretInferences(scene, sim, actor, inferred);
        if (candidates.length === 0) return { actor, candidates, outcome: null };
        // 对照这个人物不知道的全部秘密（不随回合变化），请求的开头才能在前后几回合之间保持一致。
        const secrets = scene.secrets.filter((s) => !s.knownBy.includes(actor)).map((s) => ({ id: s.id, text: s.text, subjects: [...s.subjects] }));
        const prompt = unwrapPrompt(renderEvidenceJudgement(buildCharacterView(scene, sim, actor), candidates, secrets));
        const outcome = await call(
          EvidenceJudgementOutput,
          request('judgement', config.models.judgement, prompt, `${runId}:${round}:evidence:${actor}:0`),
          config,
          signal,
          actor,
        );
        return { actor, candidates, outcome };
      }),
    );
    const events: RunEvent[] = [];
    for (const { actor, candidates, outcome } of results) {
      if (outcome === null) continue;
      if (outcome.kind === 'cancelled') return 'cancelled';
      if (outcome.kind === 'stop') return [...events, outcome.event];
      for (const j of outcome.value.judgements) {
        // 一条推测可能对照几个秘密，按推测与秘密一起对应。
        const candidate = candidates.find((c) => c.inference === j.inference && c.secret === j.secret);
        if (candidate !== undefined && j.hit && !j.supported) {
          events.push({ type: 'EvidenceGapFlagged', round, actor, secret: candidate.secret, inference: j.inference, explanation: j.explanation });
        }
      }
    }
    events.push({ type: 'EvidenceChecked', round });
    return events;
  }

  // —— 回合推进 ——

  function nextFloor(state: RunState, scene: Scene): ActorId | null {
    if (state.config.protocol !== 'turn_based') return null;
    const present = new Set(presentActors(state.sim));
    const cut = state.proposalsComplete?.interruption;
    if (cut && present.has(cut.by)) return cut.by;
    const order = scene.actors.map((a) => a.id);
    const at = state.floor === null ? -1 : order.indexOf(state.floor);
    for (let i = 1; i <= order.length; i++) {
      const candidate = order[(at + i) % order.length];
      if (candidate !== undefined && present.has(candidate)) return candidate;
    }
    return null;
  }

  // —— 僵局与导演（M0-07） ——

  async function stepCheckingEnd(state: RunState, scene: Scene, signal?: AbortSignal): Promise<RunEvent[] | 'cancelled'> {
    const { sim, config, runId } = state;
    const events: RunEvent[] = [];
    let found: StalemateKind | null = null;

    if (config.stalemate.enabled) {
      const last = state.stalemates.at(-1)?.round ?? 0;
      const records = [...state.history, currentRecord(state)];
      const check = detectStalemate(records, config.stalemate.window, last);
      let explanation = '';
      if (check?.kind === 'standoff' || check?.kind === 'repetition') {
        found = check.kind;
      } else if (check?.kind === 'needs_judgement' && config.models.stalemate !== undefined) {
        const recent = records.filter((r) => r.round > last).slice(-config.stalemate.window);
        const prompt = unwrapPrompt(renderStalemateJudgement(scene, recent.map((r) => ({ round: r.round, occurrences: r.occurrences }))));
        const outcome = await call(
          StalemateJudgementOutput,
          request('judgement', config.models.stalemate, prompt, `${runId}:${sim.round}:stalemate:all:0`),
          config,
          signal,
        );
        if (outcome.kind === 'cancelled') return 'cancelled';
        if (outcome.kind === 'stop') return [outcome.event];
        if (outcome.value.type !== 'none') {
          found = outcome.value.type;
          explanation = outcome.value.explanation;
        }
      }
      if (found !== null) events.push({ type: 'StalemateDetected', round: sim.round, kind: found, explanation });
    }

    events.push({ type: 'RoundEnded', round: sim.round, stateHash: stateHash(sim), nextFloor: nextFloor(state, scene) });
    let ended: EndReason | null = null;
    if (sim.round >= config.maxRounds) ended = 'max_rounds';
    else if (presentActors(sim).length < 2) ended = 'actors_left';
    // 自动模式记录僵局后继续，只有目标已无法达成时结束；交互模式一律暂停，交给作者。
    else if (found === 'goal_unreachable' && config.mode === 'auto') ended = 'stalemate';
    // 反复拉锯第一次记录并交给导演，再次出现说明局面推不动了，不再空转到回合上限。
    else if (found === 'circling' && config.mode === 'auto' && state.stalemates.filter((x) => x.kind === 'circling').length + 1 >= (config.stalemate.maxCircling ?? 2)) {
      ended = 'stalemate';
    }
    if (ended !== null) events.push({ type: 'RunEnded', reason: ended });
    else if (found !== null && config.mode === 'interactive') events.push({ type: 'RunPaused', reason: 'stalemate', detail: found });
    return events;
  }

  async function stepDirecting(state: RunState, scene: Scene, signal?: AbortSignal): Promise<RunEvent[] | 'cancelled'> {
    const { sim, config, runId } = state;
    const model = config.models.director;
    if (model === undefined) return [{ type: 'RunPaused', reason: 'llm_error', detail: 'director_model_missing' }];
    const stalemate = state.stalemates.find((x) => x.round === sim.round)?.kind;
    const prompt = unwrapPrompt(
      renderDirectorProposal({
        scene,
        state: sim,
        recent: state.history.slice(-2).map((r) => ({ round: r.round, occurrences: r.occurrences })),
        tensionCurve: config.director.tensionCurve,
        maxRounds: config.maxRounds,
        ...(config.director.trigger === 'stalemate' && stalemate !== undefined && stalemate !== 'goal_unreachable' && { stalemate }),
      }),
    );
    const outcome = await call(DirectorProposalOutput, request('director', model, prompt, `${runId}:${sim.round}:director:all:0`), config, signal);
    if (outcome.kind === 'cancelled') return 'cancelled';
    if (outcome.kind === 'stop') return [outcome.event];

    const event = directorEvent(outcome.value, scene, sim);
    // 预先确认注入可以成立；不成立的提议视为没有提议。
    const committed = event === null ? null : commitExternal(scene, sim, event);
    const usable = committed?.ok === true ? event : null;
    const events: RunEvent[] = [{ type: 'DirectorProposed', round: sim.round, rationale: outcome.value.rationale, event: usable }];
    if (usable === null) {
      events.push({ type: 'DirectorDecided', round: sim.round, accepted: false, by: 'auto' });
    } else if (config.mode === 'auto' && committed?.ok === true) {
      events.push(
        { type: 'DirectorDecided', round: sim.round, accepted: true, by: 'auto' },
        { type: 'Committed', round: sim.round, origin: 'director' },
        ...committed.value.events,
      );
    }
    return events;
  }

  async function stepOnce(state: RunState, scene: Scene, signal?: AbortSignal): Promise<RunEvent[] | 'cancelled'> {
    const { sim } = state;
    switch (state.phase) {
      case 'BuildingViews': {
        const events: RunEvent[] = [];
        let current: SimState = sim;
        if (!state.inRound) {
          const started = startRound(sim);
          const next = applyEvent(scene, sim, started);
          if (!next.ok) throw new Error('无法开始新回合');
          current = next.value;
          events.push(started);
        }
        for (const actor of presentActors(current).sort()) {
          if (state.views.has(actor)) continue;
          const viewHash = sha256(canonicalJson(buildCharacterView(scene, current, actor)));
          events.push({ type: 'ViewBuilt', round: current.round, actor, viewHash });
        }
        return events;
      }
      case 'AwaitingProposals':
        return stepProposals(state, scene, signal);
      case 'Adjudicating':
        return stepAdjudicating(state, scene, signal);
      case 'Committing': {
        const adj = adjudication(state, scene);
        return adj.ok ? commitEvents(state, scene, adj.value) : [{ type: 'RunPaused', reason: 'ruling_invalid', detail: adj.error }];
      }
      case 'UpdatingBeliefs':
        return stepBeliefs(state, scene, signal);
      case 'CheckingEnd':
        return stepCheckingEnd(state, scene, signal);
      case 'Directing':
        return stepDirecting(state, scene, signal);
      case 'AwaitingAuthor':
      case 'Paused':
      case 'Ended':
        return [];
    }
  }

  async function step(runId: string, scene: Scene, options: { signal?: AbortSignal } = {}): Promise<Result<RunStatus, EngineError>> {
    const loaded = await load(runId, scene);
    if (!loaded.ok) return loaded;
    const events = await stepOnce(loaded.value, scene, options.signal);
    if (events === 'cancelled') return ok(status(loaded.value));
    const appended = await append(loaded.value, events);
    if (!appended.ok) return appended;
    const next = await load(runId, scene);
    return next.ok ? ok(status(next.value)) : next;
  }

  return {
    async start(runId: string, scene: Scene, config: RunConfig): Promise<Result<RunStatus, EngineError>> {
      if ((await deps.events.read(runId)).length > 0) return err({ code: 'already_started' });
      const started = await deps.events.append(runId, 0, [{ type: 'RunStarted', sceneHash: sceneHash(scene), config }], deps.now());
      if (!started.ok) return err({ code: 'conflict' });
      const loaded = await load(runId, scene);
      return loaded.ok ? ok(status(loaded.value)) : loaded;
    },

    step,

    /** 连续推进，直到等待作者、暂停、结束或被取消。 */
    async run(runId: string, scene: Scene, options: { signal?: AbortSignal; maxSteps?: number } = {}): Promise<Result<RunStatus, EngineError>> {
      let last: Result<RunStatus, EngineError> = await step(runId, scene, options);
      for (let i = 0; i < (options.maxSteps ?? 10_000); i++) {
        if (!last.ok || STOP_PHASES.has(last.value.phase) || options.signal?.aborted === true) return last;
        last = await step(runId, scene, options);
      }
      return last;
    },

    async status(runId: string, scene: Scene): Promise<Result<RunStatus, EngineError>> {
      const loaded = await load(runId, scene);
      return loaded.ok ? ok(status(loaded.value)) : loaded;
    },

    /** 作者确认（或修正）待核实裁决。确认前状态与角色反馈保持在提交前。 */
    async confirmRuling(runId: string, scene: Scene, requestId: string, ruling?: SemanticRuling): Promise<Result<RunStatus, EngineError>> {
      const loaded = await load(runId, scene);
      if (!loaded.ok) return loaded;
      const state = loaded.value;
      const proposed = state.rulingsProposed.get(requestId);
      if (state.phase !== 'AwaitingAuthor' || proposed === undefined || state.rulingsConfirmed.has(requestId)) {
        return err({ code: 'invalid_phase' });
      }
      const chosen = { ...(ruling ?? proposed.ruling), requestId };
      const adj = adjudication(state, scene);
      const req = adj.ok ? adj.value.pending.find((r) => r.id === requestId) : undefined;
      if (!adj.ok || req === undefined) return err({ code: 'invalid_ruling' });
      const issue = rulingIssue(scene, state, adj.value, req, chosen);
      if (issue !== null) return err({ code: 'invalid_ruling', detail: issue });
      const appended = await append(state, [
        { type: 'AdjudicationConfirmed', round: state.sim.round, requestId, ruling: chosen, by: 'author', needsReview: false },
      ]);
      if (!appended.ok) return appended;
      return this.status(runId, scene);
    },

    /** 作者决定是否采用导演提议（B47）。采用时在回合边界注入，按感知规则分发，标记为导演事件。 */
    async decideDirector(runId: string, scene: Scene, accept: boolean): Promise<Result<RunStatus, EngineError>> {
      const loaded = await load(runId, scene);
      if (!loaded.ok) return loaded;
      const state = loaded.value;
      const proposal = status(state).awaitingDirector;
      if (state.phase !== 'AwaitingAuthor' || proposal === null || proposal.event === null) return err({ code: 'invalid_phase' });
      const events: RunEvent[] = [{ type: 'DirectorDecided', round: state.sim.round, accepted: accept, by: 'author' }];
      if (accept) {
        const committed = commitExternal(scene, state.sim, proposal.event);
        if (!committed.ok) return err({ code: 'invalid_intervention', detail: committed.error.code });
        events.push({ type: 'Committed', round: state.sim.round, origin: 'director' }, ...committed.value.events);
      }
      const appended = await append(state, events);
      if (!appended.ok) return appended;
      return this.status(runId, scene);
    },

    /** 作者介入（B30）：记录介入类型、原因与介入前的状态哈希。 */
    async intervene(runId: string, scene: Scene, intervention: Intervention): Promise<Result<RunStatus, EngineError>> {
      const loaded = await load(runId, scene);
      if (!loaded.ok) return loaded;
      const state = loaded.value;
      const { sim } = state;
      const marker = (actor?: ActorId): EngineEvent => ({
        type: 'AuthorIntervened',
        round: sim.round,
        kind: intervention.kind,
        reason: intervention.reason,
        stateHashBefore: stateHash(sim),
        ...(actor !== undefined && { actor }),
      });
      let events: RunEvent[];
      switch (intervention.kind) {
        case 'replace_action': {
          const { action } = intervention;
          const allowed = state.phase === 'AwaitingProposals' || (state.phase === 'Paused' && state.inRound && state.proposalsComplete === null);
          if (!allowed || state.proposals.has(action.actor)) return err({ code: 'invalid_phase' });
          const check = checkAction(scene, sim, action);
          if (check.kind === 'reject') return err({ code: 'invalid_intervention', detail: check.violation.code });
          events = [
            marker(action.actor),
            {
              type: 'ProposalSubmitted',
              round: sim.round,
              actor: action.actor,
              forRound: sim.round,
              attempt: state.rejections.get(action.actor)?.length ?? 0,
              source: 'author',
              stepKey: null,
              proposal: null,
              action,
            },
          ];
          break;
        }
        case 'edit_knowledge': {
          const allowed = state.phase === 'BuildingViews' || state.phase === 'AwaitingProposals' || state.phase === 'Paused';
          if (!allowed) return err({ code: 'invalid_phase' });
          const planned = planKnowledgeEdit(scene, sim, intervention.actor, { add: intervention.add, retract: intervention.retract });
          if (!planned.ok) return err({ code: 'invalid_intervention', detail: planned.error.code });
          events = [marker(intervention.actor), planned.value];
          break;
        }
        case 'external_event': {
          const allowed = (state.phase === 'BuildingViews' && !state.inRound) || (state.phase === 'Paused' && !state.inRound);
          if (!allowed) return err({ code: 'invalid_phase' });
          const committed = commitExternal(scene, sim, intervention.event);
          if (!committed.ok) return err({ code: 'invalid_intervention', detail: committed.error.code });
          events = [marker(), { type: 'Committed', round: sim.round, origin: 'intervention' }, ...committed.value.events];
          break;
        }
      }
      const appended = await append(state, events);
      if (!appended.ok) return appended;
      return this.status(runId, scene);
    },

    async pause(runId: string, scene: Scene, reason: PauseReason = 'author'): Promise<Result<RunStatus, EngineError>> {
      const loaded = await load(runId, scene);
      if (!loaded.ok) return loaded;
      if (loaded.value.phase === 'Paused' || loaded.value.phase === 'Ended') return err({ code: 'invalid_phase' });
      const appended = await append(loaded.value, [{ type: 'RunPaused', reason }]);
      return appended.ok ? this.status(runId, scene) : appended;
    },

    async resume(runId: string, scene: Scene): Promise<Result<RunStatus, EngineError>> {
      const loaded = await load(runId, scene);
      if (!loaded.ok) return loaded;
      if (loaded.value.phase !== 'Paused') return err({ code: 'invalid_phase' });
      const appended = await append(loaded.value, [{ type: 'RunResumed' }]);
      return appended.ok ? this.status(runId, scene) : appended;
    },

    async stop(runId: string, scene: Scene): Promise<Result<RunStatus, EngineError>> {
      const loaded = await load(runId, scene);
      if (!loaded.ok) return loaded;
      if (loaded.value.phase === 'Ended') return err({ code: 'invalid_phase' });
      const appended = await append(loaded.value, [{ type: 'RunEnded', reason: 'author_stop' }]);
      return appended.ok ? this.status(runId, scene) : appended;
    },

    /** 从某个序号建立分支（新版本），原记录不动。序号必须落在批次边界上。 */
    async fork(runId: string, scene: Scene, uptoSeq: number, newRunId: string): Promise<Result<RunStatus, EngineError>> {
      const stored = (await deps.events.read(runId)).filter((e) => e.seq <= uptoSeq);
      const last = stored.at(-1);
      if (last === undefined || last.batch.index !== last.batch.size - 1) return err({ code: 'invalid_phase', detail: '不在批次边界' });
      if ((await deps.events.read(newRunId)).length > 0) return err({ code: 'already_started' });
      const [first, ...rest] = stored.map((e) => e.payload as RunEvent);
      if (first?.type !== 'RunStarted') return err({ code: 'corrupt_log' });
      const payloads: RunEvent[] = [{ ...first, parent: { runId, seq: uptoSeq } }, ...rest];
      const appended = await deps.events.append(newRunId, 0, payloads, deps.now());
      if (!appended.ok) return err({ code: 'conflict' });
      return this.status(newRunId, scene);
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;

/** 只读事件得到运行状态，不调用模型（硬性规则 9）。 */
export function replayRun(scene: Scene, runId: string, events: readonly { seq: number; payload: unknown }[]) {
  return reduceRun(scene, runId, events);
}

export { deliveredSentences };

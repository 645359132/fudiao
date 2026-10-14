// 角色推演的用例（需求 B22、B28、B30，施工文档 M4-01）：把 M0 的推演引擎接到桌面端。
// 事件写入作品库的 sim_event（只追加），模型经桌面端的适配器（凭据代理）调用，调用记录写入 llm_call（步骤键查重）。
// 引擎与领域内核的逻辑不在这里：这里只负责把场景、运行与模型配置交给引擎，并把引擎的状态写回运行记录（缓存）。
import { ActorId, buildCharacterView, ItemId, KnowledgeId, parseScene, stateHash, ZoneId, type ActionKind, type Scene, type SceneSpecInput } from '@fudiao/domain';
import {
  buildViewerData,
  createEngine,
  replayRun,
  rulingFromOutput,
  RunConfig,
  type EngineError,
  type Intervention,
  type Phase,
  type RunEvent,
  type RunStatus,
  type TaskModel,
  type ViewerData,
} from '@fudiao/engine';
import { BudgetGuard, type CallOptions, type LlmPort, type ModelProfile } from '@fudiao/llm';
import { renderSceneDraft, sceneDraftToSpec, SceneDraftOutput, SemanticRulingOutput } from '@fudiao/prompts';
import { err, ok, sha256, type Result } from '@fudiao/shared';
import {
  createSimRun,
  createSimScene,
  getSimRun,
  getSimScene,
  listRunCalls,
  listSimRuns,
  listSimScenes,
  listSimSnapshots,
  saveSimSnapshot,
  setSimRunProgress,
  sqlEventStore,
  updateSimScene,
  type RepoError,
  type SimRun,
  type SimRunProgress,
  type SimScene,
  type SimSceneFields,
  type SqlPort,
  type StoredEvent,
} from '@fudiao/store';
import type { AppError } from './errors';
import type { ProviderView } from './model-services';
import { projectCallLog, THINKING_ALLOWANCE, type modelRunner, type ModelChoice } from './model-runner';
import type { AppDeps } from './ports';
import { checkSceneConfig, describeSceneProblems } from './scene-editing';
import { describeEffect, describeOccurrence, forkLabel, rulingToOutput, type ForkPoint } from './sim-describe';

/** 给作者看的运行状态：运行记录，加上由事件得出的阶段与等待作者处理的事项。 */
export type SimRunView = {
  readonly run: SimRun;
  readonly phase: Phase;
  readonly round: number;
  /** 等待作者确认的待核实裁决数。 */
  readonly awaitingRulings: number;
  /** 是否有等待作者决定的导演提议。 */
  readonly awaitingDirector: boolean;
  readonly pause: RunStatus['state']['pause'];
  readonly endReason: RunStatus['state']['endReason'];
  /** 这次运行已用的费用（美元，来自调用记录）；unknownCostCalls 是费用未知的调用数。 */
  readonly spentUsd: number;
  readonly unknownCostCalls: number;
};

/** 一个回合的等待：从回合开始到回合结束经过的时间，与其中模型响应所占的时间（验收“推演等待”）。 */
export type RoundTiming = { readonly round: number; readonly waitMs: number | null; readonly modelMs: number; readonly calls: number };

/** 等待作者确认的裁决（B26）：效果与发生的事已写成文字；editable 是与裁决模型输出同一形式的 JSON，供作者修改。 */
export type PendingRuling = {
  readonly requestId: string;
  readonly rationale: string;
  readonly uncertainties: readonly string[];
  readonly effects: readonly string[];
  readonly occurrences: readonly string[];
  readonly editable: string;
};

/** 等待作者决定的导演提议。 */
export type PendingDirector = { readonly rationale: string; readonly effects: readonly string[]; readonly occurrences: readonly string[] };

/** 作者介入（B30）。键都是场景里的键；reason 记在运行记录里。 */
export type SimIntervention =
  | { readonly kind: 'external_event'; readonly zone: string; readonly visible: boolean; readonly loudness: number; readonly visual: string; readonly sound: string; readonly reason: string }
  | {
      readonly kind: 'edit_knowledge';
      readonly actor: string;
      readonly add: readonly { readonly text: string; readonly modality: 'observed' | 'heard' | 'inferred'; readonly confidence: number; readonly about: readonly string[] }[];
      readonly retract: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: 'replace_action';
      readonly actor: string;
      readonly action: {
        readonly kind: ActionKind;
        readonly target?: string;
        readonly item?: string;
        readonly toZone?: string;
        readonly sentences: readonly string[];
        readonly volume: 'whisper' | 'normal' | 'shout';
        readonly description?: string;
      };
      readonly reason: string;
    };

/** 推演工作区的数据（B28）：运行状态、按回合整理的时间线（全局局面与各角色所见）、每回合的等待时间，以及等作者处理的事。 */
export type SimRunDetail = {
  readonly view: SimRunView;
  readonly data: ViewerData | null;
  readonly timing: readonly RoundTiming[];
  readonly pendingRulings: readonly PendingRuling[];
  readonly pendingDirector: PendingDirector | null;
  /** 可以分出新推演的时点（记有快照的序号）。 */
  readonly forkPoints: readonly ForkPoint[];
  /** 每个角色此刻的认知条目（介入时选择要撤回的）。 */
  readonly knowledge: Readonly<Record<string, readonly { readonly id: string; readonly text: string }[]>>;
  /** 这次运行的场景里的角色、区域与物品（介入的表单用它们的键）。 */
  readonly cast: {
    readonly actors: readonly { readonly id: string; readonly name: string }[];
    readonly zones: readonly { readonly id: string; readonly name: string }[];
    readonly items: readonly { readonly id: string; readonly name: string }[];
  };
};

/** 界面给出的介入换成引擎的介入；键不合规则时抛出（调用方转成说明）。 */
function toIntervention(input: SimIntervention): Intervention {
  switch (input.kind) {
    case 'external_event':
      return {
        kind: 'external_event',
        reason: input.reason.trim(),
        event: {
          effects: [],
          occurrences: [
            {
              participants: [],
              zones: [ZoneId.parse(input.zone)],
              visible: input.visible,
              loudness: input.loudness,
              description: { ...(input.visual.trim() !== '' && { visual: input.visual.trim() }), ...(input.sound.trim() !== '' && { sound: input.sound.trim() }) },
            },
          ],
        },
      };
    case 'edit_knowledge':
      return {
        kind: 'edit_knowledge',
        reason: input.reason.trim(),
        actor: ActorId.parse(input.actor),
        add: input.add.map((k) => ({ text: k.text.trim(), modality: k.modality, confidence: k.confidence, about: [...k.about] })),
        retract: input.retract.map((id) => KnowledgeId.parse(id)),
      };
    case 'replace_action': {
      const a = input.action;
      return {
        kind: 'replace_action',
        reason: input.reason.trim(),
        action: {
          actor: ActorId.parse(input.actor),
          kind: a.kind,
          ...(a.target !== undefined && a.target !== '' && { target: a.target }),
          ...(a.item !== undefined && a.item !== '' && { item: ItemId.parse(a.item) }),
          ...(a.toZone !== undefined && a.toZone !== '' && { toZone: ZoneId.parse(a.toZone) }),
          ...(a.sentences.length > 0 && { utterance: { sentences: [...a.sentences], volume: a.volume } }),
          ...(a.description !== undefined && a.description.trim() !== '' && { description: a.description.trim() }),
        },
      };
    }
  }
}

export type SimRunOptions = {
  readonly mode: 'interactive' | 'auto';
  /** 费用上限（美元，B28）：预计将超出时不再发起新的调用，运行以“预算用完”结束。需要模型配置了价格。 */
  readonly budgetUsd?: number;
  /** 随机数种子；不给时由运行标识得出。种子写在运行的第一条事件里，回放不依赖这里的算法。 */
  readonly seed?: number;
};

/** 场景配置草稿（B39）：由一段描述生成，不保存；problems 是草稿里还不对的地方，作者修改后才能保存。 */
export type SceneDraft = { readonly config: SceneSpecInput; readonly problems: readonly string[] };

/** 场景配置草稿的输出上限：区域、角色、认知与规则合计几千字，另留出思考的余量。 */
export const SCENE_DRAFT_OUTPUT_TOKENS = 8_000 + THINKING_ALLOWANCE;

export type SimVerification = { readonly snapshots: number; readonly mismatchedSeqs: readonly number[] };

export type SimulationDeps = {
  readonly deps: AppDeps;
  readonly project: () => SqlPort | null;
  readonly defaultModel: () => Promise<Result<ModelChoice | null, AppError>>;
  /** 按标识找模型服务（运行配置里记的是服务标识）。 */
  readonly provider: (id: string) => Promise<ProviderView | null>;
  readonly runner: ReturnType<typeof modelRunner>;
};

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

const ENGINE_ERRORS: Readonly<Record<EngineError['code'], string>> = {
  not_started: '这次推演还没有开始',
  already_started: '这次推演已经开始过了',
  scene_mismatch: '运行记录与场景配置对不上，不能继续',
  corrupt_log: '运行记录损坏，无法回放',
  conflict: '这次推演正在别处推进，请稍后再试',
  invalid_phase: '现在这个阶段不能做这个操作（外部事件只能加在两个回合之间；替换行动只能在等这个角色行动的时候）',
  invalid_ruling: '裁决不符合规则',
  invalid_intervention: '介入的内容不符合规则',
};
const engineError = (error: EngineError): AppError => settings(`${ENGINE_ERRORS[error.code]}${error.detail === undefined ? '' : `（${error.detail}）`}`);

/** 各类任务正文所需的输出（不含思考）；实际上限另加思考的余量，并按模型的最大输出封顶。 */
const TASK_OUTPUT = { character_action: 4_000, semantic_ruling: 4_000, belief_update: 4_000, judgement: 2_000, stalemate: 2_000 } as const;
const TASK_EFFORT = { character_action: 'medium', semantic_ruling: 'high', belief_update: 'low', judgement: 'low', stalemate: 'low' } as const;

const STOPPED: ReadonlySet<Phase> = new Set(['AwaitingAuthor', 'Paused', 'Ended']);

function progressOf(status: RunStatus): SimRunProgress {
  const { phase, state } = status;
  if (phase === 'Ended') return { status: 'ended', endReason: state.endReason ?? 'author_stop', pauseReason: null, round: status.round };
  if (phase === 'Paused') return { status: 'paused', endReason: null, pauseReason: state.pause?.reason ?? 'author', round: status.round };
  return { status: phase === 'AwaitingAuthor' ? 'awaiting_author' : 'running', endReason: null, pauseReason: null, round: status.round };
}

export function simulationUseCases({ deps, project, defaultModel, provider, runner }: SimulationDeps) {
  const ctx = () => ({ now: deps.clock.now() });

  /** 运行配置里的模型来自“模型服务”中的默认模型（硬性规则 13）；推演的各类任务都要结构化输出，须通过能力自检。 */
  async function taskModels(): Promise<Result<RunConfig['models'], AppError>> {
    const choice = await defaultModel();
    if (!choice.ok) return choice;
    if (choice.value === null) return err(settings('还没有设置默认模型：请在“模型服务”中添加服务与模型'));
    const { provider: service, model } = choice.value;
    if (!model.capabilities.selfTestPassed || model.capabilities.structuredOutput === 'none') {
      return err(settings(`默认模型“${model.displayName}”没有通过能力自检，不能用于角色推演；请在“模型服务”中运行能力自检，或换一个模型`));
    }
    const profile: ModelProfile = { provider: service.id, model: model.modelId, capabilities: model.capabilities, ...(model.prices !== null && { prices: model.prices }) };
    const task = (kind: keyof typeof TASK_OUTPUT): TaskModel => ({
      profile,
      maxOutputTokens: Math.min(TASK_OUTPUT[kind] + THINKING_ALLOWANCE, model.capabilities.maxOutputTokens),
      ...(model.capabilities.reasoningControl === 'effort' && { effort: TASK_EFFORT[kind] }),
    });
    return ok({
      character_action: task('character_action'),
      semantic_ruling: task('semantic_ruling'),
      belief_update: task('belief_update'),
      judgement: task('judgement'),
      stalemate: task('stalemate'),
    });
  }

  /** 按请求里的服务标识找到适配器；服务已经删除时按请求错误返回，引擎据此暂停。 */
  const llm: LlmPort = {
    async complete(request, options) {
      const service = await provider(request.model.provider);
      if (service === null) return err({ code: 'bad_request', message: '这次推演用的模型服务已经不在“模型服务”里了' });
      return deps.llm.forProvider(service).complete(request, options);
    },
  };

  /** 这次运行已用的费用：调用记录里它的全部调用之和。 */
  async function spending(port: SqlPort, runId: string): Promise<Result<{ spentUsd: number; unknownCostCalls: number }, AppError>> {
    const calls = await listRunCalls(port, runId);
    if (!calls.ok) return err(repo(calls.error));
    const done = calls.value.filter((c) => c.status !== 'error' && c.status !== 'cancelled');
    return ok({ spentUsd: calls.value.reduce((n, c) => n + (c.cost ?? 0), 0), unknownCostCalls: done.filter((c) => c.cost === null).length });
  }

  /** 引擎每次操作新建：事件与调用记录都在作品库里；有预算的运行带上预算守卫，已用的费用从调用记录接着算。 */
  const engineFor = (port: SqlPort, budget: { readonly limitUsd: number; readonly spentUsd: number } | null) => {
    const guard = budget === null ? undefined : new BudgetGuard({ limitUsd: budget.limitUsd });
    if (guard !== undefined && budget !== null) guard.spentUsd = budget.spentUsd;
    return createEngine({
      llm,
      events: sqlEventStore(port),
      calls: projectCallLog(port, () => deps.ids.next()),
      now: () => deps.clock.now(),
      ...(guard !== undefined && { budget: guard }),
    });
  };

  function sceneOf(config: unknown): Result<Scene, AppError> {
    const scene = parseScene(config);
    if (scene.ok) return scene;
    const problems = describeSceneProblems(scene.error);
    return err(settings(`场景配置还有 ${problems.length} 处不对：${problems.slice(0, 5).join('；')}${problems.length > 5 ? '……' : ''}`));
  }

  /** 把引擎的状态写回运行记录；停在等待、暂停或结束时记下状态快照，供以后校验回放。 */
  async function sync(port: SqlPort, runId: string, status: RunStatus): Promise<Result<SimRunView, AppError>> {
    const saved = await setSimRunProgress(port, runId, progressOf(status), ctx());
    if (!saved.ok) return err(repo(saved.error));
    if (STOPPED.has(status.phase) && status.state.lastSeq > 0) {
      const snapshot = await saveSimSnapshot(port, { runId, seq: status.state.lastSeq, state: status.state.sim, stateHash: stateHash(status.state.sim) }, ctx());
      if (!snapshot.ok) return err(repo(snapshot.error));
    }
    const spent = await spending(port, runId);
    if (!spent.ok) return spent;
    return ok({
      run: saved.value,
      phase: status.phase,
      round: status.round,
      awaitingRulings: status.awaiting.length,
      awaitingDirector: status.awaitingDirector !== null,
      pause: status.state.pause,
      endReason: status.state.endReason,
      ...spent.value,
    });
  }

  type Operated = { readonly view: SimRunView; readonly status: RunStatus; readonly scene: Scene; readonly port: SqlPort };
  type EngineAction = (engine: ReturnType<typeof createEngine>, scene: Scene) => Promise<Result<RunStatus, EngineError>>;

  const withRun = async (runId: string, action: EngineAction): Promise<Result<SimRunView, AppError>> => {
    const done = await operate(runId, action);
    return done.ok ? ok(done.value.view) : done;
  };

  /** 读出运行与它开始时的场景，执行一次引擎操作，再把结果写回运行记录。事件存储的异常在这里变成给作者看的说明。 */
  async function operate(runId: string, action: EngineAction): Promise<Result<Operated, AppError>> {
    const port = project();
    if (port === null) return err({ code: 'no_work' });
    const run = await getSimRun(port, runId);
    if (!run.ok) return err(repo(run.error));
    if (run.value === null) return err({ code: 'not_found' });
    const scene = sceneOf(run.value.sceneConfig);
    if (!scene.ok) return scene;
    const spent = run.value.budgetUsd === null ? null : await spending(port, runId);
    if (spent !== null && !spent.ok) return spent;
    try {
      const engine = engineFor(port, run.value.budgetUsd === null || spent === null ? null : { limitUsd: run.value.budgetUsd, spentUsd: spent.value.spentUsd });
      const status = await action(engine, scene.value);
      if (!status.ok) return err(engineError(status.error));
      const view = await sync(port, runId, status.value);
      return view.ok ? ok({ view: view.value, status: status.value, scene: scene.value, port }) : view;
    } catch (error) {
      return err(settings(`推演没有推进：${error instanceof Error ? error.message : String(error)}`));
    }
  }

  return {
    listSimScenes: async (): Promise<Result<SimScene[], AppError>> => {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const scenes = await listSimScenes(port);
      return scenes.ok ? scenes : err(repo(scenes.error));
    },

    /** 由一段局面描述生成场景配置草稿（B39）。草稿不保存：作者逐项修改、确认后再保存。 */
    async draftSimScene(description: string, options: CallOptions = {}): Promise<Result<SceneDraft, AppError>> {
      if (description.trim() === '') return err(settings('请先用一段话描述局面：在哪里、有谁、各自想要什么、谁知道什么'));
      const prompt = renderSceneDraft(description.trim());
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: SCENE_DRAFT_OUTPUT_TOKENS, effort: 'medium' }, SceneDraftOutput, options);
      if (!result.ok) return result;
      const config = sceneDraftToSpec(result.value.value);
      return ok({ config, problems: checkSceneConfig(config) });
    },

    /** 新建（id 为 null）或修改推演场景。场景配置须通过领域内核的校验；第一个开口的角色须是场景里的角色。 */
    async saveSimScene(id: string | null, fields: SimSceneFields): Promise<Result<SimScene, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const scene = sceneOf(fields.config);
      if (!scene.ok) return scene;
      if (fields.firstSpeaker !== null && !scene.value.actors.some((a) => a.id === fields.firstSpeaker)) {
        return err(settings(`第一个开口的角色“${fields.firstSpeaker}”不在场景的角色里`));
      }
      if (id === null) {
        const created = await createSimScene(port, { id: deps.ids.next(), ...fields }, ctx());
        return created.ok ? created : err(repo(created.error));
      }
      const current = await getSimScene(port, id);
      if (!current.ok) return err(repo(current.error));
      if (current.value === null) return err({ code: 'not_found' });
      const updated = await updateSimScene(port, current.value, fields, ctx());
      return updated.ok ? updated : err(repo(updated.error));
    },

    listSimRuns: async (sceneId: string): Promise<Result<SimRun[], AppError>> => {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const runs = await listSimRuns(port, sceneId);
      return runs.ok ? runs : err(repo(runs.error));
    },

    /** 开始一次推演：登记运行（带上此刻的场景配置），写入第一条事件。之后用 stepSimRun 或 continueSimRun 推进。 */
    async startSimRun(sceneId: string, options: SimRunOptions): Promise<Result<SimRunView, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const stored = await getSimScene(port, sceneId);
      if (!stored.ok) return err(repo(stored.error));
      if (stored.value === null) return err({ code: 'not_found' });
      const scene = sceneOf(stored.value.config);
      if (!scene.ok) return scene;
      const models = await taskModels();
      if (!models.ok) return models;
      if (options.budgetUsd !== undefined) {
        if (!(options.budgetUsd > 0)) return err(settings('预算上限须大于 0'));
        if (models.value.character_action.profile.prices === undefined) {
          return err(settings('默认模型没有配置价格，预算上限无法生效：请在“模型服务”的“能力与价格”中填写价格，或不设预算'));
        }
      }
      const runId = deps.ids.next();
      const config = RunConfig.safeParse({
        protocol: stored.value.protocol,
        mode: options.mode,
        maxRounds: stored.value.maxRounds,
        seed: options.seed ?? Number.parseInt(sha256(runId).slice(0, 8), 16),
        ...(stored.value.firstSpeaker !== null && { firstSpeaker: stored.value.firstSpeaker }),
        models: models.value,
      });
      if (!config.success) return err(settings(`运行配置无效：${config.error.issues[0]?.message ?? ''}`));
      const run = await createSimRun(
        port,
        {
          id: runId,
          sceneId,
          sceneConfig: stored.value.config,
          sceneConfigVersion: stored.value.configVersion,
          mode: options.mode,
          ...(options.budgetUsd !== undefined && { budgetUsd: options.budgetUsd }),
        },
        ctx(),
      );
      if (!run.ok) return err(repo(run.error));
      return withRun(runId, (engine, s) => engine.start(runId, s, config.data));
    },

    /** 推进一步（一个阶段）。 */
    stepSimRun: (runId: string, options: { readonly signal?: AbortSignal } = {}) => withRun(runId, (engine, scene) => engine.step(runId, scene, options)),

    /** 连续推进，直到等待作者、暂停、结束或被取消。 */
    continueSimRun: (runId: string, options: { readonly signal?: AbortSignal; readonly maxSteps?: number } = {}) =>
      withRun(runId, (engine, scene) => engine.run(runId, scene, options)),

    pauseSimRun: (runId: string) => withRun(runId, (engine, scene) => engine.pause(runId, scene)),
    resumeSimRun: (runId: string) => withRun(runId, (engine, scene) => engine.resume(runId, scene)),
    stopSimRun: (runId: string) => withRun(runId, (engine, scene) => engine.stop(runId, scene)),

    /** 当前状态：只读事件，不调用模型。 */
    simRunStatus: (runId: string) => withRun(runId, (engine, scene) => engine.status(runId, scene)),

    /**
     * 推演工作区的数据：只读事件与调用记录，不调用模型。时间线按回合整理，含全局局面与每个角色当时所见
     * （角色所见取自 buildCharacterView，与实际发给角色代理的一致）。
     */
    async simRunDetail(runId: string): Promise<Result<SimRunDetail, AppError>> {
      const current = await operate(runId, (engine, s) => engine.status(runId, s));
      if (!current.ok) return current;
      const { view, status, port } = current.value;
      const scene = ok(current.value.scene);
      const calls = await listRunCalls(port, runId);
      if (!calls.ok) return err(repo(calls.error));
      let events: readonly StoredEvent[];
      let data: ViewerData | null;
      try {
        events = await sqlEventStore(port).read(runId);
        data = buildViewerData(scene.value, runId, events.map((e) => e.payload as RunEvent));
      } catch (error) {
        return err(settings(`运行记录读不出来：${error instanceof Error ? error.message : String(error)}`));
      }
      const started = new Map<number, string>();
      const ended = new Map<number, string>();
      for (const e of events) {
        const payload = e.payload as RunEvent;
        if (payload.type === 'RoundStarted') started.set(payload.round, e.at);
        if (payload.type === 'RoundEnded') ended.set(payload.round, e.at);
      }
      const span = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from));
      const timing: RoundTiming[] = [...started.keys()].sort((a, b) => a - b).map((round) => {
        const mine = calls.value.filter((c) => c.stepKey.split(':')[1] === String(round));
        const end = ended.get(round);
        return {
          round,
          waitMs: end === undefined ? null : span(started.get(round) ?? end, end),
          modelMs: mine.reduce((n, c) => n + span(c.startedAt, c.finishedAt), 0),
          calls: mine.length,
        };
      });
      const names = new Map([...scene.value.zones, ...scene.value.actors, ...scene.value.items, ...scene.value.mechanisms].map((x) => [x.id as string, x.name]));
      const name = (id: string) => names.get(id) ?? id;
      const pendingRulings: PendingRuling[] = status.awaiting.map((p) => ({
        requestId: p.requestId,
        rationale: p.rationale,
        uncertainties: p.uncertainties,
        effects: p.ruling.effects.map((e) => describeEffect(e, name)),
        occurrences: p.ruling.occurrences.map((o) => describeOccurrence(o, name)),
        editable: JSON.stringify(rulingToOutput(p.ruling, p.rationale, p.uncertainties), null, 2),
      }));
      const proposed = status.awaitingDirector;
      const pendingDirector: PendingDirector | null =
        proposed === null || proposed.event === null
          ? null
          : { rationale: proposed.rationale, effects: proposed.event.effects.map((e) => describeEffect(e, name)), occurrences: proposed.event.occurrences.map((o) => describeOccurrence(o, name)) };

      const snapshots = await listSimSnapshots(port, runId);
      if (!snapshots.ok) return err(repo(snapshots.error));
      const bySeq = new Map(events.map((e) => [e.seq, e.payload as RunEvent]));
      let round = 0;
      const roundAt = new Map<number, number>();
      for (const e of events) {
        const payload = e.payload as RunEvent;
        if (payload.type === 'RoundStarted') round = payload.round;
        roundAt.set(e.seq, round);
      }
      const forkPoints: ForkPoint[] = snapshots.value.map((s) => ({ seq: s.seq, round: roundAt.get(s.seq) ?? 0, label: forkLabel(bySeq.get(s.seq), bySeq.get(s.seq + 1)) }));

      // 每个角色此刻的认知：与发给他的角色视图里的条目相同，供作者介入时选择要撤回的。
      const knowledge = Object.fromEntries(
        scene.value.actors.map((a) => {
          const v = buildCharacterView(scene.value, status.state.sim, a.id);
          return [
            a.id,
            v.knowledge.map((k) => {
              const body = k.body;
              const claim = body.kind === 'claim' ? v.claims.find((c) => c.id === body.claim) : undefined;
              const text = body.kind === 'text' ? body.text : claim !== undefined ? `${name(claim.speaker)}说：“${claim.sentences.join('')}”` : `第 ${k.round} 回合的见闻`;
              return { id: k.id, text };
            }),
          ] as const;
        }),
      );
      const keys = (list: readonly { readonly id: string; readonly name: string }[]) => list.map((x) => ({ id: x.id, name: x.name }));
      const cast = { actors: keys(scene.value.actors), zones: keys(scene.value.zones), items: keys(scene.value.items) };
      return ok({ view, data, timing, pendingRulings, pendingDirector, forkPoints, knowledge, cast });
    },

    /**
     * 作者确认一条待核实的裁决（B26）。edited 是作者改过的裁决（与裁决模型的输出同一形式的 JSON）；不给时按原样接受。
     * 改过的裁决与模型的输出走同一条转换，再由引擎按裁决的范围与不变式校验。
     */
    async confirmSimRuling(runId: string, requestId: string, edited?: string): Promise<Result<SimRunView, AppError>> {
      if (edited === undefined) return withRun(runId, (engine, scene) => engine.confirmRuling(runId, scene, requestId));
      let raw: unknown;
      try {
        raw = JSON.parse(edited);
      } catch (error) {
        return err(settings(`改过的裁决不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`));
      }
      const output = SemanticRulingOutput.safeParse(raw);
      if (!output.success) return err(settings(`改过的裁决格式不对：${output.error.issues[0]?.path.join('.') ?? ''} ${output.error.issues[0]?.message ?? ''}`));
      const ruling = rulingFromOutput(requestId, output.data);
      if (!ruling.ok) return err(settings(`改过的裁决第 ${ruling.error.index + 1} 条效果不对：${ruling.error.issue}`));
      return withRun(runId, (engine, scene) => engine.confirmRuling(runId, scene, requestId, ruling.value));
    },

    /** 作者决定是否采用导演提议（B47 的简化形式）。 */
    decideSimDirector: (runId: string, accept: boolean) => withRun(runId, (engine, scene) => engine.decideDirector(runId, scene, accept)),

    /**
     * 作者介入（B30）：先记下介入前的状态快照（之后可以从这里分出另一条推演），再把介入写成事件。
     * 能不能介入由引擎按当前阶段判断：外部事件只能加在两个回合之间，替换行动只能在等这个角色行动的时候。
     */
    async interveneSimRun(runId: string, input: SimIntervention): Promise<Result<SimRunView, AppError>> {
      if (input.reason.trim() === '') return err(settings('请写一句介入的原因：它会记在运行记录里'));
      const before = await operate(runId, (engine, scene) => engine.status(runId, scene));
      if (!before.ok) return before;
      const { status, port } = before.value;
      let intervention: Intervention;
      try {
        intervention = toIntervention(input);
      } catch {
        return err(settings('介入里的角色、区域或物品的键不对'));
      }
      if (status.state.lastSeq > 0) {
        const snapshot = await saveSimSnapshot(port, { runId, seq: status.state.lastSeq, state: status.state.sim, stateHash: stateHash(status.state.sim) }, ctx());
        if (!snapshot.ok) return err(repo(snapshot.error));
      }
      return withRun(runId, (engine, scene) => engine.intervene(runId, scene, intervention));
    },

    /**
     * 从一个快照处分出新的推演（B30）：原来的运行不动，新的运行带着到那一刻为止的事件，可以走另一条路。
     * seq 须是这次运行的一个快照所在的序号。
     */
    async forkSimRun(runId: string, seq: number): Promise<Result<SimRunView, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const run = await getSimRun(port, runId);
      if (!run.ok) return err(repo(run.error));
      if (run.value === null) return err({ code: 'not_found' });
      const snapshots = await listSimSnapshots(port, runId);
      if (!snapshots.ok) return err(repo(snapshots.error));
      if (!snapshots.value.some((s) => s.seq === seq)) return err(settings('只能从记有快照的时点分支'));
      const scene = sceneOf(run.value.sceneConfig);
      if (!scene.ok) return scene;
      const newId = deps.ids.next();
      const created = await createSimRun(
        port,
        {
          id: newId,
          sceneId: run.value.sceneId,
          sceneConfig: run.value.sceneConfig,
          sceneConfigVersion: run.value.sceneConfigVersion,
          mode: run.value.mode,
          parent: { runId, seq },
          ...(run.value.budgetUsd !== null && { budgetUsd: run.value.budgetUsd }),
        },
        ctx(),
      );
      if (!created.ok) return err(repo(created.error));
      try {
        const status = await engineFor(port, null).fork(runId, scene.value, seq, newId);
        return status.ok ? await sync(port, newId, status.value) : err(engineError(status.error));
      } catch (error) {
        return err(settings(`分支没有建成：${error instanceof Error ? error.message : String(error)}`));
      }
    },

    /** 这次运行的全部事件，按序号。 */
    async simRunEvents(runId: string): Promise<Result<readonly StoredEvent[], AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      try {
        return ok(await sqlEventStore(port).read(runId));
      } catch (error) {
        return err(settings(error instanceof Error ? error.message : String(error)));
      }
    },

    /** 校验回放：只读事件重算每个快照处的状态，哈希应与当时记下的一致（硬性规则 9）。 */
    async verifySimRun(runId: string): Promise<Result<SimVerification, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const run = await getSimRun(port, runId);
      if (!run.ok) return err(repo(run.error));
      if (run.value === null) return err({ code: 'not_found' });
      const scene = sceneOf(run.value.sceneConfig);
      if (!scene.ok) return scene;
      const snapshots = await listSimSnapshots(port, runId);
      if (!snapshots.ok) return err(repo(snapshots.error));
      let events: readonly StoredEvent[];
      try {
        events = await sqlEventStore(port).read(runId);
      } catch (error) {
        return err(settings(error instanceof Error ? error.message : String(error)));
      }
      const mismatchedSeqs: number[] = [];
      for (const snapshot of snapshots.value) {
        const replayed = replayRun(scene.value, runId, events.filter((e) => e.seq <= snapshot.seq));
        if (!replayed.ok || stateHash(replayed.value.sim) !== snapshot.stateHash) mismatchedSeqs.push(snapshot.seq);
      }
      return ok({ snapshots: snapshots.value.length, mismatchedSeqs });
    },
  };
}

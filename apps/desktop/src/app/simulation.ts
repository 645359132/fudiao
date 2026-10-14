// 角色推演的用例（需求 B22、B28、B30，施工文档 M4-01）：把 M0 的推演引擎接到桌面端。
// 事件写入作品库的 sim_event（只追加），模型经桌面端的适配器（凭据代理）调用，调用记录写入 llm_call（步骤键查重）。
// 引擎与领域内核的逻辑不在这里：这里只负责把场景、运行与模型配置交给引擎，并把引擎的状态写回运行记录（缓存）。
import { parseScene, stateHash, type Scene, type SceneSpecInput } from '@fudiao/domain';
import { createEngine, replayRun, RunConfig, type EngineError, type Phase, type RunStatus, type TaskModel } from '@fudiao/engine';
import type { CallOptions, LlmPort, ModelProfile } from '@fudiao/llm';
import { renderSceneDraft, sceneDraftToSpec, SceneDraftOutput } from '@fudiao/prompts';
import { err, ok, sha256, type Result } from '@fudiao/shared';
import {
  createSimRun,
  createSimScene,
  getSimRun,
  getSimScene,
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
};

export type SimRunOptions = {
  readonly mode: 'interactive' | 'auto';
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
  invalid_phase: '现在这个阶段不能做这个操作',
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

  const engineFor = (port: SqlPort) => createEngine({ llm, events: sqlEventStore(port), calls: projectCallLog(port, () => deps.ids.next()), now: () => deps.clock.now() });

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
    return ok({
      run: saved.value,
      phase: status.phase,
      round: status.round,
      awaitingRulings: status.awaiting.length,
      awaitingDirector: status.awaitingDirector !== null,
      pause: status.state.pause,
      endReason: status.state.endReason,
    });
  }

  /** 读出运行与它开始时的场景，执行一次引擎操作，再把结果写回运行记录。事件存储的异常在这里变成给作者看的说明。 */
  async function withRun(
    runId: string,
    action: (engine: ReturnType<typeof createEngine>, scene: Scene) => Promise<Result<RunStatus, EngineError>>,
  ): Promise<Result<SimRunView, AppError>> {
    const port = project();
    if (port === null) return err({ code: 'no_work' });
    const run = await getSimRun(port, runId);
    if (!run.ok) return err(repo(run.error));
    if (run.value === null) return err({ code: 'not_found' });
    const scene = sceneOf(run.value.sceneConfig);
    if (!scene.ok) return scene;
    try {
      const status = await action(engineFor(port), scene.value);
      return status.ok ? await sync(port, runId, status.value) : err(engineError(status.error));
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
        { id: runId, sceneId, sceneConfig: stored.value.config, sceneConfigVersion: stored.value.configVersion, mode: options.mode },
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

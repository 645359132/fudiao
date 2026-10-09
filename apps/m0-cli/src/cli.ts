import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { buildCharacterView, initialState, type ActorId, type KnowledgeId, type Occurrence, type Scene } from '@fudiao/domain';
import { createEngine, reduceRun, type RunEvent, type RunStatus } from '@fudiao/engine';
import { BudgetGuard, costOf, structured, type LlmPort, type LlmRequest, type LlmResult, type Prices } from '@fudiao/llm';
import {
  ActionProposal,
  BaselineOutput,
  BeatSheetOutput,
  SynopsisOutput,
  renderBaseline,
  renderBeatSheet,
  renderCandidateText,
  renderCharacterAction,
  renderRunSynopsis,
  renderStructuredRepair,
  type RenderedPrompt,
} from '@fudiao/prompts';
import type { StoredEvent } from '@fudiao/store';
import { jsonlCallLog, jsonlEventStore } from '@fudiao/store/node';
import { flagInt, flagString, parseArgs, type Args } from './args';
import { estimateCalls, estimateCost, formatUsd, type CostEstimate } from './cost';
import { buildPort, loadExperiment, runConfig, taskModel, type Experiment, type ExperimentTask } from './experiment';
import { loadSceneFile, type SceneFile } from './scene-file';
import { groupOutcomes, renderOutcomes, runOutcome } from './report/outcomes';
import { analyze, loadManifest, loadSamples, writePackets } from './report/report';
import { buildViewerData } from './viewer/data';
import { renderViewerHtml } from './viewer/html';

export type Console = {
  out(text: string): void;
  err(text: string): void;
  /** 询问作者，返回是否同意。 */
  confirm(question: string): Promise<boolean>;
};

export type CliDeps = {
  readonly console: Console;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 仓库根目录，相对路径由此解析。 */
  readonly root: string;
  readonly now: () => string;
  readonly newId: () => string;
  /** 测试注入的模型端口。为空时按实验配置创建真实适配器，运行前显示预计费用并请作者确认。 */
  readonly port?: LlmPort;
};

const DEFAULT_EXPERIMENT = 'm0/experiments/default.yaml';
const DEFAULT_OUT = 'm0/runs';

type Loaded = { readonly sceneFile: SceneFile; readonly scenePath: string; readonly experiment: Experiment };

function path(deps: CliDeps, p: string): string {
  return isAbsolute(p) ? p : resolve(deps.root, p);
}

function load(deps: CliDeps, args: Args, scenePath: string | undefined): Loaded | string {
  if (scenePath === undefined) return '缺少场景文件路径';
  const sceneAbs = path(deps, scenePath);
  if (!existsSync(sceneAbs)) return `找不到场景文件：${scenePath}`;
  const sceneFile = loadSceneFile(readFileSync(sceneAbs, 'utf8'));
  if (!sceneFile.ok) return `场景文件有误：${JSON.stringify(sceneFile.error)}`;
  const expPath = path(deps, flagString(args, 'experiment') ?? DEFAULT_EXPERIMENT);
  if (!existsSync(expPath)) return `找不到实验配置：${expPath}`;
  const experiment = loadExperiment(readFileSync(expPath, 'utf8'));
  if (!experiment.ok) return `实验配置有误：${experiment.error}`;
  return { sceneFile: sceneFile.value, scenePath: sceneAbs, experiment: experiment.value };
}

/** 真实调用前显示预计费用并请作者确认（硬性规则 14）；测试注入端口时不询问。 */
async function confirmCost(deps: CliDeps, args: Args, estimate: CostEstimate, budget?: number): Promise<boolean> {
  deps.console.out(
    `预计调用 ${estimate.calls} 次，费用约 ${formatUsd(estimate.lowUsd)} 至 ${formatUsd(estimate.highUsd)}` +
      (budget !== undefined ? `；每次运行的预算上限 $${budget.toFixed(2)}` : '') +
      '。',
  );
  if (deps.port !== undefined || args.flags['yes'] === true) return true;
  return deps.console.confirm('这会调用真实的模型服务并产生费用，是否继续？');
}

function port(deps: CliDeps, experiment: Experiment): LlmPort | string {
  if (deps.port !== undefined) return deps.port;
  const built = buildPort(experiment, deps.env);
  return built.ok ? built.value : built.error;
}

const repairMessage = (issues: readonly string[]) => {
  const r = renderStructuredRepair(issues);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`提示词渲染失败：${r.error}`);
  return r.value;
}

function request(experiment: Experiment, task: ExperimentTask, prompt: RenderedPrompt, stepKey: string): LlmRequest {
  const model = taskModel(experiment, task);
  return {
    task: task === 'baseline' ? 'candidate_text' : task === 'stalemate' ? 'judgement' : task,
    model: model.profile,
    template: prompt.template,
    system: prompt.system,
    messages: prompt.messages,
    ...(prompt.output !== undefined && { output: prompt.output }),
    maxOutputTokens: model.maxOutputTokens,
    ...(model.effort !== undefined && { effort: model.effort }),
    stepKey,
  };
}

// —— run ——

type Summary = {
  readonly runId: string;
  readonly scene: string;
  readonly phase: string;
  readonly endReason: string | null;
  readonly pause: string | null;
  readonly rounds: number;
  readonly calls: number;
  readonly costUsd: number;
  readonly unknownCostCalls: number;
  readonly needsReview: number;
  readonly evidenceGaps: number;
  /** 从开始到结束的墙钟时间（含作者确认的等待），毫秒。 */
  readonly waitMs: number;
  readonly stalemates: number;
  readonly directorEvents: number;
  /** 角色自报情绪阈值或失控条件被触发的次数；轮流对话中预备的回应会再出现一次，只按模型提案计。 */
  readonly triggered: number;
};

function summarize(outDir: string, scenePath: string, status: RunStatus, stored: readonly StoredEvent[]): Summary {
  const events = stored.map((e) => e.payload as RunEvent);
  const callsFile = join(outDir, status.runId, 'calls.jsonl');
  const records = existsSync(callsFile)
    ? readFileSync(callsFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { cost: number | null; status: string })
    : [];
  return {
    runId: status.runId,
    scene: scenePath,
    phase: status.phase,
    endReason: status.state.endReason,
    pause: status.state.pause?.reason ?? null,
    rounds: status.round,
    calls: records.length,
    costUsd: records.reduce((n, r) => n + (r.cost ?? 0), 0),
    unknownCostCalls: records.filter((r) => r.cost === null && r.status !== 'error').length,
    needsReview: status.state.needsReview.length,
    evidenceGaps: events.filter((e) => e.type === 'EvidenceGapFlagged').length,
    stalemates: events.filter((e) => e.type === 'StalemateDetected').length,
    directorEvents: events.filter((e) => e.type === 'DirectorDecided' && e.accepted).length,
    triggered: events.filter((e) => e.type === 'ProposalSubmitted' && e.source === 'model' && (e.proposal?.triggered ?? null) !== null).length,
    waitMs: stored.length > 0 ? Date.parse(stored.at(-1)?.at ?? '') - Date.parse(stored[0]?.at ?? '') : 0,
  };
}

async function resolveRulings(deps: CliDeps, engine: ReturnType<typeof createEngine>, runId: string, scene: Scene, status: RunStatus) {
  for (const pending of status.awaiting) {
    deps.console.out(`待核实裁决 ${pending.requestId}：${pending.rationale}`);
    for (const u of pending.uncertainties) deps.console.out(`  待核实：${u}`);
    for (const o of pending.ruling.occurrences) deps.console.out(`  ${o.description.visual ?? o.description.sound ?? ''}`);
    if (!(await deps.console.confirm('接受这条裁决？'))) {
      await engine.pause(runId, scene);
      return false;
    }
    const confirmed = await engine.confirmRuling(runId, scene, pending.requestId);
    if (!confirmed.ok) {
      deps.console.err(`确认失败：${JSON.stringify(confirmed.error)}`);
      return false;
    }
  }
  return true;
}

export async function runCommand(args: Args, deps: CliDeps): Promise<number> {
  const loaded = load(deps, args, args.positionals[0]);
  if (typeof loaded === 'string') {
    deps.console.err(loaded);
    return 1;
  }
  const { sceneFile, scenePath, experiment } = loaded;
  const { scene } = sceneFile;
  const runs = flagInt(args, 'runs') ?? experiment.run.runs;
  const seedBase = flagInt(args, 'seed') ?? 1;
  const modeFlag = flagString(args, 'mode');
  if (runs === 'invalid' || seedBase === 'invalid' || (modeFlag !== undefined && modeFlag !== 'auto' && modeFlag !== 'interactive')) {
    deps.console.err('参数有误：--runs、--seed 须为非负整数，--mode 为 auto 或 interactive');
    return 1;
  }
  const outDir = path(deps, flagString(args, 'out') ?? DEFAULT_OUT);
  const resume = flagString(args, 'resume');
  const directorFlag = flagString(args, 'director');
  const curve = flagString(args, 'curve');
  const parallel = flagInt(args, 'parallel') ?? 1;
  if (
    (directorFlag !== undefined && directorFlag !== 'off' && directorFlag !== 'stalemate' && directorFlag !== 'curve') ||
    parallel === 'invalid' ||
    parallel === 0
  ) {
    deps.console.err('参数有误：--director 为 off、stalemate 或 curve，--parallel 须为正整数');
    return 1;
  }
  if (directorFlag !== undefined && directorFlag !== 'off' && experiment.tasks.director === undefined) {
    deps.console.err('开启导演时，实验配置中必须有 tasks.director');
    return 1;
  }
  const overrides: { mode?: 'auto' | 'interactive'; director?: 'off' | 'stalemate' | 'curve'; tensionCurve?: string } = {
    ...(modeFlag !== undefined && { mode: modeFlag }),
    ...(directorFlag !== undefined && { director: directorFlag }),
    ...(curve !== undefined && { tensionCurve: curve }),
  };

  const config0 = runConfig(experiment, sceneFile.run, { seed: seedBase, ...overrides });
  const counts = estimateCalls(config0.protocol, scene.actors.length, config0.maxRounds);
  const total = resume ? 1 : runs;
  const rounds = config0.maxRounds;
  const estimate = estimateCost([
    { model: config0.models.character_action, calls: counts.proposals * total },
    { model: config0.models.semantic_ruling, calls: counts.rulings * total },
    { model: config0.models.belief_update, calls: counts.beliefs * total },
    { model: config0.models.judgement, calls: counts.evidence * total },
    // 按上限估算：窗口填满后每回合都可能请求僵局判断；导演不在最后一回合之后询问。
    ...(config0.models.stalemate && config0.stalemate.enabled
      ? [{ model: config0.models.stalemate, calls: Math.max(0, rounds - config0.stalemate.window + 1) * total }]
      : []),
    ...(config0.models.director && config0.director.enabled
      ? [
          {
            model: config0.models.director,
            calls: (config0.director.trigger === 'curve' ? rounds - 1 : Math.floor(rounds / config0.stalemate.window)) * total,
          },
        ]
      : []),
  ]);
  if (!(await confirmCost(deps, args, estimate, experiment.budget.limitUsdPerRun))) {
    deps.console.out('已取消。');
    return 1;
  }
  const llm = port(deps, experiment);
  if (typeof llm === 'string') {
    deps.console.err(llm);
    return 1;
  }

  const runOne = async (i: number): Promise<number> => {
    const runId = resume ?? deps.newId();
    const engine = createEngine({
      llm,
      events: jsonlEventStore(outDir),
      calls: jsonlCallLog(outDir, runId),
      now: deps.now,
      budget: new BudgetGuard({ limitUsd: experiment.budget.limitUsdPerRun }),
    });
    if (resume === undefined) {
      const started = await engine.start(runId, scene, runConfig(experiment, sceneFile.run, { seed: seedBase + i, ...overrides }));
      if (!started.ok) {
        deps.console.err(`无法开始：${JSON.stringify(started.error)}`);
        return 1;
      }
    }
    deps.console.out(`运行 ${runId} 开始。`);
    // 因模型服务出错（限流、余额不足、网络）而暂停的运行，续跑时先恢复；失败的那一步没有完成记录，会重新调用。
    // 其他暂停原因（提案或裁决不合法、作者暂停）需要作者处理，原样返回。
    if (resume !== undefined) {
      const current = await engine.status(runId, scene);
      if (current.ok && current.value.phase === 'Paused' && current.value.state.pause?.reason === 'llm_error') await engine.resume(runId, scene);
    }
    let status = await engine.run(runId, scene);
    while (status.ok) {
      const s = status.value;
      if (s.phase === 'AwaitingAuthor' && s.awaitingDirector !== null) {
        const event = s.awaitingDirector.event;
        deps.console.out(`导演提议：${s.awaitingDirector.rationale}`);
        for (const o of event?.occurrences ?? []) deps.console.out(`  ${o.description.visual ?? o.description.sound ?? ''}`);
        const decided = await engine.decideDirector(runId, scene, await deps.console.confirm('采用这条导演提议？'));
        if (!decided.ok) {
          deps.console.err(`导演提议处理失败：${JSON.stringify(decided.error)}`);
          break;
        }
      } else if (s.phase === 'AwaitingAuthor') {
        if (!(await resolveRulings(deps, engine, runId, scene, s))) break;
      } else if (s.phase === 'Paused' && s.state.pause?.reason === 'stalemate') {
        const kind = s.state.pause.detail ?? '';
        deps.console.out(`检测到僵局：${STALEMATE_LABEL[kind] ?? kind}。`);
        if (await deps.console.confirm('继续推演？')) await engine.resume(runId, scene);
        else await engine.stop(runId, scene);
      } else break;
      status = await engine.run(runId, scene);
    }
    if (!status.ok) {
      deps.console.err(`运行 ${runId} 出错：${JSON.stringify(status.error)}`);
      return 1;
    }
    const final = await engine.status(runId, scene);
    if (!final.ok) return 1;
    const summary = summarize(outDir, scenePath, final.value, await jsonlEventStore(outDir).read(runId));
    writeFileSync(join(outDir, runId, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    deps.console.out(
      `运行 ${runId}：${summary.phase}${summary.endReason ? `（${summary.endReason}）` : ''}${summary.pause ? `（暂停：${summary.pause}）` : ''}，` +
        `${summary.rounds} 回合，${summary.calls} 次调用，费用 $${summary.costUsd.toFixed(4)}` +
        (summary.needsReview > 0 ? `，${summary.needsReview} 条裁决待复核` : '') +
        (summary.evidenceGaps > 0 ? `，${summary.evidenceGaps} 处缺少证据链的命中` : '') +
        (summary.stalemates > 0 ? `，${summary.stalemates} 次僵局` : '') +
        (summary.directorEvents > 0 ? `，${summary.directorEvents} 个导演事件` : '') +
        (summary.triggered > 0 ? `，${summary.triggered} 次情绪或失控触发` : ''),
    );
    return 0;
  };

  // 批量推演（B48 简化形式）：并发运行，各次运行独立记录与预算。交互模式要逐条询问作者，只能逐次运行。
  const width = config0.mode === 'interactive' ? 1 : Math.min(parallel, total);
  let next = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < total) {
        const i = next++;
        if ((await runOne(i)) !== 0) failed++;
      }
    }),
  );
  return failed > 0 ? 1 : 0;
}

/** 僵局类型与给作者的建议（需求第五章“戏剧性与导演层”）。 */
const STALEMATE_LABEL: Readonly<Record<string, string>> = {
  standoff: '双方观望，建议注入事件',
  repetition: '重复相同动作，建议调整目标',
  circling: '反复拉锯，建议注入事件或结束场景',
  polite_resolution: '冲突被礼貌化解，建议提高情绪压力',
  goal_unreachable: '目标已无法达成，建议结束场景',
};

// —— baseline ——

export async function baselineCommand(args: Args, deps: CliDeps): Promise<number> {
  const loaded = load(deps, args, args.positionals[0]);
  if (typeof loaded === 'string') {
    deps.console.err(loaded);
    return 1;
  }
  const { sceneFile, scenePath, experiment } = loaded;
  const runs = flagInt(args, 'runs') ?? experiment.run.runs;
  const length = flagInt(args, 'length') ?? 2_000;
  if (runs === 'invalid' || length === 'invalid') {
    deps.console.err('参数有误：--runs、--length 须为非负整数');
    return 1;
  }
  const outDir = path(deps, flagString(args, 'out') ?? DEFAULT_OUT);
  if (!(await confirmCost(deps, args, estimateCost([{ model: taskModel(experiment, 'baseline'), calls: runs }])))) {
    deps.console.out('已取消。');
    return 1;
  }
  const llm = port(deps, experiment);
  if (typeof llm === 'string') {
    deps.console.err(llm);
    return 1;
  }
  const prompt = unwrap(renderBaseline(sceneFile.scene, { targetLength: length }));
  const model = taskModel(experiment, 'baseline');
  for (let i = 0; i < runs; i++) {
    const id = deps.newId();
    const startedAt = deps.now();
    const result = await structured(llm, BaselineOutput, request(experiment, 'baseline', prompt, `baseline:${id}`), {
      maxRepairs: experiment.run.maxRepairs,
      repairMessage,
    });
    if (!result.ok) {
      deps.console.err(`对照组 ${id} 失败：${result.error.code}`);
      continue;
    }
    writeSample(join(outDir, `baseline-${id}`), {
      text: result.value.value.text,
      synopsis: result.value.value.synopsis,
      meta: {
        kind: 'baseline',
        scene: scenePath,
        template: prompt.template,
        costUsd: attemptsCost(result.value.attempts, model.profile.prices),
        waitMs: Date.parse(deps.now()) - Date.parse(startedAt),
        servedModel: result.value.attempts.at(-1)?.servedModel ?? null,
      },
    });
    deps.console.out(`对照组 ${id}：${result.value.value.text.length} 字，梗概 ${result.value.value.synopsis.length} 条。`);
  }
  return 0;
}

/** 一份评估样本：正文、事件梗概与费用等元信息。评估包只取正文与梗概，元信息只进答案键。 */
function writeSample(dir: string, sample: { text: string; synopsis: readonly string[]; meta: object }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'text.md'), `${sample.text.trim()}\n`);
  writeFileSync(join(dir, 'synopsis.md'), `${sample.synopsis.map((s) => `- ${s}`).join('\n')}\n`);
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(sample.meta, null, 2)}\n`);
}

const attemptsCost = (attempts: readonly LlmResult[], prices: Prices | undefined): number | null =>
  attempts.reduce<number | null>((sum, a) => {
    const c = costOf(a.usage, prices);
    return sum === null || c === null ? null : sum + c;
  }, 0);

// —— narrate ——

export async function narrateCommand(args: Args, deps: CliDeps): Promise<number> {
  const runId = args.positionals[0];
  const pov = flagString(args, 'pov');
  if (runId === undefined || pov === undefined) {
    deps.console.err('用法：pnpm m0 narrate <运行标识> --pov <角色标识> [--style 文风]');
    return 1;
  }
  const outDir = path(deps, flagString(args, 'out') ?? DEFAULT_OUT);
  const summaryFile = join(outDir, runId, 'summary.json');
  if (!existsSync(summaryFile)) {
    deps.console.err(`找不到运行 ${runId} 的摘要`);
    return 1;
  }
  const { scene: scenePath } = JSON.parse(readFileSync(summaryFile, 'utf8')) as { scene: string };
  const loaded = load(deps, args, scenePath);
  if (typeof loaded === 'string') {
    deps.console.err(loaded);
    return 1;
  }
  const { sceneFile, experiment } = loaded;
  const scene = sceneFile.scene;
  const stored = await jsonlEventStore(outDir).read(runId);
  const state = reduceRun(scene, runId, stored);
  if (!state.ok) {
    deps.console.err(`运行记录有误：${state.error.code}`);
    return 1;
  }
  if (!scene.actors.some((a) => a.id === pov)) {
    deps.console.err(`场景中没有角色 ${pov}`);
    return 1;
  }
  const actor = pov as ActorId;
  // 正文视角：只用视角人物在运行结束时的认知与他自己的内心片段（硬性规则 3）。
  const view = buildCharacterView(scene, state.value.sim, actor);
  const materials = view.knowledge
    .filter((k) => k.body.kind !== 'text' && k.round > 0)
    .sort((a, b) => a.round - b.round)
    .map((k) => k.id);
  const thoughts = stored
    .map((e) => e.payload as RunEvent)
    .flatMap((e) => (e.type === 'ProposalSubmitted' && e.actor === actor && e.proposal ? [{ round: e.round, text: e.proposal.innerThought }] : []));

  const estimate = estimateCost([
    { model: taskModel(experiment, 'beat_sheet'), calls: 1 },
    { model: taskModel(experiment, 'candidate_text'), calls: 2 },
  ]);
  if (!(await confirmCost(deps, args, estimate))) {
    deps.console.out('已取消。');
    return 1;
  }
  const llm = port(deps, experiment);
  if (typeof llm === 'string') {
    deps.console.err(llm);
    return 1;
  }
  const style = flagString(args, 'style');
  const startedAt = deps.now();
  const sheetPrompt = unwrap(renderBeatSheet(view, { materials, thoughts, ...(style !== undefined && { authorNotes: style }) }));
  const sheet = await structured(llm, BeatSheetOutput, request(experiment, 'beat_sheet', sheetPrompt, `narrate:${runId}:${pov}:beats`), {
    maxRepairs: experiment.run.maxRepairs,
    repairMessage,
  });
  if (!sheet.ok) {
    deps.console.err(`节拍表失败：${sheet.error.code}`);
    return 1;
  }
  const known = new Set<string>(materials);
  const beats = sheet.value.value.beats
    .filter((b) => known.has(b.ref))
    .map((b) => ({ ...b, ref: b.ref as KnowledgeId }));
  const textPrompt = unwrap(
    renderCandidateText(view, { beats, thoughts: thoughts.map((t) => t.text), ...(style !== undefined && { style }) }),
  );
  const text = await llm.complete(request(experiment, 'candidate_text', textPrompt, `narrate:${runId}:${pov}:text`));
  if (!text.ok || text.value.outcome !== 'completed') {
    deps.console.err(`正文失败：${text.ok ? text.value.outcome : text.error.code}`);
    return 1;
  }
  // 事件梗概：由同一模型读全局事件记录写出，与对照组的梗概可比（分层比较）。
  const rounds = new Map<number, Occurrence[]>();
  for (const e of stored.map((s) => s.payload as RunEvent)) {
    if (e.type === 'StateChanged') rounds.set(e.round, [...(rounds.get(e.round) ?? []), ...e.occurrences]);
  }
  const synopsisPrompt = unwrap(
    renderRunSynopsis(scene, initialState(scene, 0), state.value.sim, [...rounds].map(([round, occurrences]) => ({ round, occurrences }))),
  );
  const synopsis = await structured(llm, SynopsisOutput, request(experiment, 'candidate_text', synopsisPrompt, `narrate:${runId}:synopsis`), {
    maxRepairs: experiment.run.maxRepairs,
    repairMessage,
  });
  if (!synopsis.ok) {
    deps.console.err(`事件梗概失败：${synopsis.error.code}`);
    return 1;
  }
  const runSummary = JSON.parse(readFileSync(summaryFile, 'utf8')) as { costUsd: number; waitMs?: number };
  const narrationCost = attemptsCost(
    [...sheet.value.attempts, text.value, ...synopsis.value.attempts],
    taskModel(experiment, 'candidate_text').profile.prices,
  );
  const dir = join(outDir, runId, `narration-${pov}`);
  writeSample(dir, {
    text: text.value.text,
    synopsis: synopsis.value.value.synopsis,
    meta: {
      kind: 'simulation',
      runId,
      pov,
      scene: scenePath,
      template: textPrompt.template,
      beatSheetTemplate: sheetPrompt.template,
      synopsisTemplate: synopsisPrompt.template,
      beats,
      costUsd: narrationCost === null ? null : narrationCost + runSummary.costUsd,
      waitMs: (runSummary.waitMs ?? 0) + Date.parse(deps.now()) - Date.parse(startedAt),
    },
  });
  deps.console.out(`已生成 ${pov} 视角的候选稿：${join(dir, 'text.md')}`);
  return 0;
}

// —— view ——

/** 由运行记录生成静态查看页（单个 HTML 文件）。只读事件记录，不调用模型。 */
export async function viewCommand(args: Args, deps: CliDeps): Promise<number> {
  const runId = args.positionals[0];
  if (runId === undefined) {
    deps.console.err('用法：pnpm m0 view <运行标识>');
    return 1;
  }
  const outDir = path(deps, flagString(args, 'out') ?? DEFAULT_OUT);
  const summaryFile = join(outDir, runId, 'summary.json');
  if (!existsSync(summaryFile)) {
    deps.console.err(`找不到运行 ${runId} 的摘要`);
    return 1;
  }
  const { scene: scenePath } = JSON.parse(readFileSync(summaryFile, 'utf8')) as { scene: string };
  const sceneFile = loadSceneFile(readFileSync(scenePath, 'utf8'));
  if (!sceneFile.ok) {
    deps.console.err(`场景文件有误：${JSON.stringify(sceneFile.error)}`);
    return 1;
  }
  const events = (await jsonlEventStore(outDir).read(runId)).map((e) => e.payload as RunEvent);
  const file = join(outDir, runId, 'view.html');
  writeFileSync(file, renderViewerHtml(buildViewerData(sceneFile.value.scene, runId, events)));
  deps.console.out(`已生成查看页：${file}`);
  return 0;
}

// —— outcomes ——

/** outcomes <运行标识…>：按结局归类批量推演（B48 简化形式），写出归类文件。不调用模型。 */
export async function outcomesCommand(args: Args, deps: CliDeps): Promise<number> {
  const runIds = [...args.positionals];
  if (runIds.length === 0) {
    deps.console.err('用法：pnpm m0 outcomes <运行标识…>');
    return 1;
  }
  const outDir = path(deps, flagString(args, 'out') ?? DEFAULT_OUT);
  const store = jsonlEventStore(outDir);
  const results = [];
  let scenePath0: string | null = null;
  let title = '';
  for (const runId of runIds) {
    const summaryFile = join(outDir, runId, 'summary.json');
    if (!existsSync(summaryFile)) {
      deps.console.err(`找不到运行 ${runId} 的摘要`);
      return 1;
    }
    const { scene: scenePath } = JSON.parse(readFileSync(summaryFile, 'utf8')) as { scene: string };
    if (scenePath0 !== null && scenePath !== scenePath0) {
      deps.console.err(`运行 ${runId} 与其他运行不是同一个场景`);
      return 1;
    }
    scenePath0 = scenePath;
    const sceneFile = loadSceneFile(readFileSync(scenePath, 'utf8'));
    if (!sceneFile.ok) {
      deps.console.err(`场景文件有误：${JSON.stringify(sceneFile.error)}`);
      return 1;
    }
    title = sceneFile.value.scene.meta.title ?? scenePath;
    results.push(runOutcome(sceneFile.value.scene, runId, (await store.read(runId)).map((e) => e.payload as RunEvent)));
  }
  const groups = groupOutcomes(results);
  const file = join(outDir, `outcomes-${[...runIds].sort()[0] ?? ''}.md`);
  writeFileSync(file, renderOutcomes(title, groups));
  deps.console.out(`${runIds.length} 次运行，${groups.length} 种结局，已写出 ${file}`);
  return 0;
}

// —— report ——

/**
 * report <清单.yaml>：生成评估包（按局面与条件均衡分配、隐藏来源、答案键单独存放）。
 * report analyze --out <评估包目录>：汇总评价者填好的评分表。两者都不调用模型。
 */
export function reportCommand(args: Args, deps: CliDeps): number {
  const [first] = args.positionals;
  if (first === 'analyze') {
    const dir = flagString(args, 'out');
    if (dir === undefined) {
      deps.console.err('用法：pnpm m0 report analyze --out <评估包目录>');
      return 1;
    }
    const result = analyze(path(deps, dir));
    if (!result.ok) {
      deps.console.err(result.error);
      return 1;
    }
    writeFileSync(join(path(deps, dir), '_key', 'analysis.md'), result.value);
    deps.console.out(result.value);
    return 0;
  }
  if (first === undefined || !existsSync(path(deps, first))) {
    deps.console.err('用法：pnpm m0 report <清单.yaml> [--out 评估包目录]');
    return 1;
  }
  const manifest = loadManifest(readFileSync(path(deps, first), 'utf8'));
  if (!manifest.ok) {
    deps.console.err(`清单有误：${manifest.error}`);
    return 1;
  }
  const samples = loadSamples(manifest.value, (p) => path(deps, p));
  if (!samples.ok) {
    deps.console.err(samples.error);
    return 1;
  }
  const outDir = path(deps, flagString(args, 'out') ?? `m0/packets/${manifest.value.id}`);
  const key = writePackets(outDir, manifest.value, samples.value);
  deps.console.out(`已为 ${Object.keys(key.assignments).length} 位评价者生成评估包：${outDir}（答案键在 _key/，不要分发）`);
  return 0;
}

// —— motive-check ——

export async function motiveCommand(args: Args, deps: CliDeps): Promise<number> {
  const loaded = load(deps, args, args.positionals[0]);
  const actorId = flagString(args, 'actor');
  const expect = flagString(args, 'expect');
  const samples = flagInt(args, 'samples') ?? 5;
  if (typeof loaded === 'string' || actorId === undefined || expect === undefined || samples === 'invalid') {
    deps.console.err(typeof loaded === 'string' ? loaded : '用法：pnpm m0 motive-check <场景> --actor <角色> --expect <行动种类>[:对象] [--samples N]');
    return 1;
  }
  const { sceneFile, scenePath, experiment } = loaded;
  const scene = sceneFile.scene;
  if (!scene.actors.some((a) => a.id === actorId)) {
    deps.console.err(`场景中没有角色 ${actorId}`);
    return 1;
  }
  const [kind, target] = expect.split(':');
  if (!(await confirmCost(deps, args, estimateCost([{ model: taskModel(experiment, 'character_action'), calls: samples }])))) {
    deps.console.out('已取消。');
    return 1;
  }
  const llm = port(deps, experiment);
  if (typeof llm === 'string') {
    deps.console.err(llm);
    return 1;
  }
  const view = buildCharacterView(scene, { ...initialState(scene, 1), round: 1 }, actorId as ActorId);
  const prompt = unwrap(renderCharacterAction(view, { protocol: sceneFile.run.protocol }));
  const id = deps.newId();
  const results: ActionProposal[] = [];
  for (let i = 0; i < samples; i++) {
    const r = await structured(llm, ActionProposal, request(experiment, 'character_action', prompt, `motive:${id}:${i}`), {
      maxRepairs: experiment.run.maxRepairs,
      repairMessage,
    });
    if (r.ok) results.push(r.value.value);
  }
  const matched = results.filter((p) => p.kind === kind && (target === undefined || p.target === target));
  const outDir = path(deps, flagString(args, 'out') ?? DEFAULT_OUT);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `motive-${id}.json`),
    `${JSON.stringify({ scene: scenePath, actor: actorId, expect, samples: results.map((p) => ({ kind: p.kind, target: p.target, intent: p.intent, rationale: p.rationale })), matched: matched.length }, null, 2)}\n`,
  );
  deps.console.out(`动机可达性：${matched.length}/${results.length} 次采样选择了 ${expect}。`);
  for (const p of results.filter((r) => !matched.includes(r))) deps.console.out(`  未选择时的理由：${p.rationale}`);
  return 0;
}

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'run':
      return runCommand(args, deps);
    case 'baseline':
      return baselineCommand(args, deps);
    case 'narrate':
      return narrateCommand(args, deps);
    case 'motive-check':
      return motiveCommand(args, deps);
    case 'view':
      return viewCommand(args, deps);
    case 'outcomes':
      return outcomesCommand(args, deps);
    case 'report':
      return reportCommand(args, deps);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      deps.console.out(USAGE);
      return 0;
    default:
      deps.console.err(`未知命令：${command}\n\n${USAGE}`);
      return 1;
  }
}

export const USAGE = [
  '用法：pnpm m0 <命令> [参数]',
  '',
  '命令：',
  '  run <场景.yaml>            运行推演  [--experiment 配置] [--runs N] [--seed N] [--mode auto|interactive] [--resume 运行标识] [--yes]',
  '                             [--director off|stalemate|curve] [--curve 张力曲线] [--parallel P]',
  '  baseline <场景.yaml>       单次提示词对照组  [--runs N] [--length 字数] [--yes]',
  '  narrate <运行标识>         由推演记录生成节拍表与候选稿  --pov <角色> [--style 文风] [--yes]',
  '  motive-check <场景.yaml>   动机可达性检验  --actor <角色> --expect <行动>[:对象] [--samples N] [--yes]',
  '  view <运行标识>           生成静态查看页：时间线、全局局面与角色所见',
  '  outcomes <运行标识…>       按结局归类批量推演的结果，列出代表运行的关键转折',
  '  report <清单.yaml>         生成评估包：均衡分配、隐藏来源、答案键单独存放  [--out 目录]',
  '  report analyze --out <目录> 汇总评价者填好的评分表',
  '',
  '真实调用前会显示预计费用并请你确认；--yes 跳过确认。API Key 从实验配置指定的环境变量读取。',
].join('\n');

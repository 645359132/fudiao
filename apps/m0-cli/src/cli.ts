import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { buildCharacterView, initialState, type ActorId, type KnowledgeId, type Scene } from '@novel-writer/domain';
import { createEngine, reduceRun, type RunEvent, type RunStatus } from '@novel-writer/engine';
import { BudgetGuard, structured, type LlmPort, type LlmRequest, type LlmResult } from '@novel-writer/llm';
import {
  ActionProposal,
  BeatSheetOutput,
  renderBaseline,
  renderBeatSheet,
  renderCandidateText,
  renderCharacterAction,
  renderStructuredRepair,
  type RenderedPrompt,
} from '@novel-writer/prompts';
import { jsonlCallLog, jsonlEventStore } from '@novel-writer/store/node';
import { flagInt, flagString, parseArgs, type Args } from './args';
import { estimateCalls, estimateCost, formatUsd, type CostEstimate } from './cost';
import { buildPort, loadExperiment, runConfig, taskModel, type Experiment, type ExperimentTask } from './experiment';
import { loadSceneFile, type SceneFile } from './scene-file';

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
    task: task === 'baseline' ? 'candidate_text' : task,
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
};

function summarize(outDir: string, scenePath: string, status: RunStatus, events: readonly RunEvent[]): Summary {
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

  const config0 = runConfig(experiment, sceneFile.run, { seed: seedBase, ...(modeFlag && { mode: modeFlag }) });
  const counts = estimateCalls(config0.protocol, scene.actors.length, config0.maxRounds);
  const total = resume ? 1 : runs;
  const estimate = estimateCost([
    { model: config0.models.character_action, calls: counts.proposals * total },
    { model: config0.models.semantic_ruling, calls: counts.rulings * total },
    { model: config0.models.belief_update, calls: counts.beliefs * total },
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

  for (let i = 0; i < total; i++) {
    const runId = resume ?? deps.newId();
    const engine = createEngine({
      llm,
      events: jsonlEventStore(outDir),
      calls: jsonlCallLog(outDir, runId),
      now: deps.now,
      budget: new BudgetGuard({ limitUsd: experiment.budget.limitUsdPerRun }),
    });
    if (resume === undefined) {
      const started = await engine.start(runId, scene, runConfig(experiment, sceneFile.run, { seed: seedBase + i, ...(modeFlag && { mode: modeFlag }) }));
      if (!started.ok) {
        deps.console.err(`无法开始：${JSON.stringify(started.error)}`);
        return 1;
      }
    }
    deps.console.out(`运行 ${runId} 开始。`);
    let status = await engine.run(runId, scene);
    while (status.ok && status.value.phase === 'AwaitingAuthor') {
      if (!(await resolveRulings(deps, engine, runId, scene, status.value))) break;
      status = await engine.run(runId, scene);
    }
    if (!status.ok) {
      deps.console.err(`运行 ${runId} 出错：${JSON.stringify(status.error)}`);
      return 1;
    }
    const final = await engine.status(runId, scene);
    if (!final.ok) return 1;
    const events = (await jsonlEventStore(outDir).read(runId)).map((e) => e.payload as RunEvent);
    const summary = summarize(outDir, scenePath, final.value, events);
    writeFileSync(join(outDir, runId, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    deps.console.out(
      `运行 ${runId}：${summary.phase}${summary.endReason ? `（${summary.endReason}）` : ''}${summary.pause ? `（暂停：${summary.pause}）` : ''}，` +
        `${summary.rounds} 回合，${summary.calls} 次调用，费用 $${summary.costUsd.toFixed(4)}` +
        (summary.needsReview > 0 ? `，${summary.needsReview} 条裁决待复核` : '') +
        (summary.evidenceGaps > 0 ? `，${summary.evidenceGaps} 处缺少证据链的命中` : ''),
    );
  }
  return 0;
}

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
  for (let i = 0; i < runs; i++) {
    const id = deps.newId();
    const result = await llm.complete(request(experiment, 'baseline', prompt, `baseline:${id}`));
    if (!result.ok || result.value.outcome !== 'completed') {
      deps.console.err(`对照组 ${id} 失败：${result.ok ? result.value.outcome : result.error.code}`);
      continue;
    }
    writeOutput(join(outDir, `baseline-${id}`), result.value, scenePath, prompt);
    deps.console.out(`对照组 ${id}：${result.value.text.length} 字。`);
  }
  return 0;
}

function writeOutput(dir: string, result: LlmResult, scenePath: string, prompt: RenderedPrompt, extra: object = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'text.md'), `${result.text}\n`);
  writeFileSync(
    join(dir, 'meta.json'),
    `${JSON.stringify({ scene: scenePath, template: prompt.template, outcome: result.outcome, usage: result.usage, servedModel: result.servedModel, ...extra }, null, 2)}\n`,
  );
}

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
    { model: taskModel(experiment, 'candidate_text'), calls: 1 },
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
  const dir = join(outDir, runId, `narration-${pov}`);
  writeOutput(dir, text.value, scenePath, textPrompt, { beats, beatSheetTemplate: sheetPrompt.template });
  deps.console.out(`已生成 ${pov} 视角的候选稿：${join(dir, 'text.md')}`);
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
    case 'report':
      deps.console.err('report 在 M0-12 实现。');
      return 1;
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
  '  baseline <场景.yaml>       单次提示词对照组  [--runs N] [--length 字数] [--yes]',
  '  narrate <运行标识>         由推演记录生成节拍表与候选稿  --pov <角色> [--style 文风] [--yes]',
  '  motive-check <场景.yaml>   动机可达性检验  --actor <角色> --expect <行动>[:对象] [--samples N] [--yes]',
  '  report                     生成评估材料（M0-12）',
  '',
  '真实调用前会显示预计费用并请你确认；--yes 跳过确认。API Key 从实验配置指定的环境变量读取。',
].join('\n');

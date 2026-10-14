// 推演评价（需求 B46，施工文档 M4-09）：推演结束后作者的简短评价——人物是否可信、有无可采用的转折、
// 是否采纳及采纳的事件；批量推演在整组结束后评价一次。评分项与 M0 评价表相同，便于对照。
import { err, ok, type Result } from '@fudiao/shared';
import {
  getEvaluation,
  getSimRun,
  listBatchRuns,
  listRunCalls,
  listStoryEvents,
  saveEvaluation,
  type Evaluation,
  type EvaluationMeasured,
  type EvaluationScores,
  type EvaluationTarget,
  type RepoError,
  type SimRun,
  type SqlPort,
} from '@fudiao/store';
import type { AppError } from './errors';
import type { AppDeps } from './ports';

/** 评分项（与 M0 评价表 apps/m0-cli/src/report 相同）：键、说明与取值范围。 */
export const EVALUATION_ITEMS: readonly { readonly key: keyof EvaluationScores; readonly label: string; readonly min: number; readonly max: number }[] = [
  { key: 'characters', label: '人物可信且可区分', min: 1, max: 5 },
  { key: 'intel', label: '行动依赖实际情报', min: 1, max: 5 },
  { key: 'twist', label: '意外但合理的转折', min: 1, max: 5 },
  { key: 'adopt', label: '采纳意愿', min: 1, max: 5 },
  { key: 'edits', label: '采纳前修改量（0 无，1 少量，2 较多，3 需重写）', min: 0, max: 3 },
];

export type SimEvaluationView = {
  /** 评价的对象：单次推演或整组批量推演。 */
  readonly scope: 'run' | 'batch';
  readonly runIds: readonly string[];
  /** 全部运行都已结束才能评价。 */
  readonly ready: boolean;
  /** 此刻的客观数据：采纳进作品的事件、调用费用与模型耗时。 */
  readonly measured: EvaluationMeasured;
  readonly adopted: readonly { readonly id: string; readonly summary: string }[];
  readonly evaluation: Evaluation | null;
};

export type SimEvaluationInput = { readonly scores: EvaluationScores; readonly twistNote: string; readonly note: string };

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

export function simEvaluationUseCases(deps: AppDeps, project: () => SqlPort | null) {
  const ctx = () => ({ now: deps.clock.now() });
  const span = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from));

  /** 评价的对象与此刻的客观数据。 */
  async function load(port: SqlPort, runId: string): Promise<Result<{ target: EvaluationTarget; view: SimEvaluationView }, AppError>> {
    const run = await getSimRun(port, runId);
    if (!run.ok) return err(repo(run.error));
    if (run.value === null) return err(settings('没有这次推演'));
    let runs: readonly SimRun[] = [run.value];
    const batchId = run.value.batchId;
    if (batchId !== null) {
      const batch = await listBatchRuns(port, batchId);
      if (!batch.ok) return err(repo(batch.error));
      runs = batch.value;
    }
    const runIds = runs.map((r) => r.id);
    let calls = 0;
    let costUsd = 0;
    let unknownCostCalls = 0;
    let modelMs = 0;
    for (const id of runIds) {
      const list = await listRunCalls(port, id);
      if (!list.ok) return err(repo(list.error));
      for (const c of list.value) {
        calls += 1;
        if (c.cost === null) unknownCostCalls += 1;
        else costUsd += c.cost;
        modelMs += span(c.startedAt, c.finishedAt);
      }
    }
    const events = await listStoryEvents(port);
    if (!events.ok) return err(repo(events.error));
    const adopted = events.value.filter((e) => e.originRunId !== null && runIds.includes(e.originRunId)).map((e) => ({ id: e.id, summary: e.summary }));
    const target: EvaluationTarget = batchId === null ? { runId } : { batchId };
    const evaluation = await getEvaluation(port, target);
    if (!evaluation.ok) return err(repo(evaluation.error));
    return ok({
      target,
      view: {
        scope: batchId === null ? 'run' : 'batch',
        runIds,
        ready: runs.every((r) => r.status === 'ended'),
        measured: { runIds, adoptedEventIds: adopted.map((e) => e.id), calls, costUsd, unknownCostCalls, modelMs },
        adopted,
        evaluation: evaluation.value,
      },
    });
  }

  return {
    /** 一次推演（属于批量推演时是整组）的评价，以及此刻的采纳事件、费用与模型耗时。只读，不调用模型。 */
    async simEvaluation(runId: string): Promise<Result<SimEvaluationView, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const loaded = await load(port, runId);
      return loaded.ok ? ok(loaded.value.view) : loaded;
    },

    /**
     * 保存评价（B46）：推演结束后才能评价，批量推演要整组都结束。保存时记下此刻采纳进作品的事件、费用与耗时；
     * 之后可以再改（version 是作者打开时读到的评价版本，第一次评价为 null）。
     */
    async saveSimEvaluation(runId: string, input: SimEvaluationInput, version: number | null): Promise<Result<SimEvaluationView, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const loaded = await load(port, runId);
      if (!loaded.ok) return loaded;
      const { target, view } = loaded.value;
      if (!view.ready) return err(settings(view.scope === 'batch' ? '这组批量推演还没有全部结束，整组结束后再评价' : '推演还没有结束，结束后再评价'));
      if ((view.evaluation?.version ?? null) !== version) return err(settings('评价已在别处修改，请重新打开后再改'));
      const saved = await saveEvaluation(port, { id: deps.ids.next(), target, answers: { ...input, measured: view.measured } }, view.evaluation, ctx());
      if (!saved.ok) return err(repo(saved.error));
      return ok({ ...view, evaluation: saved.value });
    },
  };
}

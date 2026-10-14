// 推演场景、推演运行与状态快照（需求 B22、B28、B30，迁移 0006）。事件本身由 sqlEventStore 读写（只追加）。
// 运行记录上的状态、回合与结束原因是由事件得出的缓存，供列表显示；以事件为准，随时可以由回放重算。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, jsonColumn, queryAll, queryOne, type RepoError, type WriteContext } from './common';

const JsonObject = z.record(z.string(), z.unknown());

export const SIM_PROTOCOLS = ['simultaneous', 'turn_based'] as const;
export type SimProtocol = (typeof SIM_PROTOCOLS)[number];

const SceneRow = z
  .object({
    id: z.string(),
    chapter_id: z.string().nullable(),
    title: z.string(),
    config: jsonColumn(JsonObject),
    config_version: z.number().int(),
    protocol: z.enum(SIM_PROTOCOLS),
    max_rounds: z.number().int(),
    first_speaker: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    chapterId: r.chapter_id,
    title: r.title,
    /** 推演场景配置（领域内核的 SceneSpec）；使用前由 parseScene 校验。 */
    config: r.config,
    /** 场景配置每修改一次加一。 */
    configVersion: r.config_version,
    protocol: r.protocol,
    maxRounds: r.max_rounds,
    firstSpeaker: r.first_speaker,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type SimScene = z.output<typeof SceneRow>;

const SCENE_COLUMNS = 'id, chapter_id, title, config, config_version, protocol, max_rounds, first_speaker, version, created_at, updated_at';

export type SimSceneFields = {
  readonly chapterId: string | null;
  readonly title: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly protocol: SimProtocol;
  readonly maxRounds: number;
  readonly firstSpeaker: string | null;
};

function checkScene(fields: SimSceneFields): RepoError | null {
  if (fields.title.trim() === '') return { code: 'invalid', detail: '场景名不能为空' };
  if (!Number.isInteger(fields.maxRounds) || fields.maxRounds < 1) return { code: 'invalid', detail: '回合上限须为正整数' };
  return null;
}

export function createSimScene(port: SqlPort, input: SimSceneFields & { readonly id: string }, ctx: WriteContext): Promise<Result<SimScene, RepoError>> {
  const invalid = checkScene(input);
  if (invalid !== null) return Promise.resolve(err(invalid));
  return insertReturning(port, SceneRow, {
    sql: `INSERT INTO sim_scene (id, chapter_id, title, config, protocol, max_rounds, first_speaker, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${SCENE_COLUMNS}`,
    params: [input.id, input.chapterId, input.title.trim(), JSON.stringify(input.config), input.protocol, input.maxRounds, input.firstSpeaker, ctx.now, ctx.now],
  });
}

/** 修改场景。场景配置变了时配置版本加一；已经开始的运行不受影响（它们带着开始时的配置）。 */
export function updateSimScene(port: SqlPort, current: SimScene, fields: SimSceneFields, ctx: WriteContext): Promise<Result<SimScene, RepoError>> {
  const invalid = checkScene(fields);
  if (invalid !== null) return Promise.resolve(err(invalid));
  const config = JSON.stringify(fields.config);
  const changed = config !== JSON.stringify(current.config) ? 1 : 0;
  return guardedUpdate(port, SceneRow, 'sim_scene', current.id, {
    sql: `UPDATE sim_scene SET chapter_id = ?, title = ?, config = ?, config_version = config_version + ?, protocol = ?, max_rounds = ?, first_speaker = ?,
            version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${SCENE_COLUMNS}`,
    params: [fields.chapterId, fields.title.trim(), config, changed, fields.protocol, fields.maxRounds, fields.firstSpeaker, ctx.now, current.id, current.version],
  });
}

export function getSimScene(port: SqlPort, id: string): Promise<Result<SimScene | null, RepoError>> {
  return queryOne(port, SceneRow, `SELECT ${SCENE_COLUMNS} FROM sim_scene WHERE id = ?`, [id]);
}

/** 全部场景，新建的在前。 */
export function listSimScenes(port: SqlPort): Promise<Result<SimScene[], RepoError>> {
  return queryAll(port, SceneRow, `SELECT ${SCENE_COLUMNS} FROM sim_scene ORDER BY created_at DESC, id DESC`);
}

export const SIM_RUN_STATUSES = ['created', 'running', 'awaiting_author', 'paused', 'ended'] as const;
export type SimRunStatus = (typeof SIM_RUN_STATUSES)[number];

const RunRow = z
  .object({
    id: z.string(),
    scene_id: z.string(),
    scene_config: jsonColumn(JsonObject),
    scene_config_version: z.number().int(),
    mode: z.enum(['interactive', 'auto']),
    batch_id: z.string().nullable(),
    parent_run_id: z.string().nullable(),
    branch_from_seq: z.number().int().nullable(),
    budget_usd: z.number().nullable(),
    status: z.enum(SIM_RUN_STATUSES),
    end_reason: z.string().nullable(),
    pause_reason: z.string().nullable(),
    round: z.number().int(),
    last_seq: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    sceneId: r.scene_id,
    /** 开始时的场景配置：继续与回放都用它，不受场景之后的修改影响。 */
    sceneConfig: r.scene_config,
    sceneConfigVersion: r.scene_config_version,
    mode: r.mode,
    batchId: r.batch_id,
    parentRunId: r.parent_run_id,
    branchFromSeq: r.branch_from_seq,
    /** 费用上限（美元）；没有设置时为 null。 */
    budgetUsd: r.budget_usd,
    status: r.status,
    endReason: r.end_reason,
    pauseReason: r.pause_reason,
    round: r.round,
    lastSeq: r.last_seq,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type SimRun = z.output<typeof RunRow>;

const RUN_COLUMNS =
  'id, scene_id, scene_config, scene_config_version, mode, batch_id, parent_run_id, branch_from_seq, budget_usd, status, end_reason, pause_reason, round, last_seq, created_at, updated_at';

export type SimRunInput = {
  readonly id: string;
  readonly sceneId: string;
  readonly sceneConfig: Readonly<Record<string, unknown>>;
  readonly sceneConfigVersion: number;
  readonly mode: 'interactive' | 'auto';
  readonly batchId?: string;
  /** 分支：来源的运行与序号。 */
  readonly parent?: { readonly runId: string; readonly seq: number };
  readonly budgetUsd?: number;
};

/** 登记一次运行（还没有事件）。事件由引擎经 sqlEventStore 追加。 */
export function createSimRun(port: SqlPort, input: SimRunInput, ctx: WriteContext): Promise<Result<SimRun, RepoError>> {
  return insertReturning(port, RunRow, {
    sql: `INSERT INTO sim_run (id, scene_id, scene_config, scene_config_version, mode, batch_id, parent_run_id, branch_from_seq, budget_usd, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${RUN_COLUMNS}`,
    params: [
      input.id,
      input.sceneId,
      JSON.stringify(input.sceneConfig),
      input.sceneConfigVersion,
      input.mode,
      input.batchId ?? null,
      input.parent?.runId ?? null,
      input.parent?.seq ?? null,
      input.budgetUsd ?? null,
      ctx.now,
      ctx.now,
    ],
  });
}

export function getSimRun(port: SqlPort, id: string): Promise<Result<SimRun | null, RepoError>> {
  return queryOne(port, RunRow, `SELECT ${RUN_COLUMNS} FROM sim_run WHERE id = ?`, [id]);
}

/** 一个场景的运行，新的在前。 */
export function listSimRuns(port: SqlPort, sceneId: string): Promise<Result<SimRun[], RepoError>> {
  return queryAll(port, RunRow, `SELECT ${RUN_COLUMNS} FROM sim_run WHERE scene_id = ? ORDER BY created_at DESC, id DESC`, [sceneId]);
}

/** 批量推演（B48）的一组运行，按开始的先后。 */
export function listBatchRuns(port: SqlPort, batchId: string): Promise<Result<SimRun[], RepoError>> {
  return queryAll(port, RunRow, `SELECT ${RUN_COLUMNS} FROM sim_run WHERE batch_id = ? ORDER BY created_at, id`, [batchId]);
}

export type SimRunProgress = {
  readonly status: SimRunStatus;
  readonly endReason: string | null;
  readonly pauseReason: string | null;
  readonly round: number;
};

/** 把由事件得出的进度写回运行记录（缓存）。 */
export async function setSimRunProgress(port: SqlPort, runId: string, progress: SimRunProgress, ctx: WriteContext): Promise<Result<SimRun, RepoError>> {
  const result = await port.transaction([
    {
      sql: `UPDATE sim_run SET status = ?, end_reason = ?, pause_reason = ?, round = ?, updated_at = ? WHERE id = ? RETURNING ${RUN_COLUMNS}`,
      params: [progress.status, progress.endReason, progress.pauseReason, progress.round, ctx.now, runId],
    },
  ]);
  if (!result.ok) return err({ code: 'sql', error: result.error });
  const row = result.value[0]?.rows[0];
  if (row === undefined) return err({ code: 'not_found' });
  const parsed = RunRow.safeParse(row);
  return parsed.success ? ok(parsed.data) : err({ code: 'invalid', detail: '运行记录格式不对' });
}

const SnapshotRow = z
  .object({ run_id: z.string(), seq: z.number().int(), state: jsonColumn(z.unknown()), state_hash: z.string(), created_at: z.string() })
  .transform((r) => ({ runId: r.run_id, seq: r.seq, state: r.state, stateHash: r.state_hash, createdAt: r.created_at }));
export type SimSnapshot = z.output<typeof SnapshotRow>;

/** 记下某个序号处的状态与哈希。同一序号只记一次：事件不变，状态也不会变。 */
export async function saveSimSnapshot(
  port: SqlPort,
  input: { readonly runId: string; readonly seq: number; readonly state: unknown; readonly stateHash: string },
  ctx: WriteContext,
): Promise<Result<void, RepoError>> {
  const result = await port.transaction([
    {
      sql: 'INSERT OR IGNORE INTO sim_snapshot (run_id, seq, state, state_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      params: [input.runId, input.seq, JSON.stringify(input.state), input.stateHash, ctx.now],
    },
  ]);
  return result.ok ? ok(undefined) : err({ code: 'sql', error: result.error });
}

export function listSimSnapshots(port: SqlPort, runId: string): Promise<Result<SimSnapshot[], RepoError>> {
  return queryAll(port, SnapshotRow, 'SELECT run_id, seq, state, state_hash, created_at FROM sim_snapshot WHERE run_id = ? ORDER BY seq', [runId]);
}

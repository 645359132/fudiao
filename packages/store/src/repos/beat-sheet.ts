// 节拍表（需求 B45，迁移 0007）：在推演的事件记录与正文之间，作者为视角角色认知中的各条见闻标记处理方式。
// 它是派生结论（硬性规则 21）：记下依据的运行、视角角色与事件序号；写正文时只用视角角色在那一刻的认知（硬性规则 3）。
import { err, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, jsonColumn, queryAll, queryOne, type RepoError, type WriteContext } from './common';

export const BEAT_TREATMENTS = ['expand', 'brief', 'omit', 'flashback', 'blank'] as const;
export type BeatTreatment = (typeof BEAT_TREATMENTS)[number];

/** 一个节拍：指向视角角色的一条认知；withhold 为暂不向读者揭示。 */
export const Beat = z.object({ ref: z.string().min(1), treatment: z.enum(BEAT_TREATMENTS), note: z.string(), withhold: z.boolean() });
export type Beat = z.infer<typeof Beat>;

const SheetRow = z
  .object({
    id: z.string(),
    run_id: z.string(),
    pov_actor: z.string(),
    from_round: z.number().int(),
    to_round: z.number().int(),
    up_to_seq: z.number().int(),
    beats: jsonColumn(z.array(Beat)),
    style: z.string(),
    llm_call_id: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    runId: r.run_id,
    povActor: r.pov_actor,
    fromRound: r.from_round,
    toRound: r.to_round,
    /** 视角角色的认知取到这个事件序号为止。 */
    upToSeq: r.up_to_seq,
    beats: r.beats,
    style: r.style,
    llmCallId: r.llm_call_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type BeatSheet = z.output<typeof SheetRow>;

const COLUMNS = 'id, run_id, pov_actor, from_round, to_round, up_to_seq, beats, style, llm_call_id, version, created_at, updated_at';

export type BeatSheetInput = {
  readonly id: string;
  readonly runId: string;
  readonly povActor: string;
  readonly fromRound: number;
  readonly toRound: number;
  readonly upToSeq: number;
  readonly beats: readonly Beat[];
  readonly style: string;
  readonly llmCallId: string | null;
};

export function createBeatSheet(port: SqlPort, input: BeatSheetInput, ctx: WriteContext): Promise<Result<BeatSheet, RepoError>> {
  return insertReturning(port, SheetRow, {
    sql: `INSERT INTO beat_sheet (id, run_id, pov_actor, from_round, to_round, up_to_seq, beats, style, llm_call_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [input.id, input.runId, input.povActor, input.fromRound, input.toRound, input.upToSeq, JSON.stringify(input.beats), input.style, input.llmCallId, ctx.now, ctx.now],
  });
}

export function getBeatSheet(port: SqlPort, id: string): Promise<Result<BeatSheet | null, RepoError>> {
  return queryOne(port, SheetRow, `SELECT ${COLUMNS} FROM beat_sheet WHERE id = ?`, [id]);
}

/** 一次运行的节拍表，新的在前。 */
export function listBeatSheets(port: SqlPort, runId: string): Promise<Result<BeatSheet[], RepoError>> {
  return queryAll(port, SheetRow, `SELECT ${COLUMNS} FROM beat_sheet WHERE run_id = ? ORDER BY created_at DESC, id DESC`, [runId]);
}

/** 作者修改节拍的处理方式、说明与文风。依据的运行、视角与事件序号不变。 */
export function updateBeatSheet(port: SqlPort, current: BeatSheet, fields: { readonly beats: readonly Beat[]; readonly style: string }, ctx: WriteContext): Promise<Result<BeatSheet, RepoError>> {
  const beats = z.array(Beat).safeParse(fields.beats);
  if (!beats.success) return Promise.resolve(err({ code: 'invalid', detail: '节拍的内容不对' }));
  return guardedUpdate(port, SheetRow, 'beat_sheet', current.id, {
    sql: `UPDATE beat_sheet SET beats = ?, style = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [JSON.stringify(beats.data), fields.style, ctx.now, current.id, current.version],
  });
}

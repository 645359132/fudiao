// SQLite 上的推演事件存储（sim_event，迁移 0006）。桌面端经 Rust 的 SqlPort、测试经 Node 的 SqlPort 使用同一份实现，
// 与 M0 的 JSONL 实现共用 EventStore 接口与契约测试。
// 一批事件在一个事务中写入：要么整批生效，要么一条也不写；序号守卫防止两个写入者交错。
// 这里只有追加与读取，没有修改与删除（硬性规则 8；表上的触发器同样拒绝）。
import { err, ok } from '@fudiao/shared';
import { z } from 'zod';
import { envelope, type EventStore, type StoredEvent } from './event-store';
import type { SqlPort, Statement } from './sql';

const EventRow = z.object({
  run_id: z.string(),
  seq: z.number().int(),
  batch_first: z.number().int(),
  batch_index: z.number().int(),
  batch_size: z.number().int(),
  payload: z.string(),
  created_at: z.string(),
});

const INSERT_COLUMNS = 'run_id, seq, batch_first, batch_index, batch_size, type, actor, payload, created_at';

/** 事件内容里的类型与行动者（有的话），写进查询用的列；内容仍以 payload 为准。 */
function labels(payload: unknown): { type: string | null; actor: string | null } {
  if (typeof payload !== 'object' || payload === null) return { type: null, actor: null };
  const { type, actor } = payload as { type?: unknown; actor?: unknown };
  return { type: typeof type === 'string' ? type : null, actor: typeof actor === 'string' ? actor : null };
}

async function lastSeq(port: SqlPort, runId: string): Promise<number> {
  const rows = await port.query('SELECT coalesce(max(seq), 0) AS seq FROM sim_event WHERE run_id = ?', [runId]);
  if (!rows.ok) throw new Error(`读取推演事件失败：${JSON.stringify(rows.error)}`);
  return Number(rows.value[0]?.['seq'] ?? 0);
}

/**
 * 运行必须先登记在 sim_run 中（由应用服务层在开始推演时建立）；给没有登记的运行追加事件会失败。
 * 序号冲突以外的失败（库没有打开、约束不满足）以异常抛出，由调用方在边界处处理。
 */
export function sqlEventStore(port: SqlPort): EventStore {
  return {
    async append(runId, expectedSeq, payloads, at) {
      if (payloads.length === 0) {
        const actual = await lastSeq(port, runId);
        return actual === expectedSeq ? ok(actual) : err({ code: 'seq_conflict', expected: expectedSeq, actual });
      }
      const events = envelope(runId, expectedSeq, payloads, at);
      const values = (e: StoredEvent) => {
        const { type, actor } = labels(e.payload);
        return [e.runId, e.seq, e.batch.first, e.batch.index, e.batch.size, type, actor, JSON.stringify(e.payload), e.at];
      };
      const statements: Statement[] = events.map((e, i) =>
        i === 0
          ? {
              // 守卫：这次运行的最后序号仍是调用方读到的那个，否则不插入，整个事务回滚。
              sql: `INSERT INTO sim_event (${INSERT_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
                    WHERE (SELECT coalesce(max(seq), 0) FROM sim_event WHERE run_id = ?) = ?`,
              params: [...values(e), runId, expectedSeq],
              expectChanges: 1,
            }
          : { sql: `INSERT INTO sim_event (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: values(e) },
      );
      const last = expectedSeq + payloads.length;
      // 运行记录上的最后序号是缓存，随事件一同更新。
      statements.push({ sql: 'UPDATE sim_run SET last_seq = ?, updated_at = ? WHERE id = ?', params: [last, at, runId] });
      const result = await port.transaction(statements);
      if (result.ok) return ok(last);
      const actual = await lastSeq(port, runId);
      if (actual !== expectedSeq) return err({ code: 'seq_conflict', expected: expectedSeq, actual });
      throw new Error(`推演事件没有写入：${JSON.stringify(result.error)}`);
    },

    async read(runId) {
      const rows = await port.query('SELECT run_id, seq, batch_first, batch_index, batch_size, payload, created_at FROM sim_event WHERE run_id = ? ORDER BY seq', [runId]);
      if (!rows.ok) throw new Error(`读取推演事件失败：${JSON.stringify(rows.error)}`);
      return rows.value.map((raw): StoredEvent => {
        const r = EventRow.parse(raw);
        return {
          runId: r.run_id,
          seq: r.seq,
          at: r.created_at,
          batch: { first: r.batch_first, index: r.batch_index, size: r.batch_size },
          payload: JSON.parse(r.payload) as unknown,
        };
      });
    },

    async runs() {
      const rows = await port.query('SELECT DISTINCT run_id FROM sim_event ORDER BY run_id');
      if (!rows.ok) throw new Error(`读取推演运行失败：${JSON.stringify(rows.error)}`);
      return rows.value.map((r) => String(r['run_id']));
    },
  };
}

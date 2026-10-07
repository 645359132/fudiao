import type { Result } from '@novel-writer/shared';

/** 一条已写入的事件。事件只追加，不修改、不删除（硬性规则 8）。 */
export type StoredEvent = {
  readonly runId: string;
  /** 从 1 开始连续递增。 */
  readonly seq: number;
  /** 写入时间，UTC ISO 字符串。 */
  readonly at: string;
  /** 同一次追加的事件属于同一批次；读取时丢弃不完整的批次。 */
  readonly batch: { readonly first: number; readonly index: number; readonly size: number };
  readonly payload: unknown;
};

export type AppendConflict = { readonly code: 'seq_conflict'; readonly expected: number; readonly actual: number };

/** 推演事件存储（sim_event）。桌面端的 SQLite 实现与 M0 的 JSONL 实现共用此接口。 */
export interface EventStore {
  /**
   * 追加一批事件。expectedSeq 为调用方读到的最后序号（空记录为 0）；
   * 与实际不一致时返回冲突，防止两个写入者交错。成功时返回新的最后序号。
   */
  append(runId: string, expectedSeq: number, payloads: readonly unknown[], at: string): Promise<Result<number, AppendConflict>>;
  read(runId: string): Promise<readonly StoredEvent[]>;
  runs(): Promise<readonly string[]>;
}

/** 生成一批事件的信封。 */
export function envelope(runId: string, lastSeq: number, payloads: readonly unknown[], at: string): StoredEvent[] {
  const first = lastSeq + 1;
  return payloads.map((payload, index) => ({
    runId,
    seq: first + index,
    at,
    batch: { first, index, size: payloads.length },
    payload,
  }));
}

/**
 * 只保留完整的批次。批次不完整说明写入时崩溃，这一批从未生效。
 * 返回保留的事件与它们在输入中所占的条数。
 */
export function completeBatches(events: readonly StoredEvent[]): { events: StoredEvent[]; kept: number } {
  const kept: StoredEvent[] = [];
  let i = 0;
  while (i < events.length) {
    const head = events[i];
    if (head === undefined) break;
    const batch = events.slice(i, i + head.batch.size);
    const complete =
      head.batch.index === 0 &&
      batch.length === head.batch.size &&
      batch.every((e, k) => e.batch.first === head.batch.first && e.batch.index === k && e.seq === head.seq + k);
    if (!complete) break;
    kept.push(...batch);
    i += batch.length;
  }
  return { events: kept, kept: i };
}

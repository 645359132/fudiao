import { err, ok } from '@fudiao/shared';
import { envelope, type EventStore, type StoredEvent } from './event-store';

/** 内存中的事件存储，测试使用。 */
export function memoryEventStore(): EventStore & { readonly raw: Map<string, StoredEvent[]> } {
  const raw = new Map<string, StoredEvent[]>();
  return {
    raw,
    append(runId, expectedSeq, payloads, at) {
      const events = raw.get(runId) ?? [];
      const actual = events.at(-1)?.seq ?? 0;
      if (actual !== expectedSeq) return Promise.resolve(err({ code: 'seq_conflict', expected: expectedSeq, actual }));
      // 存入深拷贝：调用方之后修改对象不会影响记录，与文件实现的行为一致。
      const copied = payloads.map((p) => JSON.parse(JSON.stringify(p)) as unknown);
      raw.set(runId, [...events, ...envelope(runId, actual, copied, at)]);
      return Promise.resolve(ok(actual + payloads.length));
    },
    read(runId) {
      return Promise.resolve(raw.get(runId) ?? []);
    },
    runs() {
      return Promise.resolve([...raw.keys()].sort());
    },
  };
}

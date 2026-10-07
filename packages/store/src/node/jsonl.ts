import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { CallLog, LlmCallRecord } from '@novel-writer/llm';
import { err, ok } from '@novel-writer/shared';
import { completeBatches, envelope, type EventStore, type StoredEvent } from '../event-store';

/** 按行解析，遇到无法解析的一行即停止：它只可能是崩溃时写到一半的末尾。 */
function parseLines(text: string): { events: StoredEvent[]; validBytes: number } {
  const events: StoredEvent[] = [];
  let offset = 0;
  let validBytes = 0;
  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (line.trim() === '') {
      offset += lineBytes;
      continue;
    }
    try {
      events.push(JSON.parse(line) as StoredEvent);
    } catch {
      break;
    }
    offset += lineBytes;
    validBytes = offset;
  }
  return { events, validBytes };
}

function appendAtomically(path: string, text: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * JSONL 文件事件存储：`<dir>/<runId>/events.jsonl`。一批事件一次写入并 fsync；
 * 读取时丢弃末尾不完整的批次，追加前把文件截断到最后一个完整批次。
 */
export function jsonlEventStore(dir: string): EventStore {
  const fileOf = (runId: string) => join(dir, runId, 'events.jsonl');

  const load = (runId: string) => {
    const path = fileOf(runId);
    if (!existsSync(path)) return { events: [] as StoredEvent[], validBytes: 0, path };
    const text = readFileSync(path, 'utf8');
    const parsed = parseLines(text);
    const complete = completeBatches(parsed.events);
    const validBytes = complete.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e), 'utf8') + 1, 0);
    return { events: complete.events, validBytes, path };
  };

  return {
    append(runId, expectedSeq, payloads, at) {
      mkdirSync(join(dir, runId), { recursive: true });
      const { events, validBytes, path } = load(runId);
      const actual = events.at(-1)?.seq ?? 0;
      if (actual !== expectedSeq) return Promise.resolve(err({ code: 'seq_conflict', expected: expectedSeq, actual }));
      if (existsSync(path)) {
        // 去掉崩溃留下的半个批次，保证文件中只有完整的批次。
        const fd = openSync(path, 'r+');
        try {
          ftruncateSync(fd, validBytes);
        } finally {
          closeSync(fd);
        }
      }
      const lines = envelope(runId, actual, payloads, at).map((e) => `${JSON.stringify(e)}\n`);
      appendAtomically(path, lines.join(''));
      return Promise.resolve(ok(actual + payloads.length));
    },
    read(runId) {
      return Promise.resolve(load(runId).events);
    },
    runs() {
      if (!existsSync(dir)) return Promise.resolve([]);
      return Promise.resolve(
        readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'events.jsonl')))
          .map((d) => d.name)
          .sort(),
      );
    },
  };
}

const FINAL = new Set(['completed', 'truncated', 'refused']);

/** JSONL 文件调用记录（llm_call）：`<dir>/<runId>/calls.jsonl`。不含请求头与凭据。 */
export function jsonlCallLog(dir: string, runId: string): CallLog {
  const path = join(dir, runId, 'calls.jsonl');
  const records = (): LlmCallRecord[] => {
    if (!existsSync(path)) return [];
    const out: LlmCallRecord[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as LlmCallRecord);
      } catch {
        break;
      }
    }
    return out;
  };
  return {
    findCompleted(stepKey) {
      return Promise.resolve(records().findLast((r) => r.stepKey === stepKey && FINAL.has(r.status)));
    },
    append(record) {
      mkdirSync(join(dir, runId), { recursive: true });
      appendAtomically(path, `${JSON.stringify(record)}\n`);
      return Promise.resolve();
    },
  };
}

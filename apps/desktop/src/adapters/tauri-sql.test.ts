import { describe, expect, it } from 'vitest';
import { openProjectDb, tauriSqlPort, type Invoke } from './tauri-sql';

/** 让假 invoke 以 reason 拒绝。 */
class Reject {
  constructor(readonly reason: unknown) {}
}

/** 记录调用并按命令返回预设结果的假 invoke。 */
function fakeInvoke(handlers: Record<string, (args: Record<string, unknown> | undefined) => unknown>) {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const invoke = (<T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    const result = handlers[command]?.(args);
    // Tauri 在命令返回 Err 时以序列化后的错误对象（不是 Error）拒绝，这里照样模拟。
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return result instanceof Reject ? Promise.reject(result.reason) : Promise.resolve(result as T);
  }) as Invoke;
  return { invoke, calls };
}

describe('SqlPort 的 Tauri 适配', () => {
  it('查询与事务的参数按 Rust 命令的参数名传递', async () => {
    const { invoke, calls } = fakeInvoke({
      db_query: () => [{ id: 'a' }],
      db_tx: () => [{ changes: 1, rows: [] }],
    });
    const port = tauriSqlPort(invoke);
    expect(await port.query('SELECT id FROM item WHERE id = ?', ['a'])).toEqual({ ok: true, value: [{ id: 'a' }] });
    expect(await port.transaction([{ sql: 'UPDATE item SET title = ? WHERE version = ?', params: ['乙', 1], expectChanges: 1 }])).toEqual({
      ok: true,
      value: [{ changes: 1, rows: [] }],
    });
    expect(calls).toEqual([
      { command: 'db_query', args: { sql: 'SELECT id FROM item WHERE id = ?', params: ['a'] } },
      { command: 'db_tx', args: { statements: [{ sql: 'UPDATE item SET title = ? WHERE version = ?', params: ['乙', 1], expectChanges: 1 }] } },
    ]);
  });

  it('Rust 返回的错误原样转为 Result', async () => {
    const guard = { code: 'guard_failed', index: 0, expected: 1, actual: 0 };
    const { invoke } = fakeInvoke({
      db_tx: () => new Reject(guard),
    });
    expect(await tauriSqlPort(invoke).transaction([{ sql: 'UPDATE item SET title = 1', expectChanges: 1 }])).toEqual({ ok: false, error: guard });
  });

  it('IPC 本身失败时转为 sql_error', async () => {
    const { invoke } = fakeInvoke({
      db_query: () => new Reject(new Error('ipc closed')),
    });
    expect(await tauriSqlPort(invoke).query('SELECT 1')).toEqual({ ok: false, error: { code: 'sql_error', index: 0, detail: 'ipc closed' } });
  });

  it('打开作品库时传递项目文件夹与当前时间', async () => {
    const report = { schemaVersion: 1, applied: [{ version: 1, name: 'init' }], backup: null };
    const { invoke, calls } = fakeInvoke({ db_open: () => report });
    expect(await openProjectDb(invoke, 'D:/作品/雨夜', '2026-10-07T00:00:00.000Z')).toEqual({ ok: true, value: report });
    expect(calls[0]).toEqual({ command: 'db_open', args: { projectDir: 'D:/作品/雨夜', now: '2026-10-07T00:00:00.000Z' } });
  });
});

// 作品库端口的“代次”守卫（审查后的修正，2026-10-29）：从备份恢复后，恢复前发起、还拿着旧端口的用例（写手的一段、
// 修订、整理记忆、找关系变化……）不能再读写——不然恢复前发出的模型请求返回后，旧文字会写进恢复后的作品库。
// 用例在开始时取一次端口；恢复时吊销旧的包装、换一个新的，恢复失败则恢复旧包装。状态层恢复前先停下并等齐后台工作，
// 这里是兜底：等不到的（模型不响应取消）与没登记为任务的路径也不会写进去。
import { err, type Result } from '@fudiao/shared';
import type { SqlError, SqlPort } from '@fudiao/store';

export const REVOKED_DETAIL = '作品库已从备份恢复，恢复前发起的这次操作已作废';

export type GuardedPort = {
  readonly port: SqlPort;
  /** 之后经这个包装的读写都被拒绝。 */
  revoke(): void;
  /** 恢复没有成功：包装照旧可用。 */
  reinstate(): void;
};

export function guardedPort(raw: SqlPort): GuardedPort {
  let revoked = false;
  const refused = <T>(): Promise<Result<T, SqlError>> => Promise.resolve(err({ code: 'sql_error', index: 0, detail: REVOKED_DETAIL }));
  return {
    port: {
      query: (sql, params) => (revoked ? refused() : raw.query(sql, params)),
      read: (queries) => (revoked ? refused() : raw.read(queries)),
      transaction: (statements) => (revoked ? refused() : raw.transaction(statements)),
    },
    revoke() {
      revoked = true;
    },
    reinstate() {
      revoked = false;
    },
  };
}

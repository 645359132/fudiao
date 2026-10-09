// 数据层的导出与导入：每张表一个 JSONL（施工文档第四章“完整项目导出”的 data/ 部分）。
// 只依赖 SqlPort，桌面端与 Node 端通用；zip、manifest 与章节 Markdown 在 M1-07。
import { err, ok, type Result } from '@fudiao/shared';
import { TABLES, type TableSpec } from './schema';
import type { SqlError, SqlPort, SqlValue, Statement } from './sql';

export type ExportedRow = Readonly<Record<string, unknown>>;

export type ExportedData = {
  readonly schemaVersion: number;
  readonly tables: Readonly<Record<string, readonly ExportedRow[]>>;
};

export type DataError =
  | { readonly code: 'sql'; readonly error: SqlError }
  | { readonly code: 'not_empty'; readonly table: string }
  | { readonly code: 'schema_mismatch'; readonly expected: number; readonly actual: number }
  | { readonly code: 'invalid'; readonly table: string; readonly row: number; readonly detail: string };

async function schemaVersion(port: SqlPort): Promise<Result<number, DataError>> {
  const rows = await port.query('SELECT coalesce(max(version), 0) AS v FROM schema_migrations');
  if (!rows.ok) return err({ code: 'sql', error: rows.error });
  return ok(Number(rows.value[0]?.['v'] ?? 0));
}

const parseJson = (text: string): unknown => JSON.parse(text);

type Tables = ExportedData['tables'];

/**
 * 每个迁移对导出数据的转换：把结构版本 v - 1 导出的表改写成版本 v 的样子，导入较旧的作品包时依次执行。
 * 新增迁移必须在这里登记（测试检查每个迁移都有对应项）；只增加派生表或不影响导出表的迁移登记为原样保留。
 */
export const UPGRADES: Readonly<Record<number, (tables: Tables) => Tables>> = {
  // 0002：全文查找索引，派生数据，导出的表不变。
  2: (tables) => tables,
  // 0003：新增 llm_call 表；旧版本导出的数据中没有这张表，导入为空。
  3: (tables) => tables,
  // 0004：新增 candidate 表，同上。
  4: (tables) => tables,
  // 0005：新增写手与审核的五张表；快照表重建只放宽了原因的取值，旧数据原样有效。
  5: (tables) => tables,
};

export async function exportData(port: SqlPort): Promise<Result<ExportedData, DataError>> {
  const version = await schemaVersion(port);
  if (!version.ok) return version;
  const tables: Record<string, ExportedRow[]> = {};
  for (const t of TABLES) {
    const rows = await port.query(`SELECT ${t.columns.join(', ')} FROM ${t.name} ORDER BY ${t.primaryKey.join(', ')}`);
    if (!rows.ok) return err({ code: 'sql', error: rows.error });
    tables[t.name] = rows.value.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const column of t.json) {
        const value = row[column];
        if (typeof value === 'string') out[column] = parseJson(value);
      }
      return out;
    });
  }
  return ok({ schemaVersion: version.value, tables });
}

export const toJsonl = (rows: readonly ExportedRow[]): string => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

export function fromJsonl(table: string, text: string): Result<ExportedRow[], DataError> {
  const rows: ExportedRow[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return err({ code: 'invalid', table, row: index, detail: '每行必须是一个对象' });
      }
      rows.push(value as ExportedRow);
    } catch (error) {
      return err({ code: 'invalid', table, row: index, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return ok(rows);
}

function insertStatement(t: TableSpec, row: ExportedRow, index: number): Result<Statement, DataError> {
  const columns = Object.keys(row);
  const params: SqlValue[] = [];
  for (const column of columns) {
    if (!t.columns.includes(column)) return err({ code: 'invalid', table: t.name, row: index, detail: `未知的列 ${column}` });
    const value = row[column];
    if (t.json.includes(column)) {
      params.push(value === null || value === undefined ? null : JSON.stringify(value));
    } else if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      params.push(value);
    } else {
      return err({ code: 'invalid', table: t.name, row: index, detail: `列 ${column} 的值类型不受支持` });
    }
  }
  return ok({ sql: `INSERT INTO ${t.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, params });
}

/**
 * 导入到空库：版本须与当前库一致（跨版本导入在 M1-07 处理），按外键依赖顺序在一个事务中插入。
 * 导入的数据来自文件，逐行校验表名、列名与值类型；约束由数据库检查，失败时整体回滚。
 */
export async function importData(port: SqlPort, input: ExportedData): Promise<Result<Readonly<Record<string, number>>, DataError>> {
  const version = await schemaVersion(port);
  if (!version.ok) return version;
  // 较旧版本导出的数据依次经过各迁移的转换；比本程序新的拒绝。
  const mismatch = err({ code: 'schema_mismatch', expected: version.value, actual: input.schemaVersion } as const);
  if (input.schemaVersion > version.value || input.schemaVersion < 1) return mismatch;
  let upgraded = input.tables;
  for (let v = input.schemaVersion + 1; v <= version.value; v++) {
    const upgrade = UPGRADES[v];
    if (upgrade === undefined) return mismatch;
    upgraded = upgrade(upgraded);
  }
  const data: ExportedData = { schemaVersion: version.value, tables: upgraded };

  for (const name of Object.keys(data.tables)) {
    if (!TABLES.some((t) => t.name === name)) return err({ code: 'invalid', table: name, row: -1, detail: '未知的表' });
  }
  const statements: Statement[] = [];
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const existing = await port.query(`SELECT 1 AS present FROM ${t.name} LIMIT 1`);
    if (!existing.ok) return err({ code: 'sql', error: existing.error });
    if (existing.value.length > 0) return err({ code: 'not_empty', table: t.name });
    const rows = data.tables[t.name] ?? [];
    for (const [index, row] of rows.entries()) {
      const statement = insertStatement(t, row, index);
      if (!statement.ok) return statement;
      statements.push(statement.value);
    }
    counts[t.name] = rows.length;
  }
  const done = await port.transaction(statements);
  return done.ok ? ok(counts) : err({ code: 'sql', error: done.error });
}

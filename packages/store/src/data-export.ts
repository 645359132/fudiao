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
  // 0006：新增角色推演的四张表，旧版本导出的数据中没有，导入为空。
  6: (tables) => tables,
  // 0007：新增节拍表；候选稿增加 beat_sheet_id 列（旧数据为空）与“推演写成正文”的操作。
  7: (tables) => ({ ...tables, candidate: (tables['candidate'] ?? []).map((row) => ({ beat_sheet_id: null, ...row })) }),
  // 0008：新增推演评价表，旧版本导出的数据中没有，导入为空。
  8: (tables) => tables,
  // 0009：写作技能增加适用说明 description（旧数据为空）。
  9: (tables) => ({ ...tables, writing_skill: (tables['writing_skill'] ?? []).map((row) => ({ description: '', ...row })) }),
  // 0010：新增卷；章节增加 volume_id（旧数据都是未分卷）。
  // 0011：新增 AI 助手的对话，旧版本导出的数据中没有，导入为空。
  11: (tables) => tables,
  // 0012：新增人物关系与关系图上的位置，旧版本导出的数据中没有，导入为空。
  12: (tables) => tables,
  // 0013：长篇记忆增加“章尾留给后面的事”（旧数据为空）。
  13: (tables) => ({ ...tables, chapter_memory: (tables['chapter_memory'] ?? []).map((row) => ({ open_threads: [], ...row })) }),
  10: (tables) => ({ ...tables, chapter: (tables['chapter'] ?? []).map((row) => ({ volume_id: null, ...row })) }),
  // 0015：新增作品封面，旧版本导出的数据中没有，导入为空（界面显示按书名排出的文字封面）。
  15: (tables) => tables,
  // 0016：AI 助手的对话增加改动与撤销两种记录，旧数据原样有效。
  16: (tables) => tables,
  // 0017：新增删除过的段落的最后版本；旧版本导出的数据中没有，导入为空。
  17: (tables) => tables,
  // 0018：调用记录增加费用估计 cost_estimate（旧数据为空，费用未知的仍按未知显示）。
  18: (tables) => ({ ...tables, llm_call: (tables['llm_call'] ?? []).map((row) => ({ cost_estimate: null, ...row })) }),
  // 0019：新增写作工作流的运行与步骤，旧版本导出的数据中没有，导入为空。
  19: (tables) => tables,
  // 0020：审核问题的来源增加跨章连贯检查（continuity），表重建只放宽了取值，旧数据原样有效。
  20: (tables) => tables,
  // 0021：审核问题的来源增加开篇诊断（opening），表重建只放宽了取值，旧数据原样有效。
  21: (tables) => tables,
  // 0022：扫榜拆书的样章原文，只留在本机、不导出，导出的表不变。
  22: (tables) => tables,
  // 0014：写作技能增加阶段 stages（旧数据都是写章节用的；“作者偏好”在规划时也要遵守，与迁移相同）。
  14: (tables) => ({
    ...tables,
    writing_skill: (tables['writing_skill'] ?? []).map((row) => ({ stages: row['key'] === 'author-preferences' && row['builtin_version'] === null ? 'planning writing' : 'writing', ...row })),
  }),
};

/** 导出时去掉模型输出原文的模板（扫榜拆书的逐本拆解，B79）。 */
export const BENCHMARK_BOOK_TEMPLATE = 'benchmark_book';

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
      // 扫榜拆书逐本拆解的模型输出可能抄了样章（别人的作品）：原文只留在本机，导出时去掉，用量与费用照旧。
      if (t.name === 'llm_call' && out['template_id'] === BENCHMARK_BOOK_TEMPLATE) out['response'] = null;
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

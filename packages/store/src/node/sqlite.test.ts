import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import type { Migration, Row, SqlValue, Statement } from '../sql';
import { loadMigrations, migrationChecksum, openProjectDb, type ProjectDb } from './sqlite';

type Case = {
  readonly name: string;
  readonly query?: { readonly sql: string; readonly params?: SqlValue[] };
  readonly tx?: Statement[];
  readonly expect: { readonly rows?: Row[]; readonly results?: unknown[]; readonly error?: Record<string, unknown> };
  readonly after?: { readonly sql: string; readonly rows: Row[] };
};
type Contract = { setup: string[]; cases: Case[]; checksums: { text: string; sha256: string }[] };

const contract = JSON.parse(readFileSync(new URL('../../contract/sql-cases.json', import.meta.url), 'utf8')) as Contract;
const root = mkdtempSync(join(tmpdir(), 'fudiao-sql-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function open(migrations: readonly Migration[] = [], dir = join(root, `p${n++}`), now = '2026-10-07T00:00:00.000Z') {
  const result = openProjectDb(dir, { migrations, now });
  if (result.ok) opened.push(result.value.db);
  return { result, dir };
}

async function fresh() {
  const { result } = open();
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const db = result.value.db;
  const setup = await db.transaction(contract.setup.map((sql) => ({ sql })));
  if (!setup.ok) throw new Error(JSON.stringify(setup.error));
  return db;
}

describe('SqlPort 契约（Node 实现）', () => {
  it.each(contract.cases.map((c) => [c.name, c] as const))('%s', async (_, c) => {
    const db = await fresh();
    const result = c.query ? await db.query(c.query.sql, c.query.params) : await db.transaction(c.tx ?? []);
    if (c.expect.error) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject(c.expect.error);
    } else {
      expect(result).toEqual({ ok: true, value: c.expect.rows ?? c.expect.results });
    }
    if (c.after) expect(await db.query(c.after.sql)).toEqual({ ok: true, value: c.after.rows });
  });

  it.each(contract.checksums.map((c) => [JSON.stringify(c.text), c] as const))('迁移校验和 %s', (_, c) => {
    expect(migrationChecksum(c.text)).toBe(c.sha256);
  });
});

const m1: Migration = { version: 1, name: 'create_work', sql: 'CREATE TABLE work (id TEXT PRIMARY KEY, title TEXT NOT NULL);\n' };
const m2: Migration = { version: 2, name: 'add_genre', sql: 'ALTER TABLE work ADD COLUMN genre TEXT;\n' };

describe('迁移（Node 实现）', () => {
  it('新建的库按版本顺序执行全部迁移，不生成备份', async () => {
    const { result, dir } = open([m1, m2]);
    expect(result.ok && result.value.report).toEqual({
      schemaVersion: 2,
      applied: [
        { version: 1, name: 'create_work' },
        { version: 2, name: 'add_genre' },
      ],
      backup: null,
    });
    if (!result.ok) return;
    const rows = await result.value.db.query('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
    expect(rows.ok && rows.value.map((r) => r['version'])).toEqual([1, 2]);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('重新打开时不重复执行', () => {
    const { dir } = open([m1, m2]);
    opened.pop()?.close();
    const again = open([m1, m2], dir);
    expect(again.result.ok && again.result.value.report).toEqual({ schemaVersion: 2, applied: [], backup: null });
  });

  it('已有数据的库在迁移前备份；备份停留在迁移前的版本', async () => {
    const { result, dir } = open([m1]);
    if (!result.ok) throw new Error('打开失败');
    await result.value.db.transaction([{ sql: "INSERT INTO work VALUES ('w1', '雨夜')" }]);
    opened.pop()?.close();
    const upgraded = open([m1, m2], dir, '2026-10-08T09:30:00.000Z');
    expect(upgraded.result.ok && upgraded.result.value.report.applied).toEqual([{ version: 2, name: 'add_genre' }]);
    expect(readdirSync(join(dir, 'backups'))).toEqual(['pre-migration-v1-2026-10-08T09-30-00.000Z.sqlite']);
    // 备份是完整、可打开的库，内容与结构停留在迁移前。
    const backup = new Database(join(dir, 'backups', 'pre-migration-v1-2026-10-08T09-30-00.000Z.sqlite'), { readonly: true });
    expect(backup.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 });
    expect(backup.prepare('SELECT * FROM work').all()).toEqual([{ id: 'w1', title: '雨夜' }]);
    backup.close();
  });

  it('已执行的迁移被改动时拒绝打开', () => {
    const { dir } = open([m1]);
    opened.pop()?.close();
    const changed = open([{ ...m1, sql: 'CREATE TABLE work (id TEXT PRIMARY KEY);\n' }], dir);
    expect(changed.result).toEqual({ ok: false, error: { code: 'checksum_mismatch', version: 1 } });
  });

  it('只改换行符不算改动', () => {
    const { dir } = open([m1]);
    opened.pop()?.close();
    expect(open([{ ...m1, sql: m1.sql.replace(/\n/g, '\r\n') }], dir).result.ok).toBe(true);
  });

  it('库的版本高于已知的最新迁移时拒绝打开', () => {
    const { dir } = open([m1, m2]);
    opened.pop()?.close();
    expect(open([m1], dir).result).toEqual({ ok: false, error: { code: 'schema_too_new', version: 2, known: 1 } });
  });

  it('迁移失败时回滚，不记录版本，之前的迁移保留', async () => {
    const { dir } = open([m1]);
    opened.pop()?.close();
    const broken: Migration = { version: 2, name: 'broken', sql: 'ALTER TABLE work ADD COLUMN genre TEXT;\nCREATE TABLE oops (;\n' };
    const failed = open([m1, broken], dir);
    expect(failed.result.ok).toBe(false);
    if (!failed.result.ok) expect(failed.result.error).toMatchObject({ code: 'migration_failed', version: 2 });
    const reopened = open([m1], dir);
    if (!reopened.result.ok) throw new Error('无法重新打开');
    const columns = await reopened.result.value.db.query("SELECT name FROM pragma_table_info('work')");
    expect(columns.ok && columns.value.map((r) => r['name'])).toEqual(['id', 'title']);
  });

  it('读取目录中的迁移文件，忽略说明文件', () => {
    const migrations = loadMigrations();
    expect(migrations.every((m) => m.version > 0)).toBe(true);
  });
});

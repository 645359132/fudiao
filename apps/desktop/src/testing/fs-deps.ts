// 测试用的应用依赖：作品列表与文件夹用临时目录，作品库用 Node 的 SqlPort（better-sqlite3）。仅供测试使用。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, ulid, type Result } from '@fudiao/shared';
import type { SqlPort } from '@fudiao/store';
import { loadMigrations, openProjectDb, PROJECT_DB_FILE, type ProjectDb } from '@fudiao/store/node';
import type { AppDeps, BackupInfo, BackupKind, PackageFile } from '../app/ports';

export type TestDeps = AppDeps & {
  readonly root: string;
  readonly libraryFile: string;
  /** 导出与复制的内容，按调用顺序。 */
  readonly exported: { name: string; content: string }[];
  readonly copied: string[];
  /** 下一次“选择导入文件”的结果（文件名与文字）；用完后为取消。 */
  readonly textPicks: ({ fileName: string; text: string } | null)[];
  readonly projectPicks: (PackageFile[] | null)[];
  readonly exportedPackages: { name: string; files: PackageFile[] }[];
  /** 下一次“选择文件夹”的结果；用完后返回 null（取消）。 */
  readonly picks: (string | null)[];
};

export function fsDeps(root = mkdtempSync(join(tmpdir(), 'fudiao-app-'))): TestDeps {
  const libraryFile = join(root, 'appdata', 'library.json');
  const documents = join(root, 'Documents', '复调');
  const picks: (string | null)[] = [];
  const exported: { name: string; content: string }[] = [];
  const copied: string[] = [];
  const draftFile = (dir: string, id: string) => join(dir, 'drafts', `${id}.json`);
  const migrations = loadMigrations();
  let current: ProjectDb | null = null;
  let currentDir = '';
  const textPicks: ({ fileName: string; text: string } | null)[] = [];
  const projectPicks: (PackageFile[] | null)[] = [];
  const exportedPackages: { name: string; files: PackageFile[] }[] = [];
  const tokens = new Map<string, { fileName: string; text: string }>();
  // 与桌面端一样，端口不绑定某一个连接：恢复备份后换了连接，同一个端口照常可用。
  const port: SqlPort = {
    query: (sql, params) => (current === null ? Promise.resolve(err({ code: 'not_open' })) : current.query(sql, params)),
    transaction: (statements) => (current === null ? Promise.resolve(err({ code: 'not_open' })) : current.transaction(statements)),
  };
  const backupDir = () => join(currentDir, 'backups');
  const listBackups = (): BackupInfo[] => {
    if (!existsSync(backupDir())) return [];
    return readdirSync(backupDir())
      .flatMap((name) => {
        const m = /^(auto|manual|pre-restore|pre-migration-v\d+)-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d\.\d{3}Z)\.sqlite$/.exec(name);
        if (m === null) return [];
        const kind = (m[1]?.startsWith('pre-migration') ? 'pre-migration' : m[1]) as BackupKind;
        return [{ name, kind, createdAt: `${m[2]}:${m[3]}:${m[4]}`, sizeBytes: statSync(join(backupDir(), name)).size }];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const createBackup = (kind: BackupKind, now: string): Result<BackupInfo, string> => {
    if (current === null) return err('没有打开作品');
    mkdirSync(backupDir(), { recursive: true });
    const name = `${kind}-${now.replace(/:/g, '-')}.sqlite`;
    current.backupTo(join(backupDir(), name));
    if (kind === 'auto') for (const old of listBackups().filter((b) => b.kind === 'auto').slice(30)) rmSync(join(backupDir(), old.name));
    const info = listBackups().find((b) => b.name === name);
    return info === undefined ? err('备份没有写出') : ok(info);
  };
  let tick = 0;
  let seq = 0;

  return {
    root,
    libraryFile,
    picks,
    exported,
    copied,
    textPicks,
    projectPicks,
    exportedPackages,
    drafts: {
      read: (dir, id) => Promise.resolve(ok(existsSync(draftFile(dir, id)) ? readFileSync(draftFile(dir, id), 'utf8') : null)),
      write: (dir, id, content) => {
        mkdirSync(join(dir, 'drafts'), { recursive: true });
        writeFileSync(draftFile(dir, id), content);
        return Promise.resolve(ok(undefined));
      },
      remove: (dir, id) => {
        rmSync(draftFile(dir, id), { force: true });
        return Promise.resolve(ok(undefined));
      },
    },
    exporter: {
      exportText: (name, content) => {
        exported.push({ name, content });
        return Promise.resolve(ok(true));
      },
      copyText: (content) => {
        copied.push(content);
        return Promise.resolve(ok(undefined));
      },
    },
    library: {
      read: () => Promise.resolve(ok(existsSync(libraryFile) ? readFileSync(libraryFile, 'utf8') : null)),
      write: (content) => {
        mkdirSync(join(root, 'appdata'), { recursive: true });
        writeFileSync(libraryFile, content);
        return Promise.resolve(ok(undefined));
      },
      defaultDir: () => Promise.resolve(ok(documents)),
      probe: (dir) =>
        Promise.resolve({
          exists: existsSync(dir),
          isDir: existsSync(dir) && statSync(dir).isDirectory(),
          hasProject: existsSync(join(dir, PROJECT_DB_FILE)),
        }),
      pickFolder: () => Promise.resolve(picks.shift() ?? null),
    },
    opener: {
      open(dir, now) {
        current?.close();
        current = null;
        const opened = openProjectDb(dir, { migrations, now });
        if (!opened.ok) return Promise.resolve(opened);
        current = opened.value.db;
        currentDir = dir;
        return Promise.resolve(ok({ port, report: opened.value.report }));
      },
      close() {
        current?.close();
        current = null;
        return Promise.resolve();
      },
    },
    transfer: {
      pickText: () => {
        const next = textPicks.shift();
        if (next === undefined || next === null) return Promise.resolve(ok(null));
        const token = String(seq++);
        tokens.set(token, next);
        return Promise.resolve(ok({ token, fileName: next.fileName, encoding: 'UTF-8', text: next.text, hadErrors: false }));
      },
      redecode: (token, encoding) => {
        const file = tokens.get(token);
        if (file === undefined) return Promise.resolve(err('导入文件已释放，请重新选择'));
        return Promise.resolve(ok({ token, fileName: file.fileName, encoding, text: file.text, hadErrors: encoding !== 'UTF-8' }));
      },
      release: (token) => {
        tokens.delete(token);
        return Promise.resolve();
      },
      exportProject: (name, files) => {
        exportedPackages.push({ name, files: [...files] });
        return Promise.resolve(ok(true));
      },
      pickProject: () => Promise.resolve(ok(projectPicks.shift() ?? null)),
    },
    backups: {
      list: () => Promise.resolve(ok(listBackups())),
      create: (kind, now) => Promise.resolve(createBackup(kind, now)),
      restore(name, now) {
        if (current === null) return Promise.resolve(err('没有打开作品'));
        const source = join(currentDir, 'backups', name);
        if (!existsSync(source) || name.includes('/') || name.includes('\\')) return Promise.resolve(err(`找不到备份：${name}`));
        const saved = createBackup('pre-restore', now);
        if (!saved.ok) return Promise.resolve(saved);
        current.close();
        current = null;
        for (const suffix of ['-wal', '-shm']) rmSync(join(currentDir, `${PROJECT_DB_FILE}${suffix}`), { force: true });
        copyFileSync(source, join(currentDir, PROJECT_DB_FILE));
        const reopened = openProjectDb(currentDir, { migrations, now });
        if (!reopened.ok) return Promise.resolve(err(reopened.error.code));
        current = reopened.value.db;
        return Promise.resolve(saved);
      },
    },
    clock: { now: () => new Date(Date.UTC(2026, 9, 7, 0, 0, tick++)).toISOString() },
    ids: { next: () => ulid(1_790_000_000_000 + seq, new Uint8Array(10).fill(seq++ % 256)) },
  };
}

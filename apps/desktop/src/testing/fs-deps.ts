// 测试用的应用依赖：作品列表与文件夹用临时目录，作品库用 Node 的 SqlPort（better-sqlite3）。仅供测试使用。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, ulid } from '@fudiao/shared';
import { loadMigrations, openProjectDb, PROJECT_DB_FILE, type ProjectDb } from '@fudiao/store/node';
import type { AppDeps } from '../app/ports';

export type TestDeps = AppDeps & {
  readonly root: string;
  readonly libraryFile: string;
  /** 导出与复制的内容，按调用顺序。 */
  readonly exported: { name: string; content: string }[];
  readonly copied: string[];
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
  let tick = 0;
  let seq = 0;

  return {
    root,
    libraryFile,
    picks,
    exported,
    copied,
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
        return Promise.resolve(ok({ port: opened.value.db, report: opened.value.report }));
      },
      close() {
        current?.close();
        current = null;
        return Promise.resolve();
      },
    },
    clock: { now: () => new Date(Date.UTC(2026, 9, 7, 0, 0, tick++)).toISOString() },
    ids: { next: () => ulid(1_790_000_000_000 + seq, new Uint8Array(10).fill(seq++ % 256)) },
  };
}

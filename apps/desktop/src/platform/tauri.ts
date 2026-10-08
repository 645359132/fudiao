// 应用依赖的桌面实现：经 Tauri 命令访问作品列表、作品文件夹与作品库。
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { err, ok, ulid, type Result } from '@fudiao/shared';
import { closeProjectDb, openProjectDb, tauriSqlPort } from '../adapters/tauri-sql';
import type { AppDeps, Probe } from '../app/ports';

/** Rust 命令失败时以 `{ code, detail }` 拒绝；转为给作者看的说明。 */
async function call<T>(promise: Promise<T>): Promise<Result<T, string>> {
  try {
    return ok(await promise);
  } catch (e) {
    const detail = (e as { detail?: unknown }).detail;
    return err(typeof detail === 'string' ? detail : e instanceof Error ? e.message : String(e));
  }
}

export function tauriDeps(): AppDeps {
  return {
    library: {
      read: () => call(invoke<string | null>('library_read')),
      write: (content) => call(invoke<void>('library_write', { content })),
      defaultDir: () => call(invoke<string>('library_default_dir')),
      probe: (dir) => invoke<Probe>('project_probe', { dir }),
      async pickFolder(title) {
        const picked = await open({ directory: true, multiple: false, title });
        return typeof picked === 'string' ? picked : null;
      },
    },
    opener: {
      async open(dir, now) {
        const report = await openProjectDb(invoke, dir, now);
        return report.ok ? ok({ port: tauriSqlPort(invoke), report: report.value }) : report;
      },
      close: () => closeProjectDb(invoke),
    },
    clock: { now: () => new Date().toISOString() },
    ids: { next: () => ulid(Date.now(), crypto.getRandomValues(new Uint8Array(10))) },
  };
}

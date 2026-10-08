// 应用依赖的桌面实现：经 Tauri 命令访问作品列表、作品文件夹与作品库。
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { err, ok, ulid, type Result } from '@fudiao/shared';
import { closeProjectDb, openProjectDb, tauriSqlPort } from '../adapters/tauri-sql';
import type { AppDeps, BackupInfo, DecodedText, PackageFile, Probe } from '../app/ports';

/** Rust 命令失败时以 `{ code, detail }` 拒绝；转为给作者看的说明。 */
async function call<T>(promise: Promise<T>): Promise<Result<T, string>> {
  try {
    return ok(await promise);
  } catch (e) {
    // 没有说明的错误（例如没有打开作品）退而显示错误码。
    const { detail, code } = e as { detail?: unknown; code?: unknown };
    return err(typeof detail === 'string' ? detail : typeof code === 'string' ? code : e instanceof Error ? e.message : String(e));
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
    drafts: {
      read: (projectDir, chapterId) => call(invoke<string | null>('draft_read', { projectDir, chapterId })),
      write: (projectDir, chapterId, content) => call(invoke<void>('draft_write', { projectDir, chapterId, content })),
      remove: (projectDir, chapterId) => call(invoke<void>('draft_delete', { projectDir, chapterId })),
    },
    exporter: {
      exportText: (suggestedName, content, kind = 'txt') => call(invoke<boolean>('export_text', { suggestedName, content, kind })),
      copyText: (content) => call(navigator.clipboard.writeText(content)),
    },
    transfer: {
      pickText: () => call(invoke<DecodedText | null>('import_pick_text')),
      redecode: (token, encoding) => call(invoke<DecodedText>('import_redecode', { token, encoding })),
      release: (token) => invoke<void>('import_release', { token }),
      exportProject: (suggestedName, files) => call(invoke<boolean>('export_project', { suggestedName, files })),
      pickProject: () => call(invoke<PackageFile[] | null>('import_pick_project')),
    },
    backups: {
      list: () => call(invoke<BackupInfo[]>('backup_list')),
      create: (kind, now) => call(invoke<BackupInfo>('backup_create', { kind, now })),
      async restore(name, now) {
        // Rust 返回 [重新打开的报告, 恢复前备份]。
        const result = await call(invoke<[unknown, BackupInfo]>('backup_restore', { name, now }));
        return result.ok ? ok(result.value[1]) : result;
      },
    },
    clock: { now: () => new Date().toISOString() },
    ids: { next: () => ulid(Date.now(), crypto.getRandomValues(new Uint8Array(10))) },
  };
}

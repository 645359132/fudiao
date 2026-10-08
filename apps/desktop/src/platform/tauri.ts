// 应用依赖的桌面实现：经 Tauri 命令访问作品列表、作品文件夹与作品库。
import { Channel, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { err, ok, ulid, type Result } from '@fudiao/shared';
import { createProxyFetch, type NetEvent } from '@fudiao/llm';
import { tauriNet } from '../adapters/tauri-net';
import { closeProjectDb, openAppDb, openProjectDb, tauriSqlPort } from '../adapters/tauri-sql';
import { buildAdapter } from '../app/model-services';
import type { AppDeps, BackupInfo, CredentialStatus, DecodedText, PackageFile, Probe } from '../app/ports';

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

/**
 * 某个模型服务的 fetch：经 Rust 凭据代理转发，交给适配器的 SDK（API Key 填 PLACEHOLDER_API_KEY）。
 * 服务与凭据在 M2-02 配置；之前所有请求都会被代理拒绝为 unknown_provider。
 */
export function providerFetch(providerId: string): typeof fetch {
  const net = tauriNet(invoke, () => new Channel<NetEvent>());
  return createProxyFetch(net, providerId, () => ulid(Date.now(), crypto.getRandomValues(new Uint8Array(10))));
}

/** Rust 的 CredentialError 转为错误码（应用层的 describeCredentialError 给出说明）。 */
async function credential<T>(promise: Promise<T>): Promise<Result<T, string>> {
  try {
    return ok(await promise);
  } catch (e) {
    const { code, reason, detail } = e as { code?: unknown; reason?: { code?: unknown }; detail?: unknown };
    if (code === 'invalid' && typeof reason?.code === 'string') return err(reason.code);
    if (code === 'store') return err(`store:${typeof detail === 'string' ? detail : ''}`);
    return err(typeof code === 'string' ? code : String(e));
  }
}

export function tauriDeps(): AppDeps {
  return {
    settingsDb: {
      async open(now) {
        const opened = await openAppDb(invoke, now);
        return opened.ok ? ok(tauriSqlPort(invoke, 'app_db')) : err(opened.error.code === 'io_error' ? opened.error.detail : opened.error.code);
      },
    },
    credentials: {
      set: (providerId, baseUrl, keyHeader, secret) => credential(invoke<CredentialStatus>('credential_set', { providerId, baseUrl, keyHeader, secret })),
      status: (providerId) => credential(invoke<CredentialStatus>('credential_status', { providerId })),
      remove: (providerId) => credential(invoke<void>('credential_delete', { providerId })),
      setLimits: (limits) => invoke<void>('net_set_limits', { limits }),
    },
    llm: { forProvider: (provider) => buildAdapter(provider, providerFetch(provider.id)) },
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

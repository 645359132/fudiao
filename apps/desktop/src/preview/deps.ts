// 浏览器预览的平台实现：一切都在内存里（作品库是 sql.js 的内存数据库），选择文件的对话框都当作取消。
// 模型是演示用的，按任务给出固定的回复（见 demo-llm.ts）。只在开发时用。
import { err, ok, ulid } from '@fudiao/shared';
import type { SqlJsStatic } from 'sql.js';
import type { AppDeps, CredentialStatus } from '../app/ports';
import { demoLlm } from './demo-llm';
import { latestVersion, openProject, openSettings, sqljsPort } from './sqljs';

export function previewDeps(SQL: SqlJsStatic): AppDeps {
  let library: string | null = null;
  const projects = new Map<string, ReturnType<typeof sqljsPort>>();
  const drafts = new Map<string, string>();
  const credentials = new Map<string, CredentialStatus>();
  const settings = sqljsPort(openSettings(SQL));
  return {
    library: {
      read: () => Promise.resolve(ok(library)),
      write: (content) => {
        library = content;
        return Promise.resolve(ok(undefined));
      },
      defaultDir: () => Promise.resolve(ok('预览\\复调')),
      probe: (dir) => Promise.resolve({ exists: projects.has(dir), isDir: projects.has(dir), hasProject: projects.has(dir) }),
      pickFolder: () => Promise.resolve(null),
    },
    opener: {
      open(dir) {
        let port = projects.get(dir);
        if (port === undefined) {
          port = sqljsPort(openProject(SQL));
          projects.set(dir, port);
        }
        return Promise.resolve(ok({ port, report: { schemaVersion: latestVersion, applied: [], backup: null } }));
      },
      close: () => Promise.resolve(),
    },
    drafts: {
      read: (dir, chapterId) => Promise.resolve(ok(drafts.get(`${dir}:${chapterId}`) ?? null)),
      write: (dir, chapterId, content) => {
        drafts.set(`${dir}:${chapterId}`, content);
        return Promise.resolve(ok(undefined));
      },
      remove: (dir, chapterId) => {
        drafts.delete(`${dir}:${chapterId}`);
        return Promise.resolve(ok(undefined));
      },
    },
    exporter: {
      exportText: (name, content) => {
        console.info(`[预览] 导出 ${name}（${content.length} 字）`);
        return Promise.resolve(ok(true));
      },
      copyText: () => Promise.resolve(ok(undefined)),
    },
    transfer: {
      pickText: () => Promise.resolve(ok(null)),
      redecode: () => Promise.resolve(err('预览中不能导入文件')),
      release: () => Promise.resolve(),
      exportProject: () => Promise.resolve(ok(true)),
      pickProject: () => Promise.resolve(ok(null)),
    },
    backups: {
      list: () => Promise.resolve(ok([])),
      create: (kind, now) => Promise.resolve(ok({ name: `${kind}-${now}.sqlite`, kind, createdAt: now, sizeBytes: 0 })),
      restore: () => Promise.resolve(err('预览中没有备份')),
    },
    settingsDb: { open: () => Promise.resolve(ok(settings)) },
    credentials: {
      set(providerId, baseUrl, keyHeader, secret) {
        const status: CredentialStatus = { stored: true, origin: new URL(baseUrl).origin, hasSecret: keyHeader !== null && secret !== null };
        credentials.set(providerId, status);
        return Promise.resolve(ok(status));
      },
      status: (providerId) => Promise.resolve(ok(credentials.get(providerId) ?? { stored: false, origin: null, hasSecret: false })),
      remove: (providerId) => {
        credentials.delete(providerId);
        return Promise.resolve(ok(undefined));
      },
      setLimits: () => Promise.resolve(),
    },
    llm: { forProvider: () => demoLlm() },
    clock: { now: () => new Date().toISOString() },
    ids: { next: () => ulid(Date.now(), crypto.getRandomValues(new Uint8Array(10))) },
  };
}

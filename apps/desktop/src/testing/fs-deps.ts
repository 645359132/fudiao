// 测试用的应用依赖：作品列表与文件夹用临时目录，作品库用 Node 的 SqlPort（better-sqlite3）。供测试使用；
// M3 评估（tools/m3-eval）在本机手动运行时也用它，换上真实的网络请求与时钟。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, ulid, type Result } from '@fudiao/shared';
import { createProxyFetch, type NetTransport, type RetryPolicy } from '@fudiao/llm';
import { fakeFetch, fakeNet, type FakeResponse } from '@fudiao/llm/testing';
import type { SqlPort, Statement } from '@fudiao/store';
import { APP_DB_FILE, appMigrationsDir, loadMigrations, openProjectDb, PROJECT_DB_FILE, type ProjectDb } from '@fudiao/store/node';
import { buildAdapter } from '../app/model-services';
import type { AppDeps, BackupInfo, BackupKind, KeyHeader, PackageFile, WebPage } from '../app/ports';

/** 模拟系统凭据管理器中的条目（Rust 的 credentials.rs）。 */
type StoredSecret = { readonly origin: string; readonly header: KeyHeader | null; readonly secret: string | null };

const isLoopback = (url: URL) => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);

/** 与 Rust 的 Binding::new 相同的规则：需要密钥的服务必须是 https，本地端点只允许回环地址。 */
function bindOrigin(baseUrl: string, header: KeyHeader | null): Result<string, string> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return err('invalid_request');
  }
  if (header === null && !isLoopback(url)) return err('host_not_allowed');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) return err('insecure_scheme');
  return ok(url.origin);
}

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
  /** 凭据管理器中的条目（测试检查密钥只在这里）。 */
  readonly secrets: Map<string, StoredSecret>;
  /** 模型服务的预设响应，按调用顺序取用；用完后为网络错误。 */
  readonly llmResponses: FakeResponse[];
  /** 依次对应之后的模型请求：不为 null 时先执行它再给出响应（模拟模型生成期间作者在界面上的操作）。 */
  readonly beforeLlm: ((() => Promise<void>) | null)[];
  /** 到达“模型服务”的请求（经模拟的凭据代理注入凭据之后）。 */
  readonly llmRequests: { url: string; headers: Record<string, string>; body: unknown }[];
  /**
   * 按请求的内容回复（同时发出的几个请求谁先到不一定，排好的队列对不上时用它）：收到请求体的文字，返回这次的回复；
   * 返回 null 时照旧取排好的下一个。
   */
  readonly llmRoute: { current: ((body: string) => Promise<FakeResponse | null> | FakeResponse | null) | null };
  /** 搜索服务（B84）的预设响应与到达的请求；读网页的预设页面（按网址）。 */
  readonly searchResponses: FakeResponse[];
  readonly searchRequests: { url: string; headers: Record<string, string>; body: unknown }[];
  readonly webPages: Map<string, WebPage>;
  /** 作品库写入的故障注入：下一个有语句匹配的事务以 sql_error 失败（用完即去掉），模拟写到一半出错。 */
  readonly sqlFaults: RegExp[];
  /** 多个窗口：开新窗口的请求（作品或 null 为作品列表），与这个窗口启动时要打开的作品。 */
  readonly windowOpens: ({ readonly id: string; readonly path: string } | null)[];
  readonly pendingWindow: { current: string | null };
  /** 在“别的窗口”里开着的作品文件夹（打开它们时应切过去，不关掉手上的作品）。 */
  readonly heldElsewhere: Set<string>;
  readonly limits: (readonly (readonly [string, number])[])[];
  dispose(): Promise<void>;
};

export type FsDepsOptions = {
  /** 到达模型服务的请求改用这个函数发出（M3 评估用真实的 fetch）；不给时取预设的响应。 */
  readonly fetch?: typeof fetch;
  /** 用真实的时间与随机的标识；默认是确定的时钟与标识，测试结果可以复现。 */
  readonly realTime?: boolean;
  /** 失败调用的重试。预设响应时默认不重试（否则排好的回复会被重试用掉）；用真实的 fetch 时默认与桌面端相同。 */
  readonly retry?: RetryPolicy;
};

export function fsDeps(root = mkdtempSync(join(tmpdir(), 'fudiao-app-')), options: FsDepsOptions = {}): TestDeps {
  const retryPolicy: RetryPolicy | undefined = options.retry ?? (options.fetch === undefined ? { delaysMs: [] } : undefined);
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
  const secrets = new Map<string, StoredSecret>();
  const llmResponses: FakeResponse[] = [];
  const llmRequests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const beforeLlm: ((() => Promise<void>) | null)[] = [];
  const limits: (readonly (readonly [string, number])[])[] = [];
  const searchResponses: FakeResponse[] = [];
  const searchRequests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const webPages = new Map<string, WebPage>();
  let settings: ProjectDb | null = null;
  // 模型服务：每次请求取下一个预设响应，并记下到达服务的请求。
  const llmRoute: TestDeps['llmRoute'] = { current: null };
  const service = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (options.fetch !== undefined) return options.fetch(input, init);
    const routed = llmRoute.current === null ? null : await llmRoute.current(typeof init?.body === 'string' ? init.body : '');
    if (routed !== null) {
      const { fetch, requests } = fakeFetch([routed]);
      const response = fetch(input, init);
      llmRequests.push(...requests);
      return response;
    }
    await beforeLlm.shift()?.();
    const { fetch, requests } = fakeFetch([llmResponses.shift() ?? { networkError: true }]);
    const response = fetch(input, init);
    llmRequests.push(...requests);
    return response;
  };
  // 搜索服务（B84）：同样取预设响应、记下请求。
  const searchService = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { fetch, requests } = fakeFetch([searchResponses.shift() ?? { networkError: true }]);
    const response = fetch(input, init);
    searchRequests.push(...requests);
    return response;
  };
  // 模拟凭据代理：没有凭据或目标不是绑定的源时拒绝；替换占位的认证头。
  const proxyOver = (target: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): NetTransport => {
    const inner = fakeNet(target);
    let n = 0;
    return {
      send(request, onEvent) {
        const stored = secrets.get(request.providerId);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 与 Tauri 的 invoke 一样以错误对象拒绝
        if (stored === undefined) return Promise.reject({ code: 'unknown_provider' });
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 同上
        if (new URL(request.url).origin !== stored.origin) return Promise.reject({ code: 'host_not_allowed' });
        const headers = request.headers.filter(([k]) => !['authorization', 'x-api-key', 'x-subscription-token'].includes(k.toLowerCase()));
        if (stored.header === 'x_api_key' && stored.secret !== null) headers.push(['x-api-key', stored.secret]);
        if (stored.header === 'bearer' && stored.secret !== null) headers.push(['authorization', `Bearer ${stored.secret}`]);
        if (stored.header === 'x_subscription_token' && stored.secret !== null) headers.push(['x-subscription-token', stored.secret]);
        return inner.send({ ...request, id: `${request.id}-${++n}`, headers }, onEvent);
      },
      cancel: (id) => inner.cancel(id),
    };
  };
  const proxy = proxyOver(service);
  const searchProxy = proxyOver(searchService);
  // 与桌面端一样，端口不绑定某一个连接：恢复备份后换了连接，同一个端口照常可用。
  const sqlFaults: RegExp[] = [];
  const windowOpens: TestDeps['windowOpens'] = [];
  const pendingWindow: TestDeps['pendingWindow'] = { current: null };
  const heldElsewhere = new Set<string>();
  const port: SqlPort = {
    query: (sql, params) => (current === null ? Promise.resolve(err({ code: 'not_open' })) : current.query(sql, params)),
    read: (queries) => (current === null ? Promise.resolve(err({ code: 'not_open' })) : current.read(queries)),
    transaction: (statements: readonly Statement[]) => {
      if (current === null) return Promise.resolve(err({ code: 'not_open' }));
      const fault = sqlFaults[0];
      const hit = fault === undefined ? -1 : statements.findIndex((s) => fault.test(s.sql));
      if (fault !== undefined && hit >= 0) {
        sqlFaults.shift();
        return Promise.resolve(err({ code: 'sql_error', index: hit, detail: '测试注入的写入故障' }));
      }
      return current.transaction(statements);
    },
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
    secrets,
    llmResponses,
    beforeLlm,
    llmRequests,
    llmRoute,
    searchResponses,
    searchRequests,
    webPages,
    sqlFaults,
    windowOpens,
    pendingWindow,
    heldElsewhere,
    limits,
    // 测试结束时关闭作品库与设置库，临时目录才能删除。
    async dispose() {
      await this.opener.close();
      settings?.close();
      settings = null;
    },
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
      replace: (expected, content) => {
        const now = existsSync(libraryFile) ? readFileSync(libraryFile, 'utf8') : null;
        if (now !== expected) return Promise.resolve(ok(false));
        mkdirSync(join(root, 'appdata'), { recursive: true });
        writeFileSync(libraryFile, content);
        return Promise.resolve(ok(true));
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
      heldElsewhere: (dir) => Promise.resolve(heldElsewhere.has(dir)),
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
    settingsDb: {
      open(now) {
        if (settings !== null) return Promise.resolve(ok(settings));
        const opened = openProjectDb(join(root, 'appdata'), { migrations: loadMigrations(appMigrationsDir), now, file: APP_DB_FILE });
        if (!opened.ok) return Promise.resolve(err(opened.error.code));
        settings = opened.value.db;
        return Promise.resolve(ok(settings));
      },
    },
    credentials: {
      set(providerId, baseUrl, header, secret) {
        if (header !== null && (secret === null || secret.trim() === '')) return Promise.resolve(err('missing_secret'));
        const origin = bindOrigin(baseUrl, header);
        if (!origin.ok) return Promise.resolve(origin);
        const stored = { origin: origin.value, header, secret: header === null ? null : (secret?.trim() ?? null) };
        secrets.set(providerId, stored);
        return Promise.resolve(ok({ stored: true, origin: stored.origin, hasSecret: stored.secret !== null }));
      },
      status(providerId) {
        const s = secrets.get(providerId);
        return Promise.resolve(ok({ stored: s !== undefined, origin: s?.origin ?? null, hasSecret: s?.secret !== undefined && s.secret !== null }));
      },
      remove(providerId) {
        secrets.delete(providerId);
        return Promise.resolve(ok(undefined));
      },
      setLimits(list) {
        limits.push(list);
        return Promise.resolve();
      },
    },
    llm: { forProvider: (provider) => buildAdapter(provider, createProxyFetch(proxy, provider.id, () => 'req')) },
    web: {
      searchFetch: (serviceId) => createProxyFetch(searchProxy, serviceId, () => 'search'),
      readPage: (url) => {
        // 与 Rust 的读取器一样：本机地址不读；其余按预设页面，没有的当作 404。
        const host = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return null;
          }
        })();
        if (host === null) return Promise.resolve(err('invalid_url:网址无效'));
        if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) return Promise.resolve(err(`host_not_allowed:${host}`));
        const page = webPages.get(url);
        return Promise.resolve(page === undefined ? err('status:404') : ok(page));
      },
    },
    ...(retryPolicy !== undefined && { retry: retryPolicy }),
    windows: {
      open(work) {
        windowOpens.push(work);
        return Promise.resolve(ok(undefined));
      },
      takeOpen() {
        const id = pendingWindow.current;
        pendingWindow.current = null;
        return Promise.resolve(id);
      },
    },
    // jsdom 与 Node 没有 canvas：封面原样编码，缩略图取前一段，尺寸固定为 600×800。
    images: {
      async prepareCover(file) {
        if (!file.type.startsWith('image/')) return err('请选一张图片（JPG、PNG 或 WebP）');
        const base64 = Buffer.from(await file.arrayBuffer()).toString('base64') || 'AA==';
        return ok({ image: `data:${file.type};base64,${base64}`, thumbnail: `data:${file.type};base64,${base64.slice(0, 8)}`, width: 600, height: 800 });
      },
    },
    clock: { now: () => (options.realTime === true ? new Date().toISOString() : new Date(Date.UTC(2026, 9, 7, 0, 0, tick++)).toISOString()) },
    ids: {
      next: () =>
        options.realTime === true ? ulid(Date.now(), crypto.getRandomValues(new Uint8Array(10))) : ulid(1_790_000_000_000 + seq, new Uint8Array(10).fill(seq++ % 256)),
    },
  };
}

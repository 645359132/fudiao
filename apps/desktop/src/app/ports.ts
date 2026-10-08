import type { Result } from '@fudiao/shared';
import type { LlmPort } from '@fudiao/llm';
import type { OpenError, OpenReport, Provider, SqlPort } from '@fudiao/store';

/** 文件夹探测结果（Rust 命令 `project_probe`）。 */
export type Probe = { readonly exists: boolean; readonly isDir: boolean; readonly hasProject: boolean };

/** 作品列表文件与作品文件夹。桌面实现经 Rust 命令与对话框插件，测试用文件系统上的实现。 */
export interface LibraryPort {
  /** 读取 library.json；文件不存在时为 null。 */
  read(): Promise<Result<string | null, string>>;
  write(content: string): Promise<Result<void, string>>;
  /** 默认作品库：文档\复调。 */
  defaultDir(): Promise<Result<string, string>>;
  probe(dir: string): Promise<Probe>;
  /** 让作者选择一个文件夹；取消时为 null。 */
  pickFolder(title: string): Promise<string | null>;
}

/** 打开作品库（桌面端为 Rust 命令 `db_open`），同一时间只打开一部作品。 */
export interface ProjectOpener {
  open(dir: string, now: string): Promise<Result<{ readonly port: SqlPort; readonly report: OpenReport }, OpenError>>;
  close(): Promise<void>;
}

/** 未保存编辑的草稿：作品文件夹下 drafts/<章节标识>.json（Rust 命令）。 */
export interface DraftPort {
  read(projectDir: string, chapterId: string): Promise<Result<string | null, string>>;
  write(projectDir: string, chapterId: string, content: string): Promise<Result<void, string>>;
  remove(projectDir: string, chapterId: string): Promise<Result<void, string>>;
}

/** 导出正文（保存对话框由 Rust 弹出）、复制到剪贴板。 */
export interface ExportPort {
  /** 返回是否已保存；作者取消时为 false。 */
  exportText(suggestedName: string, content: string, kind?: 'txt' | 'md'): Promise<Result<boolean, string>>;
  copyText(content: string): Promise<Result<void, string>>;
}

/** 选中的导入文件，按识别出的编码解码后的文字（Rust 命令 `import_pick_text`）。 */
export type DecodedText = {
  readonly token: string;
  readonly fileName: string;
  readonly encoding: string;
  readonly text: string;
  /** 有无法按该编码解码的字节，提示作者换一种编码。 */
  readonly hadErrors: boolean;
};

export type PackageFile = { readonly path: string; readonly content: string };

/** 导入文件与作品包。文件只经 Rust 弹出的对话框选择，界面拿不到路径。 */
export interface TransferPort {
  pickText(): Promise<Result<DecodedText | null, string>>;
  redecode(token: string, encoding: string): Promise<Result<DecodedText, string>>;
  release(token: string): Promise<void>;
  exportProject(suggestedName: string, files: readonly PackageFile[]): Promise<Result<boolean, string>>;
  pickProject(): Promise<Result<readonly PackageFile[] | null, string>>;
}

export type BackupKind = 'auto' | 'manual' | 'pre-restore' | 'pre-migration';
export type BackupInfo = { readonly name: string; readonly kind: BackupKind; readonly createdAt: string; readonly sizeBytes: number };

/** 当前打开的作品库的备份（Rust 命令 `backup_*`）。 */
export interface BackupPort {
  list(): Promise<Result<readonly BackupInfo[], string>>;
  create(kind: 'auto' | 'manual', now: string): Promise<Result<BackupInfo, string>>;
  /** 恢复到备份；返回恢复前自动保存的现稿备份。 */
  restore(name: string, now: string): Promise<Result<BackupInfo, string>>;
}

/** 应用设置库 app.sqlite（Rust 命令 `app_db_open`、`app_db_query`、`app_db_tx`），位于应用数据目录。 */
export interface SettingsDbPort {
  open(now: string): Promise<Result<SqlPort, string>>;
}

/** 认证头的写法：Anthropic 用 x-api-key，其余用 Authorization: Bearer；null 表示本地端点，不需要密钥。 */
export type KeyHeader = 'x_api_key' | 'bearer';

/** 凭据在系统凭据管理器中的状态；明文从不返回。 */
export type CredentialStatus = { readonly stored: boolean; readonly origin: string | null; readonly hasSecret: boolean };

/** 凭据（Rust 命令 `credential_*`）与凭据代理的并发上限（`net_set_limits`）。 */
export interface CredentialPort {
  /** 保存凭据并与服务地址的源绑定；更改地址须重新给出密钥。 */
  set(providerId: string, baseUrl: string, keyHeader: KeyHeader | null, secret: string | null): Promise<Result<CredentialStatus, string>>;
  status(providerId: string): Promise<Result<CredentialStatus, string>>;
  remove(providerId: string): Promise<Result<void, string>>;
  setLimits(limits: readonly (readonly [string, number])[]): Promise<void>;
}

/** 为一个服务建立模型端口：桌面端经凭据代理转发，测试中用不联网的 fetch。 */
export interface LlmFactory {
  forProvider(provider: Provider): LlmPort;
}

export interface Clock {
  /** UTC ISO 字符串。 */
  now(): string;
}

export interface Ids {
  /** 新的 ULID。 */
  next(): string;
}

export type AppDeps = {
  readonly library: LibraryPort;
  readonly opener: ProjectOpener;
  readonly drafts: DraftPort;
  readonly exporter: ExportPort;
  readonly transfer: TransferPort;
  readonly backups: BackupPort;
  readonly settingsDb: SettingsDbPort;
  readonly credentials: CredentialPort;
  readonly llm: LlmFactory;
  readonly clock: Clock;
  readonly ids: Ids;
};

import type { Result } from '@fudiao/shared';
import type { OpenError, OpenReport, SqlPort } from '@fudiao/store';

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
  readonly clock: Clock;
  readonly ids: Ids;
};

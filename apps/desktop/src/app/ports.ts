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
  readonly clock: Clock;
  readonly ids: Ids;
};

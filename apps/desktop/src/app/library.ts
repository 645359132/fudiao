import { z } from 'zod';

/** 作品列表中的一项。标题是缓存，以作品库中的 project.title 为准。 */
export const WorkEntry = z.object({
  /** 作品库中 project.id。 */
  id: z.string(),
  path: z.string(),
  title: z.string(),
  archived: z.boolean(),
  lastOpenedAt: z.string().nullable(),
});
export type WorkEntry = z.infer<typeof WorkEntry>;

/** 对所有作品生效的偏好。新增字段一律带默认值，旧文件不必迁移。 */
export const Preferences = z.object({
  /** 正文左侧的段落来源色条（需求 B33）。 */
  showParagraphSource: z.boolean().default(true),
});
export type Preferences = z.infer<typeof Preferences>;
export const DEFAULT_PREFERENCES: Preferences = { showParagraphSource: true };

/** 应用数据目录下的 library.json。 */
export const LibraryFile = z.object({
  version: z.literal(1),
  /** 新建作品的位置；null 时用默认作品库（文档\复调）。 */
  libraryDir: z.string().nullable(),
  works: z.array(WorkEntry),
  preferences: Preferences.default(DEFAULT_PREFERENCES),
});
export type LibraryFile = z.infer<typeof LibraryFile>;

export const EMPTY_LIBRARY: LibraryFile = { version: 1, libraryDir: null, works: [], preferences: DEFAULT_PREFERENCES };

/** 列表显示顺序：最近打开的在前，从未打开的按标题。 */
export function sortWorks(works: readonly WorkEntry[]): WorkEntry[] {
  return [...works].sort((a, b) => {
    if (a.lastOpenedAt !== b.lastOpenedAt) return (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '');
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 作品标题转为文件夹名：去掉 Windows 不允许的字符与结尾的点和空格，避开保留名。 */
export function folderName(title: string): string {
  const cleaned = Array.from(title)
    .filter((c) => c.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(c))
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  if (cleaned === '') return '未命名作品';
  return RESERVED.test(cleaned) ? `${cleaned}_` : cleaned;
}

/** 按目录已有的分隔符拼接路径（Rust 返回的 Windows 路径用反斜杠）。 */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** 比较路径时忽略分隔符、结尾分隔符与大小写（Windows 路径不区分大小写）。 */
export const samePath = (a: string, b: string): boolean =>
  a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();

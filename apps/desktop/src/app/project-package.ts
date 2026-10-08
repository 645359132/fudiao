// 作品包（施工文档第四章“完整项目导出”）：manifest.json、每章一个 Markdown（供人阅读）、data/ 下每张表一个 JSONL（供导回）。
// zip 的打包与读取在 Rust（transfer.rs）；这里只决定包里有哪些文件、内容是什么。
import { err, ok, type Result } from '@fudiao/shared';
import {
  exportData,
  fromJsonl,
  listChapters,
  listParagraphs,
  TABLES,
  toJsonl,
  type ExportedData,
  type ExportedRow,
  type SqlPort,
} from '@fudiao/store';
import { z } from 'zod';
import { folderName } from './library';

export type PackFile = { readonly path: string; readonly content: string };

export const PACKAGE_FORMAT = 'fudiao-project';
export const PACKAGE_FORMAT_VERSION = 1;

export const Manifest = z.object({
  format: z.literal(PACKAGE_FORMAT),
  formatVersion: z.number().int().positive(),
  /** 作品库结构版本（schema_migrations 的最新版本）。 */
  schemaVersion: z.number().int().nonnegative(),
  exportedAt: z.string(),
  title: z.string(),
  chapters: z.number().int().nonnegative(),
});
export type Manifest = z.infer<typeof Manifest>;

/** 一章正文的 Markdown：标题加段落。 */
export const chapterMarkdown = (title: string, paragraphs: readonly string[]): string =>
  `# ${title}\n\n${paragraphs.map((p) => `${p}\n\n`).join('')}`;

export async function buildPackage(port: SqlPort, exportedAt: string): Promise<Result<PackFile[], string>> {
  const data = await exportData(port);
  if (!data.ok) return err(`读取作品库失败：${data.error.code}`);
  const chapters = await listChapters(port, 'normal');
  if (!chapters.ok) return err('读取章节失败');
  const rawTitle = data.value.tables['project']?.[0]?.['title'];
  const title = typeof rawTitle === 'string' ? rawTitle : '作品';

  const files: PackFile[] = [];
  const manifest: Manifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    schemaVersion: data.value.schemaVersion,
    exportedAt,
    title,
    chapters: chapters.value.length,
  };
  files.push({ path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
  for (const [i, chapter] of chapters.value.entries()) {
    const paragraphs = await listParagraphs(port, chapter.id);
    if (!paragraphs.ok) return err('读取正文失败');
    files.push({
      path: `chapters/${String(i + 1).padStart(4, '0')}-${folderName(chapter.title)}.md`,
      content: chapterMarkdown(chapter.title, paragraphs.value.map((p) => p.text)),
    });
  }
  for (const t of TABLES) files.push({ path: `data/${t.name}.jsonl`, content: toJsonl(data.value.tables[t.name] ?? []) });
  return ok(files);
}

export type ParsedPackage = { readonly manifest: Manifest; readonly data: ExportedData };

/** 读取作品包的文件：校验 manifest 与格式版本，解析每张表。导回由 importData 完成。 */
export function parsePackage(files: readonly PackFile[]): Result<ParsedPackage, string> {
  const manifestFile = files.find((f) => f.path === 'manifest.json');
  if (manifestFile === undefined) return err('作品包缺少 manifest.json');
  let manifest: Manifest;
  try {
    const parsed = Manifest.safeParse(JSON.parse(manifestFile.content));
    if (!parsed.success) return err('这不是复调的作品包');
    manifest = parsed.data;
  } catch {
    return err('manifest.json 不是有效的 JSON');
  }
  if (manifest.formatVersion > PACKAGE_FORMAT_VERSION) return err('作品包由更新版本的复调导出，请先升级复调');
  const tables: Record<string, ExportedRow[]> = {};
  for (const f of files) {
    const m = /^data\/(.+)\.jsonl$/.exec(f.path);
    if (m === null) continue;
    const name = m[1] ?? '';
    const rows = fromJsonl(name, f.content);
    if (!rows.ok) return err(`${f.path} 第 ${rows.error.code === 'invalid' ? rows.error.row + 1 : '?'} 行无效`);
    tables[name] = rows.value;
  }
  if (tables['project']?.length !== 1) return err('作品包中没有作品信息');
  return ok({ manifest, data: { schemaVersion: manifest.schemaVersion, tables } });
}

/** 作品标识与已有作品相同时换成新标识，避免同一部作品导入两次后在作品列表中互相覆盖。 */
export function withProjectId(data: ExportedData, id: string): ExportedData {
  return { ...data, tables: { ...data.tables, project: (data.tables['project'] ?? []).map((row) => ({ ...row, id })) } };
}

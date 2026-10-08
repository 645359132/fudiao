// 正文导出的格式（需求 B07）。TXT 按中文排版习惯：段首两个全角空格，章与章之间空一行；Markdown 用标题与空行分段。
import { chapterMarkdown } from './project-package';

export type ExportChapter = { readonly title: string; readonly paragraphs: readonly string[] };

export function toTxt(chapters: readonly ExportChapter[]): string {
  return chapters.map((c) => [c.title, '', ...c.paragraphs.map((p) => `\u3000\u3000${p}`), ''].join('\n')).join('\n');
}

/** 整本时书名为一级标题、章名为二级标题；单章时章名为一级标题。 */
export function toMarkdown(chapters: readonly ExportChapter[], bookTitle?: string): string {
  if (bookTitle === undefined) return chapters.map((c) => chapterMarkdown(c.title, c.paragraphs)).join('');
  return `# ${bookTitle}\n\n${chapters.map((c) => `#${chapterMarkdown(c.title, c.paragraphs)}`).join('')}`;
}

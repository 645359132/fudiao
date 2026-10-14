// 正文导出的格式（需求 B07）。TXT 按中文排版习惯：段首两个全角空格，章与章之间空一行；Markdown 用标题与空行分段。
import { chapterMarkdown } from './project-package';

/** 导出的一章；volume 为所在卷的卷名（未分卷时省略）。 */
export type ExportChapter = { readonly title: string; readonly paragraphs: readonly string[]; readonly volume?: string };

/** 分卷的作品：每卷第一章之前写一行卷名（与导入时的分卷识别对应）。 */
const volumeStarts = (chapters: readonly ExportChapter[]) => chapters.map((c, i) => c.volume !== undefined && c.volume !== chapters[i - 1]?.volume);

export function toTxt(chapters: readonly ExportChapter[]): string {
  const starts = volumeStarts(chapters);
  return chapters
    .map((c, i) => [...(starts[i] === true ? [c.volume ?? '', ''] : []), c.title, '', ...c.paragraphs.map((p) => `\u3000\u3000${p}`), ''].join('\n'))
    .join('\n');
}

/** 整本时书名为一级标题、章名为二级标题（分卷的作品卷名为二级、章名为三级）；单章时章名为一级标题。 */
export function toMarkdown(chapters: readonly ExportChapter[], bookTitle?: string): string {
  if (bookTitle === undefined) return chapters.map((c) => chapterMarkdown(c.title, c.paragraphs)).join('');
  if (!chapters.some((c) => c.volume !== undefined)) return `# ${bookTitle}\n\n${chapters.map((c) => `#${chapterMarkdown(c.title, c.paragraphs)}`).join('')}`;
  const starts = volumeStarts(chapters);
  return `# ${bookTitle}\n\n${chapters.map((c, i) => `${starts[i] === true ? `## ${c.volume ?? ''}\n\n` : ''}##${chapterMarkdown(c.title, c.paragraphs)}`).join('')}`;
}

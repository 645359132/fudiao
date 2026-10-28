// 把导出的 TXT 拆成章：认“第N卷 卷题”“第N章 章题”“第一章”这样的标题，也认复调导出时章名单独一行、前面空一行、段落全角缩进的写法
// （作者导出的《长夜问刀》没有“第N章”前缀）。拆不出章时整篇算一章。

export type TextChapter = {
  readonly title: string;
  readonly volume: string | null;
  readonly paragraphs: readonly string[];
};

const VOLUME = /^第[一二三四五六七八九十百零〇\d]+卷(?:\s+\S.*)?$/u;
const CHAPTER = /^(?:第[一二三四五六七八九十百千零〇\d]+[章回节](?:\s+\S.*)?|[一二三四五六七八九十百零〇\d]+[、.．]\s*\S.*|#{1,3}\s+\S.*)$/u;
/** 单独一行的章名：不缩进、不长于这么多字、没有句末标点。 */
const BARE_TITLE_MAX = 16;

const isBlank = (line: string) => line.trim() === '';
const indented = (line: string) => /^[\u3000\t ]/u.test(line);
const bareTitle = (line: string) => !indented(line) && line.trim() !== '' && [...line.trim()].length <= BARE_TITLE_MAX && !/[。！？，；：“”…!?,]/u.test(line);

export function splitChapters(text: string): TextChapter[] {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
  type Draft = { title: string; volume: string | null; paragraphs: string[] };
  const chapters: Draft[] = [];
  let volume: string | null = null;
  let current: Draft | null = null;
  const open = (title: string): Draft => {
    const made: Draft = { title, volume, paragraphs: [] };
    chapters.push(made);
    current = made;
    return made;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (isBlank(line)) continue;
    if (VOLUME.test(trimmed)) {
      volume = trimmed;
      continue;
    }
    const previousBlank = i === 0 || isBlank(lines[i - 1] ?? '') || VOLUME.test((lines[i - 1] ?? '').trim());
    if (CHAPTER.test(trimmed) && !indented(line)) {
      open(trimmed.replace(/^#{1,3}\s+/u, ''));
      continue;
    }
    // 单独一行的章名：前面空一行、后面还有正文，而且它自己不像一句话。
    if (bareTitle(line) && previousBlank && lines.slice(i + 1).some((l) => !isBlank(l))) {
      open(trimmed);
      continue;
    }
    const target: Draft = current ?? open('全文');
    target.paragraphs.push(trimmed);
  }
  return chapters.map((c) => ({ title: c.title, volume: c.volume, paragraphs: c.paragraphs }));
}

// 导入 TXT 与 Markdown 时的章节拆分（需求 B07“明确章节拆分方式”）。纯函数，导入前在预览中展示结果。
import { countWords, err, ok, type Result } from '@fudiao/shared';

export type SplitRule =
  | { readonly kind: 'auto' }
  | { readonly kind: 'markdown' }
  | { readonly kind: 'none' }
  | { readonly kind: 'custom'; readonly pattern: string };

/** 拆出的一章；volume 为所在卷的卷名（文本里有“第一卷 ……”这样的分卷标题时）。 */
export type ImportedChapter = { readonly title: string; readonly paragraphs: readonly string[]; readonly volume?: string };

const NUMBER = '[零〇一二两三四五六七八九十百千万\\d０-９]+';
const UNIT = '[章回节卷集部篇]';
const SEPARATOR = '[\\s:：·、.．\\-—]';
/** 句末标点：标题不会以它们结尾。 */
const SENTENCE_END = /[。！？!?…”」』，,；;]$/;
const NUMBERED = new RegExp(`^第${NUMBER}${UNIT}`);
/** 分卷标题的单位（B68）：文本里同时有章一级的标题时，“第…卷 / 部 / 集”是卷，否则仍当作章。 */
const VOLUME_UNIT = new RegExp(`^第${NUMBER}[卷部集]`);
const NAMED = new RegExp(`^(?:序章|序言|序|楔子|引子|尾声|后记|终章|番外)(?:${SEPARATOR}|$)|^番外`);
const ENGLISH = /^chapter\s*\d+(?:[\s:.-]|$)/i;
const MAX_HEADING = 40;

/**
 * 一行是否像章节标题：限 40 字以内的独立一行。“第…章”后若直接接文字（不带分隔符），
 * 余下部分须不超过 20 字且不以句末标点结尾，以免把“第三章里他说……”之类的正文当成标题。
 */
export function isChapterHeading(raw: string): boolean {
  const line = raw.trim();
  if (line === '' || line.length > MAX_HEADING) return false;
  const numbered = NUMBERED.exec(line);
  if (numbered !== null) {
    const rest = line.slice(numbered[0].length);
    if (rest === '' || new RegExp(`^${SEPARATOR}`).test(rest)) return !SENTENCE_END.test(line) || rest === '';
    return rest.length <= 20 && !SENTENCE_END.test(rest);
  }
  if (NAMED.test(line)) return !SENTENCE_END.test(line);
  return ENGLISH.test(line);
}

/** 去掉首尾空白，包括全角空格（中文排版的段首缩进）与不换行空格。 */
const clean = (line: string) => line.replace(/^[\s\u3000\u00a0]+|[\s\u3000\u00a0]+$/g, '');

const MARKDOWN_HEADING = /^(#{1,3})\s+(.+?)\s*#*$/;

type Heading = { readonly level: 'volume' | 'chapter' | 'skip'; readonly title: string };

/**
 * 按规则拆分章节。自动识别时，“第…卷 / 部 / 集”在文本里还有章一级标题的情况下识别为分卷；
 * Markdown 里有三级标题时，一级标题是书名（略过）、二级是卷、三级是章（与整本导出的格式对应）。
 */
export function splitText(text: string, rule: SplitRule, fallbackTitle: string): Result<ImportedChapter[], string> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let heading: (line: string) => Heading | null;
  switch (rule.kind) {
    case 'auto': {
      const chapterLevel = lines.some((l) => isChapterHeading(l) && !VOLUME_UNIT.test(clean(l)));
      heading = (line) => {
        if (!isChapterHeading(line)) return null;
        const title = clean(line);
        return { level: chapterLevel && VOLUME_UNIT.test(title) ? 'volume' : 'chapter', title };
      };
      break;
    }
    case 'markdown': {
      const nested = lines.some((l) => MARKDOWN_HEADING.exec(clean(l))?.[1] === '###');
      heading = (line) => {
        const m = MARKDOWN_HEADING.exec(clean(line));
        if (m === null) return null;
        const title = m[2] ?? '';
        if (!nested) return { level: 'chapter', title };
        return { level: m[1] === '#' ? 'skip' : m[1] === '##' ? 'volume' : 'chapter', title };
      };
      break;
    }
    case 'none':
      heading = () => null;
      break;
    case 'custom': {
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, 'u');
      } catch (e) {
        return err(`自定义规则不是有效的正则表达式：${e instanceof Error ? e.message : String(e)}`);
      }
      heading = (line) => (re.test(clean(line)) ? { level: 'chapter', title: clean(line) } : null);
      break;
    }
  }

  const chapters: { title: string; paragraphs: string[]; volume?: string }[] = [];
  let current: { title: string; paragraphs: string[]; volume?: string } | null = null;
  let volume: string | undefined;
  for (const raw of lines) {
    const h = heading(raw);
    if (h !== null) {
      if (h.level === 'skip') continue;
      if (h.level === 'volume') {
        volume = h.title;
        // 卷标题之后、第一章之前的文字（卷首语）放进以卷名为题的一章，不丢。
        current = null;
        continue;
      }
      current = { title: h.title, paragraphs: [], ...(volume !== undefined && { volume }) };
      chapters.push(current);
      continue;
    }
    const line = clean(raw);
    if (line === '') continue;
    if (current === null) {
      current = { title: volume ?? '', paragraphs: [], ...(volume !== undefined && { volume }) };
      chapters.push(current);
    }
    current.paragraphs.push(line);
  }
  // 没有任何标题时整篇为一章；第一个标题之前的文字成为“正文前”。
  if (chapters.length === 1 && chapters[0]?.title === '' && chapters[0].volume === undefined) return ok([{ title: fallbackTitle, paragraphs: chapters[0].paragraphs }]);
  return ok(chapters.map((c) => (c.title === '' ? { ...c, title: '正文前' } : c)));
}

export type ChapterPreview = { readonly title: string; readonly paragraphs: number; readonly words: number; readonly volume?: string };

export const summarize = (chapters: readonly ImportedChapter[]): ChapterPreview[] =>
  chapters.map((c) => ({ title: c.title, paragraphs: c.paragraphs.length, words: c.paragraphs.reduce((n, p) => n + countWords(p), 0), ...(c.volume !== undefined && { volume: c.volume }) }));

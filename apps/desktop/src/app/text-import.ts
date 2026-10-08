// 导入 TXT 与 Markdown 时的章节拆分（需求 B07“明确章节拆分方式”）。纯函数，导入前在预览中展示结果。
import { countWords, err, ok, type Result } from '@fudiao/shared';

export type SplitRule =
  | { readonly kind: 'auto' }
  | { readonly kind: 'markdown' }
  | { readonly kind: 'none' }
  | { readonly kind: 'custom'; readonly pattern: string };

export type ImportedChapter = { readonly title: string; readonly paragraphs: readonly string[] };

const NUMBER = '[零〇一二两三四五六七八九十百千万\\d０-９]+';
const UNIT = '[章回节卷集部篇]';
const SEPARATOR = '[\\s:：·、.．\\-—]';
/** 句末标点：标题不会以它们结尾。 */
const SENTENCE_END = /[。！？!?…”」』，,；;]$/;
const NUMBERED = new RegExp(`^第${NUMBER}${UNIT}`);
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

const MARKDOWN_HEADING = /^#{1,3}\s+(.+?)\s*#*$/;

export function splitText(text: string, rule: SplitRule, fallbackTitle: string): Result<ImportedChapter[], string> {
  let heading: (line: string) => string | null;
  switch (rule.kind) {
    case 'auto':
      heading = (line) => (isChapterHeading(line) ? clean(line) : null);
      break;
    case 'markdown':
      heading = (line) => MARKDOWN_HEADING.exec(clean(line))?.[1] ?? null;
      break;
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
      heading = (line) => (re.test(clean(line)) ? clean(line) : null);
      break;
    }
  }

  const chapters: { title: string; paragraphs: string[] }[] = [];
  let current: { title: string; paragraphs: string[] } | null = null;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const title = heading(raw);
    if (title !== null) {
      current = { title, paragraphs: [] };
      chapters.push(current);
      continue;
    }
    const line = clean(raw);
    if (line === '') continue;
    if (current === null) {
      current = { title: '', paragraphs: [] };
      chapters.push(current);
    }
    current.paragraphs.push(line);
  }
  // 没有任何标题时整篇为一章；第一个标题之前的文字成为“正文前”。
  if (chapters.length === 1 && chapters[0]?.title === '') return ok([{ title: fallbackTitle, paragraphs: chapters[0].paragraphs }]);
  return ok(chapters.map((c) => (c.title === '' ? { ...c, title: '正文前' } : c)));
}

export type ChapterPreview = { readonly title: string; readonly paragraphs: number; readonly words: number };

export const summarize = (chapters: readonly ImportedChapter[]): ChapterPreview[] =>
  chapters.map((c) => ({ title: c.title, paragraphs: c.paragraphs.length, words: c.paragraphs.reduce((n, p) => n + countWords(p), 0) }));

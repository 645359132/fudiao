// 扫榜拆书（需求 B79）的纯函数：读作者粘贴的榜单，以及复述检查——拆书的结果里与样章相同、
// 长于上限的连续文字截短并计数（结果只给结构与技法，不大段复述原文）。

/** 拆书结果里与样章相同的连续文字最多保留多少字。 */
export const MAX_QUOTE_CHARS = 30;

export type RankEntry = { readonly title: string; readonly author: string; readonly tags: string; readonly words: string; readonly blurb: string };

const FIELDS: readonly (readonly [keyof RankEntry, readonly string[]])[] = [
  ['title', ['书名', '名称', '作品']],
  ['author', ['作者']],
  ['tags', ['标签', '类型', '题材', '分类']],
  ['words', ['字数']],
  ['blurb', ['简介', '介绍', '内容简介']],
];

/** 行首的名次：“1.”“1、”“1)”“第1名”“No.1”。 */
const RANK_PREFIX = /^(No\.?\s*\d+|第\s*\d+\s*名|\d+\s*[.、．)）])\s*/i;

/**
 * 读榜单：空行分开一本；每行“书名：……”“作者：……”“标签：……”“字数：……”“简介：……”（冒号全角半角都行）。
 * 没写“书名：”时第一行是书名（去掉前面的名次，例如“1.”“第1名”“No.1”）；认不出的行接到简介后面。
 * 从网页复制下来的榜单常常没有空行、一行一本（“1. 书名 作者 120万字”）：没有空行、而且多行都以名次开头时按行分本，
 * 一行里制表符分开的几格，第一格是书名，其余接到简介。
 */
export function parseRankList(text: string): RankEntry[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const nonEmpty = normalized
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  // 内容之间有没有空行。
  const hasBlank = /\S[ \t ]*\n([ \t ]*\n)+[ \t ]*\S/.test(normalized);
  const ranked = nonEmpty.filter((l) => RANK_PREFIX.test(l)).length;
  // 没有空行、各行都以名次开头（允许一行表头）：一行一本。
  const lineEach = !hasBlank && ranked >= 2 && ranked >= nonEmpty.length - 1;
  const blocks = lineEach
    ? nonEmpty.filter((l) => RANK_PREFIX.test(l)).map((l) => [l])
    : normalized
        .split(/\n\s*\n/)
        .map((b) =>
          b
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== ''),
        )
        .filter((b) => b.length > 0);
  const entries: RankEntry[] = [];
  for (const raw of blocks) {
    // 制表符分开的几格各成一行：第一格是书名，其余按原规则（“作者：……”或接到简介）。
    const lines = raw.flatMap((l) => (l.includes('\t') ? l.split('\t').map((c) => c.trim()).filter((c) => c !== '') : [l]));
    const entry: Record<keyof RankEntry, string> = { title: '', author: '', tags: '', words: '', blurb: '' };
    const rest: string[] = [];
    for (const line of lines) {
      const field = FIELDS.find(([, names]) => names.some((n) => line.startsWith(`${n}：`) || line.startsWith(`${n}:`)));
      if (field === undefined) {
        rest.push(line);
        continue;
      }
      const value = line.slice(line.search(/[：:]/) + 1).trim();
      entry[field[0]] = entry[field[0]] === '' ? value : `${entry[field[0]]} ${value}`;
    }
    if (entry.title === '' && rest.length > 0) entry.title = (rest.shift() ?? '').replace(RANK_PREFIX, '').trim();
    if (rest.length > 0) entry.blurb = [entry.blurb, ...rest].filter((x) => x !== '').join(' ');
    if (entry.title !== '') entries.push(entry);
  }
  return entries;
}

export type OverlapResult = { readonly text: string; readonly trimmed: number };

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * 复述检查器：按来源建一次窗口集合，之后对任意多段文字检查。拆解结果有几十个字段，一本样章可能几十万字，
 * 每个字段都重建一遍集合会卡住界面。字按码点数（一个表情符号或扩展区的字算一个）。
 */
export function overlapTrimmer(sources: readonly string[], limit = MAX_QUOTE_CHARS): (text: string) => OverlapResult {
  const window = limit + 1;
  const windows = new Set<string>();
  for (const source of sources) {
    const s = [...source.replace(/\s+/g, '')];
    for (let i = 0; i + window <= s.length; i++) windows.add(s.slice(i, i + window).join(''));
  }
  return (text) => {
    if (windows.size === 0) return { text, trimmed: 0 };
    // 在去掉空白的字（码点）上找，再映射回原文的位置。
    const chars = [...text];
    const keep: number[] = [];
    for (let i = 0; i < chars.length; i++) if (!isSpace(chars[i])) keep.push(i);
    const plain = keep.map((i) => chars[i] ?? '');
    const covered = new Array<boolean>(plain.length).fill(false);
    for (let i = 0; i + window <= plain.length; i++) {
      if (windows.has(plain.slice(i, i + window).join(''))) for (let j = i; j < i + window; j++) covered[j] = true;
    }
    const spans: { start: number; end: number }[] = [];
    for (let i = 0; i < plain.length; i++) {
      if (covered[i] !== true) continue;
      let j = i;
      while (j + 1 < plain.length && covered[j + 1] === true) j++;
      spans.push({ start: keep[i] ?? 0, end: (keep[j] ?? 0) + 1 });
      i = j;
    }
    if (spans.length === 0) return { text, trimmed: 0 };
    let out = '';
    let at = 0;
    for (const span of spans) {
      out += chars.slice(at, span.start).join('');
      // 保留前 limit 个非空白字。
      let kept = 0;
      let cut = span.start;
      while (cut < span.end && kept < limit) {
        if (!isSpace(chars[cut])) kept++;
        cut++;
      }
      out += `${chars.slice(span.start, cut).join('')}……`;
      at = span.end;
    }
    return { text: out + chars.slice(at).join(''), trimmed: spans.length };
  };
}

/**
 * 复述检查：text 里与任一来源相同、长于 limit 字的连续文字，只留前 limit 字并接上“……”。
 * 返回处理后的文字与截短了几处。比较时忽略空白。要检查多段文字时用 overlapTrimmer，只建一次窗口集合。
 */
export function trimOverlap(text: string, sources: readonly string[], limit = MAX_QUOTE_CHARS): OverlapResult {
  return overlapTrimmer(sources, limit)(text);
}

/** 按字（码点）截取：不把一个表情符号或扩展区的字切成半个。 */
export function sliceChars(text: string, start: number, end?: number): string {
  return [...text].slice(start, end).join('');
}

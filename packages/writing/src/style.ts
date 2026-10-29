// 文风统计（需求 B87，M8-01）：不需要模型、结果确定的数字——对话占比、句长与段长的分布、词汇多样性（MTLD）、高频实词、句首模板、
// 固定搭配与章尾方式。写手每章拿到最近几章的“风格账本”（styleLedger），审核按同样的数字提出问题（style-checks.ts），
// tools/prose-stats 对整本书算同一套数字。
// 依据见 IMPLEMENTATION_PLAN.md“M8 的依据”：模型文本的指纹在词级分布上、换词仍认得出（Sun 等 2025），句法模板远多于人写（Shaib 等 2024），
// 句长分布比人写的集中（Muñoz-Ortiz 等 2024）；《长夜问刀》里“仿佛”被规避后“如同”出现 386 次，所以按频率动态统计，不扩静态词表。
import { maskDialogue, TRAILER, visibleLength } from './prose';

export type EndingKind = 'dialogue' | 'question' | 'ellipsis' | 'freeze' | 'narration' | 'summary';
export const ENDING_KINDS: readonly EndingKind[] = ['dialogue', 'question', 'ellipsis', 'freeze', 'narration', 'summary'];
export const ENDING_KIND_LABEL: Readonly<Record<EndingKind, string>> = {
  dialogue: '一句对白',
  question: '一个问句',
  ellipsis: '省略号',
  freeze: '一句短的定格',
  narration: '一段叙述的画面',
  summary: '总结或预告',
};

/** 一组数的个数、均值、标准差与变异系数（标准差除以均值；均值为 0 时为 0）。 */
export type Stats = { readonly count: number; readonly mean: number; readonly sd: number; readonly cv: number };
/**
 * 一个片段的次数。left、right 是它左右两边出现过的字（最多记两个不同的，记到两个就够了；“^”“$”是句子或汉字串的边界），
 * 合并几章的次数时要靠它们判断片段是不是一个说法（见 isUnit）。
 */
export type TermCount = { readonly term: string; readonly count: number; readonly left?: string; readonly right?: string };

/** 最后一段不长于这个字数时算“定格”（一个画面或一个动作收住）。 */
export const FREEZE_CHARS = 30;
/** 账本看最近几章。 */
export const STYLE_WINDOW = 8;
/** 账本里最多列几个用得太多的词。 */
export const MAX_OVERUSED = 20;
/** 每章一行里最多列几个多用的词。 */
const LINE_TERMS = 4;
/** 对白至少这么多句才说它的句型。 */
export const MOOD_MIN_SENTENCES = 5;
/** 词汇多样性的 TTR 阈值（McCarthy & Jarvis 2010 的标准值）。 */
export const MTLD_THRESHOLD = 0.72;

/**
 * 虚字：含这些字的二三字片段不算实词（“上的”“了一”“他的”是语法搭配，不是用词指纹）。“没”不在其中——“没有”由句首模板另算。
 * 四字片段只要求不多于一个虚字（“微不可察”这样的指纹要留下）。
 */
const FUNCTION_CHARS = new Set('的了着在是不也就都有一这那他她它们把被从向与和而又还很个之其所为以上下里中么呢吧啊呀吗过去来到对会能要让给等及并或却仍已曾将正当自己什么怎么只才再更最太');
const MASK = '□';
const HAN = /\p{Script=Han}/u;
const SENTENCE_BREAK = /[。！？；!?…]+|\n+/u;
/** 左右两边记到几个不同的字就算“变化”。 */
const VARIED = 2;
const BOUNDARY_LEFT = '^';
const BOUNDARY_RIGHT = '$';

export function stats(values: readonly number[]): Stats {
  const count = values.length;
  if (count === 0) return { count: 0, mean: 0, sd: 0, cv: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / count;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / count);
  return { count, mean, sd, cv: mean === 0 ? 0 : sd / mean };
}

/** 名字（长的先换）换成遮罩字：遮罩字不是汉字，片段到此断开，名字与名字的子串都不算词。 */
export function maskNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))].sort((a, b) => b.length - a.length)) {
    if (out.includes(name)) out = out.split(name).join(MASK.repeat(name.length));
  }
  return out;
}

/** 叙述（对白以外）里的句子：按句末标点切开，去掉空的。 */
export function narrationSentences(texts: readonly string[]): string[] {
  return texts.flatMap((t) => maskDialogue(t).split(SENTENCE_BREAK)).map((s) => s.trim()).filter((s) => visibleLength(s) > 0);
}

/** 对白（引号里的字）占全部字数的比例。 */
export function dialogueRatio(texts: readonly string[]): number {
  const all = texts.join('\n');
  const words = visibleLength(all);
  if (words === 0) return 0;
  return (words - visibleLength(maskDialogue(all))) / words;
}

/** 叙述句子长度（可见字数）的分布。 */
export const sentenceStats = (texts: readonly string[]): Stats => stats(narrationSentences(texts).map(visibleLength));

/** 段落长度（可见字数）的分布，空段不算。 */
export const paragraphStats = (texts: readonly string[]): Stats => stats(texts.map(visibleLength).filter((n) => n > 0));

/**
 * 对白的句型：引号里的话按句末标点切成句，问句（？）、感叹（！）、没说完的话（……或——收尾）与陈述各几句。
 * 人写的对话里问、叹与省略号多（HC3：人的回答比 ChatGPT 多用“！”“？”与省略号；Human or Not?：读者凭情绪与粗粝认人），
 * 一章的对白几乎都是陈述句时像在交代而不是在说话。
 */
export type DialogueStats = {
  readonly sentences: number;
  readonly question: number;
  readonly exclamation: number;
  readonly unfinished: number;
  readonly declarative: number;
};

const QUOTE = /[“「『]([^”」』]*)[”」』]/gu;
const DIALOGUE_SPLIT = /(?<=[。！？!?…—])/u;

export function dialogueStats(texts: readonly string[]): DialogueStats {
  let question = 0;
  let exclamation = 0;
  let unfinished = 0;
  let declarative = 0;
  for (const t of texts) {
    for (const m of t.matchAll(QUOTE)) {
      for (const piece of (m[1] ?? '').split(DIALOGUE_SPLIT)) {
        const s = piece.trim();
        if (visibleLength(s) === 0) continue;
        if (/[？?]$/u.test(s)) question += 1;
        else if (/[！!]$/u.test(s)) exclamation += 1;
        else if (/(?:…|—)$/u.test(s)) unfinished += 1;
        else declarative += 1;
      }
    }
  }
  return { sentences: question + exclamation + unfinished + declarative, question, exclamation, unfinished, declarative };
}

/** 对白里问句、感叹与没说完的话合起来占几成；没有对白时为 0。 */
export const dialogueMood = (d: DialogueStats): number => (d.sentences === 0 ? 0 : (d.question + d.exclamation + d.unfinished) / d.sentences);

/**
 * 词汇多样性 MTLD（McCarthy & Jarvis 2010）：TTR 降到阈值以下算一个因子，正反各算一遍取均值；不随文本长度变化。
 * 中文没有分词，按字（unit 为 char）或字二元组（bigram）计，数字只在同一口径下比较。少于 10 个单位时返回单位数。
 */
export function mtld(text: string, unit: 'char' | 'bigram' = 'char', threshold: number = MTLD_THRESHOLD): number {
  const chars = [...text].filter((c) => HAN.test(c));
  const tokens = unit === 'char' ? chars : chars.slice(1).map((c, i) => `${chars[i]}${c}`);
  if (tokens.length < 10) return tokens.length;
  const pass = (list: readonly string[]): number => {
    let factors = 0;
    let seen = new Set<string>();
    let n = 0;
    let ttr = 1;
    for (const t of list) {
      seen.add(t);
      n += 1;
      ttr = seen.size / n;
      if (ttr <= threshold) {
        factors += 1;
        seen = new Set();
        n = 0;
        ttr = 1;
      }
    }
    // 结尾不满一个因子的部分按比例计入。
    if (n > 0) factors += (1 - ttr) / (1 - threshold);
    return factors === 0 ? list.length : list.length / factors;
  };
  return (pass(tokens) + pass([...tokens].reverse())) / 2;
}

/** 文字里的汉字片段（遮住对白与名字之后），非汉字处断开。 */
function hanRuns(texts: readonly string[], names: readonly string[]): string[] {
  return texts.flatMap((t) => maskNames(maskDialogue(t), names).split(/[^\p{Script=Han}]+/u)).filter((r) => r.length >= 2);
}

const functionChars = (gram: string) => [...gram].filter((c) => FUNCTION_CHARS.has(c)).length;
const isContentTerm = (gram: string) => (gram.length <= 3 ? functionChars(gram) === 0 : functionChars(gram) <= 1);

/** 记一个相邻的字：记满两个不同的就不再记。 */
const neighbor = (set: string, c: string) => (set.length >= VARIED || set.includes(c) ? set : `${set}${c}`);
/** 这一边的字变化过（有两个不同的，或者到过边界）。 */
const varied = (set: string, boundary: string) => set.length >= VARIED || set.includes(boundary);

/**
 * 片段是不是一个说法：出现过两次以上的片段，左右两边的字都得变化过（“极阳真”右边总是“气”、“人牙酸的”左边总是“令”，
 * 都只是更长的说法的一截，不算）。只出现一次的分不出来，先留着，合并几章之后再判断。
 */
export function isUnit(t: TermCount): boolean {
  if (t.count < 2 || t.left === undefined || t.right === undefined) return true;
  return varied(t.left, BOUNDARY_LEFT) && varied(t.right, BOUNDARY_RIGHT);
}

type GramStat = { count: number; left: string; right: string };

function countGrams(runs: readonly string[], length: number, accept: (gram: string) => boolean, into: Map<string, GramStat>): void {
  for (const run of runs) {
    for (let i = 0; i + length <= run.length; i++) {
      const gram = run.slice(i, i + length);
      if (!accept(gram)) continue;
      const stat = into.get(gram) ?? { count: 0, left: '', right: '' };
      stat.count += 1;
      stat.left = neighbor(stat.left, run[i - 1] ?? BOUNDARY_LEFT);
      stat.right = neighbor(stat.right, run[i + length] ?? BOUNDARY_RIGHT);
      into.set(gram, stat);
    }
  }
}

const byCount = (a: TermCount, b: TermCount) => b.count - a.count || a.term.localeCompare(b.term, 'zh');

function grams(texts: readonly string[], names: readonly string[], min: number, max: number, accept: (gram: string) => boolean): TermCount[] {
  const runs = hanRuns(texts, names);
  const counts = new Map<string, GramStat>();
  for (let length = min; length <= max; length++) countGrams(runs, length, accept, counts);
  return [...counts.entries()]
    .map(([term, s]) => ({ term, count: s.count, left: s.left, right: s.right }))
    .filter(isUnit)
    .sort(byCount);
}

/**
 * 高频实词：对白以外、名字以外的 2 到 4 字片段，去掉含虚字的与只是更长说法一截的，按次数排列（出现一次的也列：
 * 账本要把几章各一次的说法合起来看）。这是作品自己的“过量词汇”（Kobak 等 2025 的思路用在一本书里）：不需要知道哪些词是
 * AI 腔，用多了就是指纹。
 */
export function termCounts(texts: readonly string[], names: readonly string[], options: { readonly min?: number; readonly max?: number } = {}): TermCount[] {
  return grams(texts, names, options.min ?? 2, options.max ?? 4, isContentTerm);
}

/**
 * 固定搭配：对白以外 4 到 8 字的片段在这些文字里重复了 atLeast 次以上（“发出一声闷响”“指骨泛出青白”），至少两个实字；
 * 留下的是最长的那个重复片段（“发出一声闷响”左边总是“门”时只留“门发出一声闷响”）。
 */
export function collocations(texts: readonly string[], names: readonly string[], options: { readonly min?: number; readonly max?: number; readonly atLeast?: number } = {}): TermCount[] {
  const atLeast = options.atLeast ?? 3;
  return grams(texts, names, options.min ?? 4, options.max ?? 8, (g) => g.length - functionChars(g) >= 2).filter((t) => t.count >= atLeast);
}

/**
 * 句首模板：叙述里的句子以什么开头。以名字开头的记“名字＋后两个字”（“沈孤舟没有”“沈孤舟抬手”），其余记前两个字。
 * 按次数排列（出现一次的也列：账本要把几章各一次的句首合起来看）。
 */
export function openingTemplates(texts: readonly string[], names: readonly string[]): TermCount[] {
  const sorted = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))].sort((a, b) => b.length - a.length);
  const counts = new Map<string, number>();
  for (const sentence of narrationSentences(texts)) {
    const body = sentence.replace(/^[^\p{Script=Han}]+/u, '');
    if (body === '') continue;
    const name = sorted.find((n) => body.startsWith(n));
    let head: string;
    if (name !== undefined) {
      const rest = [...body.slice(name.length)].slice(0, 2).join('');
      if (!HAN.test(rest.slice(0, 1))) continue;
      head = `${name}${[...rest].filter((c) => HAN.test(c)).join('')}`;
    } else {
      const two = [...body].slice(0, 2).join('');
      if (two.length < 2 || ![...two].every((c) => HAN.test(c))) continue;
      head = two;
    }
    counts.set(head, (counts.get(head) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort(byCount);
}

/** 章尾怎么收：看最后一段（总结或预告看最后几段）。 */
export function endingKind(paragraphs: readonly string[]): EndingKind {
  const filled = paragraphs.map((p) => p.trim()).filter((p) => p !== '');
  const last = filled.at(-1);
  if (last === undefined) return 'narration';
  const tail = filled.slice(-3).join('\n');
  if (TRAILER.test(maskDialogue(tail))) return 'summary';
  if (/[”」』"]$/u.test(last) || /^[“「『"]/u.test(last)) return 'dialogue';
  if (/[？?]$/u.test(last)) return 'question';
  if (/(?:…|\.{3})$/u.test(last)) return 'ellipsis';
  return visibleLength(last) <= FREEZE_CHARS ? 'freeze' : 'narration';
}

/** 一章的文风数字。 */
export type ChapterStyle = {
  readonly words: number;
  readonly dialogueRatio: number;
  readonly sentences: Stats;
  readonly paragraphs: Stats;
  /** 按字计的 MTLD。 */
  readonly mtld: number;
  readonly ending: EndingKind;
  /** 高频实词，按次数（出现一次的也在）。 */
  readonly terms: readonly TermCount[];
  readonly openings: readonly TermCount[];
  readonly collocations: readonly TermCount[];
  /** 对白的句型（B87 补充）。 */
  readonly dialogue: DialogueStats;
};

export function chapterStyle(paragraphs: readonly string[], names: readonly string[]): ChapterStyle {
  const text = paragraphs.join('\n');
  return {
    words: visibleLength(text),
    dialogueRatio: dialogueRatio(paragraphs),
    sentences: sentenceStats(paragraphs),
    paragraphs: paragraphStats(paragraphs),
    mtld: mtld(text),
    ending: endingKind(paragraphs),
    terms: termCounts(paragraphs, names),
    openings: openingTemplates(paragraphs, names),
    collocations: collocations(paragraphs, names),
    dialogue: dialogueStats(paragraphs),
  };
}

/** 账本里的一章一行。 */
export type ChapterStyleLine = {
  readonly title: string;
  readonly words: number;
  readonly dialogueRatio: number;
  readonly sentenceCv: number;
  readonly ending: EndingKind;
  /** 这一章用得最多的几个实词。 */
  readonly topTerms: readonly TermCount[];
  /** 对白里问、叹与没说完的话的占比；对白不足几句时为 null。 */
  readonly dialogueMood: number | null;
};
/** 最近几章里用得太多的说法：总次数与出现的章数。 */
export type OverusedTerm = TermCount & { readonly chapters: number };

export type StyleLedger = {
  /** 最近几章（从远到近）。 */
  readonly chapters: readonly ChapterStyleLine[];
  /** 用得太多的实词与固定搭配。 */
  readonly overused: readonly OverusedTerm[];
  /** 用得太多的句首。 */
  readonly overusedOpenings: readonly OverusedTerm[];
  /** 最近几章的章尾方式（从远到近）。 */
  readonly endings: readonly EndingKind[];
  /** 最近几章合计的对话占比。 */
  readonly dialogueRatio: number;
  readonly words: number;
};

export type LedgerChapter = { readonly title: string; readonly paragraphs: readonly string[] };

/**
 * 把几章的次数合起来，记下出现的章数，左右两边的字也合起来；合起来之后只是更长说法一截的去掉
 * （账本与整本书的统计共用）。
 */
export function mergeTerms(perChapter: readonly (readonly TermCount[])[]): Map<string, OverusedTerm> {
  const total = new Map<string, { count: number; chapters: number; left?: string; right?: string }>();
  for (const list of perChapter) {
    for (const t of list) {
      const m = total.get(t.term) ?? { count: 0, chapters: 0 };
      m.count += t.count;
      m.chapters += 1;
      if (t.left !== undefined) m.left = [...t.left].reduce(neighbor, m.left ?? '');
      if (t.right !== undefined) m.right = [...t.right].reduce(neighbor, m.right ?? '');
      total.set(t.term, m);
    }
  }
  const merged = new Map<string, OverusedTerm>();
  for (const [term, m] of total) {
    const t: OverusedTerm = { term, count: m.count, chapters: m.chapters, ...(m.left !== undefined && { left: m.left }), ...(m.right !== undefined && { right: m.right }) };
    if (isUnit(t)) merged.set(term, t);
  }
  return merged;
}

/** 去掉左右两边的字，只留说法与次数（给界面与测试看）。 */
export const plain = <T extends TermCount>(t: T): Omit<T, 'left' | 'right'> => {
  const { left: _left, right: _right, ...rest } = t;
  return rest;
};

/**
 * 风格账本：最近 window 章各一行，加上这几章里用得太多的说法。
 * 用得太多：在至少一半的章里出现，并且三字以上的说法总共 ≥ max(3, 章数 × 0.75) 次、两字的词 ≥ max(10, 章数 × 3) 次；
 * 句首模板 ≥ max(6, 章数 × 1.5) 次。两字的词多半是书里的东西（“断刀”），只在列表的后面、给写手“少用或换说法”。
 */
export function styleLedger(chapters: readonly LedgerChapter[], names: readonly string[], options: { readonly window?: number; readonly maxTerms?: number } = {}): StyleLedger {
  const window = options.window ?? STYLE_WINDOW;
  const maxTerms = options.maxTerms ?? MAX_OVERUSED;
  const recent = chapters.slice(-window).filter((c) => c.paragraphs.some((p) => p.trim() !== ''));
  const styles = recent.map((c) => chapterStyle(c.paragraphs, names));
  const n = styles.length;
  const half = Math.ceil(n / 2);
  const words = styles.reduce((sum, s) => sum + s.words, 0);
  const dialogue = styles.reduce((sum, s) => sum + s.dialogueRatio * s.words, 0);

  const terms = mergeTerms(styles.map((s) => [...s.terms, ...s.collocations]));
  const overused = [...terms.values()]
    .filter((t) => t.chapters >= half && (t.term.length >= 3 ? t.count >= Math.max(3, Math.round(n * 0.75)) : t.count >= Math.max(10, n * 3)))
    .sort((a, b) => Number(a.term.length < 3) - Number(b.term.length < 3) || byCount(a, b))
    .slice(0, maxTerms)
    .map(plain);
  const openings = mergeTerms(styles.map((s) => s.openings));
  const overusedOpenings = [...openings.values()]
    .filter((t) => t.chapters >= half && t.count >= Math.max(6, Math.round(n * 1.5)))
    .sort(byCount)
    .slice(0, maxTerms)
    .map(plain);

  return {
    chapters: recent.map((c, i) => {
      const s = styles[i] as ChapterStyle;
      return {
        title: c.title,
        words: s.words,
        dialogueRatio: s.dialogueRatio,
        sentenceCv: s.sentences.cv,
        ending: s.ending,
        topTerms: s.terms.filter((t) => t.count >= 2).slice(0, LINE_TERMS).map(plain),
        dialogueMood: s.dialogue.sentences >= MOOD_MIN_SENTENCES ? dialogueMood(s.dialogue) : null,
      };
    }),
    overused,
    overusedOpenings,
    endings: styles.map((s) => s.ending),
    dialogueRatio: words === 0 ? 0 : dialogue / words,
    words,
  };
}

/** 账本写成给写手看的中文。 */
export type LedgerText = {
  /** 每章一行。 */
  readonly lines: readonly string[];
  /** 用得太多、这一章不要再用的说法（含句首模板）。 */
  readonly overused: readonly string[];
  /** 最近几章的章尾方式（从远到近）。 */
  readonly endings: readonly string[];
  readonly dialogueRatio: number;
};

export const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export function describeLedger(ledger: StyleLedger): LedgerText {
  return {
    lines: ledger.chapters.map((c) => {
      const top = c.topTerms.length === 0 ? '' : `；多用：${c.topTerms.map((t) => `${t.term}×${t.count}`).join('、')}`;
      const mood = c.dialogueMood === null ? '' : `（对白里问、叹与没说完的占 ${percent(c.dialogueMood)}）`;
      return `《${c.title}》：${c.words.toLocaleString('en-US')} 字，对话 ${percent(c.dialogueRatio)}${mood}，句长变异 ${c.sentenceCv.toFixed(2)}，收尾：${ENDING_KIND_LABEL[c.ending]}${top}`;
    }),
    overused: [
      ...ledger.overused.map((t) => `“${t.term}”（${t.chapters} 章 ${t.count} 次）`),
      ...ledger.overusedOpenings.map((t) => `句子以“${t.term}……”开头（${t.count} 次）`),
    ],
    endings: ledger.endings.map((e) => ENDING_KIND_LABEL[e]),
    dialogueRatio: ledger.dialogueRatio,
  };
}

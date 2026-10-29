// 整本书的“AI 味”统计（需求 B87）：复现两个模型对《长夜问刀》给出的证据——章字数的均值与标准差、章名字数分布、对话占比、
// 高频实词与句首模板、章尾方式、句长方差、词汇多样性与跨章重复片段。数字由 packages/writing 的 style.ts 算，这里只汇总。
import { chapterStyle, ENDING_KIND_LABEL, ENDING_KINDS, mergeTerms, sentenceStats, paragraphStats, stats, type DialogueStats, type EndingKind, type Stats, type OverusedTerm } from '@fudiao/writing';
import type { TextChapter } from './split';

export type ChapterRow = {
  readonly index: number;
  readonly title: string;
  readonly volume: string | null;
  readonly words: number;
  readonly dialogueRatio: number;
  readonly sentenceCv: number;
  readonly mtld: number;
  readonly ending: EndingKind;
};

export type RatedTerm = OverusedTerm & { readonly perTenThousand: number };

export type BookStats = {
  readonly chapters: number;
  readonly words: number;
  readonly chapterWords: Stats;
  readonly titleLengths: Readonly<Record<number, number>>;
  readonly dialogue: {
    readonly overall: number;
    readonly byVolume: readonly { readonly volume: string; readonly chapters: number; readonly ratio: number }[];
    readonly lowest: readonly ChapterRow[];
  };
  /** 全书叙述句子与段落长度的分布。 */
  readonly sentences: Stats;
  readonly paragraphs: Stats;
  /** 各章 MTLD（按字）的中位数。 */
  readonly mtldMedian: number;
  /** 全书对白的句型（问、叹、没说完、陈述各几句）。 */
  readonly dialogueSentences: DialogueStats;
  readonly endings: Readonly<Record<EndingKind, number>>;
  readonly terms: readonly RatedTerm[];
  readonly openings: readonly RatedTerm[];
  /** 跨章重复的四字及以上片段，按出现的章数。 */
  readonly crossChapter: readonly RatedTerm[];
  readonly rows: readonly ChapterRow[];
};

export type StatsOptions = { readonly names?: readonly string[]; readonly top?: number; readonly lowest?: number };

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
};

export function bookStats(chapters: readonly TextChapter[], options: StatsOptions = {}): BookStats {
  const names = options.names ?? [];
  const top = options.top ?? 40;
  const lowest = options.lowest ?? 10;
  const styles = chapters.map((c) => chapterStyle(c.paragraphs, names));
  const rows: ChapterRow[] = chapters.map((c, i) => {
    const s = styles[i];
    return {
      index: i + 1,
      title: c.title,
      volume: c.volume,
      words: s?.words ?? 0,
      dialogueRatio: s?.dialogueRatio ?? 0,
      sentenceCv: s?.sentences.cv ?? 0,
      mtld: s?.mtld ?? 0,
      ending: s?.ending ?? 'narration',
    };
  });
  const words = rows.reduce((n, r) => n + r.words, 0);
  const rate = (count: number) => (words === 0 ? 0 : (count * 10_000) / words);
  const rated = (m: ReadonlyMap<string, OverusedTerm>): RatedTerm[] => [...m.values()].map((t) => ({ ...t, perTenThousand: rate(t.count) }));

  const titleLengths: Record<number, number> = {};
  for (const c of chapters) {
    const n = [...c.title.trim()].length;
    titleLengths[n] = (titleLengths[n] ?? 0) + 1;
  }

  const volumes = new Map<string, { chapters: number; words: number; dialogue: number }>();
  for (const r of rows) {
    const key = r.volume ?? '（未分卷）';
    const v = volumes.get(key) ?? { chapters: 0, words: 0, dialogue: 0 };
    volumes.set(key, { chapters: v.chapters + 1, words: v.words + r.words, dialogue: v.dialogue + r.dialogueRatio * r.words });
  }
  const dialogueWords = rows.reduce((n, r) => n + r.dialogueRatio * r.words, 0);

  const endings = Object.fromEntries(ENDING_KINDS.map((k) => [k, 0])) as Record<EndingKind, number>;
  for (const r of rows) endings[r.ending] += 1;

  const terms = rated(mergeTerms(styles.map((s) => [...s.terms, ...s.collocations])))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term, 'zh'))
    .slice(0, top);
  const openings = rated(mergeTerms(styles.map((s) => s.openings)))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term, 'zh'))
    .slice(0, Math.ceil(top / 2));
  const crossChapter = rated(mergeTerms(styles.map((s) => [...s.terms.filter((t) => t.term.length >= 4), ...s.collocations])))
    .filter((t) => t.chapters >= 2)
    .sort((a, b) => b.chapters - a.chapters || b.count - a.count || a.term.localeCompare(b.term, 'zh'))
    .slice(0, top);

  const all = chapters.flatMap((c) => [...c.paragraphs]);
  const dialogueSentences = styles.reduce(
    (sum, s) => ({
      sentences: sum.sentences + s.dialogue.sentences,
      question: sum.question + s.dialogue.question,
      exclamation: sum.exclamation + s.dialogue.exclamation,
      unfinished: sum.unfinished + s.dialogue.unfinished,
      declarative: sum.declarative + s.dialogue.declarative,
    }),
    { sentences: 0, question: 0, exclamation: 0, unfinished: 0, declarative: 0 },
  );
  return {
    chapters: chapters.length,
    words,
    chapterWords: stats(rows.map((r) => r.words)),
    titleLengths,
    dialogue: {
      overall: words === 0 ? 0 : dialogueWords / words,
      byVolume: [...volumes.entries()].map(([volume, v]) => ({ volume, chapters: v.chapters, ratio: v.words === 0 ? 0 : v.dialogue / v.words })),
      lowest: [...rows].filter((r) => r.words > 0).sort((a, b) => a.dialogueRatio - b.dialogueRatio).slice(0, lowest),
    },
    sentences: sentenceStats(all),
    paragraphs: paragraphStats(all),
    mtldMedian: median(rows.map((r) => r.mtld)),
    dialogueSentences,
    endings,
    terms,
    openings,
    crossChapter,
    rows,
  };
}

export const endingLabel = (kind: EndingKind): string => ENDING_KIND_LABEL[kind];

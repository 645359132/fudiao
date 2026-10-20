// 写作工作流试用（M6-08）的材料：在 m3/eval/book.json 的短篇上依次跑各个工作流时用到的参数、
// 植入的跨章矛盾与扫榜拆书的“对标样章”。样章只用本项目自己的文字（book.json 与这次写手写的正文），不用任何第三方作品。
import type { EvalBook } from '../m3-eval/book';

/** 依次运行的顺序：后面的工作流要用前面写出的章节。 */
export const EVAL_ORDER = ['quick_book', 'book_audit', 'opening_polish', 'cast_completion', 'next_volume', 'benchmark'] as const;
export type EvalWorkflow = (typeof EVAL_ORDER)[number];

/** 一键成书现写的章数与每章字数；后面的工作流都在这几章上做。 */
export const BOOK_CHAPTERS = 3;
export const WORDS_PER_CHAPTER = 1500;

/** 各工作流的参数（扫榜拆书的条数在导入样章时才知道）。 */
export function paramsFor(book: Pick<EvalBook, 'genre'>) {
  return {
    // 没写想法：沿用材料里的大纲与人物，跳过“大纲与人物”。
    quick_book: { idea: '', genre: book.genre, chapters: BOOK_CHAPTERS, wordsPerChapter: WORDS_PER_CHAPTER },
    // 一键成书里每章都审过，这里不重新审核，看跨章的检查。
    book_audit: { from: null, to: null, rereview: false },
    opening_polish: { chapters: 2 },
    cast_completion: {},
    next_volume: { chapters: 2, wordsPerChapter: WORDS_PER_CHAPTER, instruction: '接着上一卷的结局往下写：旧账了结之后，林舟在当铺里的新麻烦。节奏紧一些。' },
    benchmark: { idea: '市井小人物卷进一件旧物的来历' },
  } as const;
}

/**
 * 植入的跨章矛盾：前一章把父亲的端砚当掉了，后一章端砚却还在身上，而且说“一样也没有当过”。
 * 两处单看都没有问题（单章审核查不出），只有跨章的检查能发现。keyword 用来判断疑点说的是不是这件事。
 */
export const CONTRADICTION = {
  earlier: { chapter: 1, text: '临出门前，林舟一咬牙，把父亲留下的那方端砚也押给了钱四，换了二两碎银，当票折成小方块塞进了袖口。' },
  later: { chapter: 3, text: '他从怀里摸出父亲留下的那方端砚，在手心里掂了掂。父亲的东西，除了那块玉佩，他一样也没有当过。' },
  keyword: '砚',
} as const;

/** 扫榜拆书的榜单与样章：材料里的大纲与植入问题的段落合成一份“样章”；这次写手写的第一章（有时）作为第二本。 */
export function benchmarkSamples(book: EvalBook, firstChapter: { readonly title: string; readonly text: string } | null) {
  const material = [book.synopsis, book.outline, ...book.plants.map((p) => p.text)].join('\n');
  const rankText = [
    `1. ${book.title}（材料）\n标签：${book.genre}\n简介：${book.synopsis}`,
    ...(firstChapter === null ? [] : [`2. ${book.title}（写手正文）\n标签：${book.genre}\n简介：本次试用里写手写的${firstChapter.title}`]),
  ].join('\n\n');
  const books = [{ title: `${book.title}（材料）`, text: material }, ...(firstChapter === null ? [] : [{ title: `${book.title}（写手正文）`, text: `${firstChapter.title}\n${firstChapter.text}` }])];
  return { rankText, books };
}

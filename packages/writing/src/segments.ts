// 写手成章的分段（需求 B59）：按章节计划的情节点分成若干段，每段一次调用，避免单次输出过长被截断。

/** 每段的目标字数。 */
export const SEGMENT_WORDS = 1500;
/** 章节计划没有定字数时的默认字数。 */
export const DEFAULT_CHAPTER_WORDS = 3000;

export type SegmentPlan = {
  /** 每段要写的情节点；没有情节点的章节是一个空段，按本章目标写。 */
  readonly segments: readonly (readonly string[])[];
  /** 每段的目标字数。 */
  readonly words: readonly number[];
};

export function planSegments(beats: readonly string[], targetWords: number | null): SegmentPlan {
  const total = targetWords ?? DEFAULT_CHAPTER_WORDS;
  const count = Math.max(1, Math.min(Math.round(total / SEGMENT_WORDS), Math.max(beats.length, 1)));
  const base = Math.floor(beats.length / count);
  const extra = beats.length % count;
  const segments: string[][] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const size = base + (i < extra ? 1 : 0);
    segments.push(beats.slice(at, at + size));
    at += size;
  }
  const each = Math.max(1, Math.round(total / count));
  return { segments, words: segments.map(() => each) };
}

/**
 * 本章已有正文写到了 written 里的情节点（例如采纳的推演正文，需求 B85）时的分段：第一段是已写出的情节点（写手不再写它，
 * 作为“已写”的进度），其余按 planSegments 分段，字数按情节点数的比例分给第一段。written 里不在 beats 的忽略；
 * 一条也对不上时与 planSegments 相同、done 为 0。情节点都已写出时只有第一段。
 */
export function planSegmentsAfter(beats: readonly string[], written: readonly string[], targetWords: number | null): SegmentPlan & { readonly done: number } {
  const covered = beats.filter((b) => written.includes(b));
  if (covered.length === 0) return { ...planSegments(beats, targetWords), done: 0 };
  const rest = beats.filter((b) => !written.includes(b));
  const total = targetWords ?? DEFAULT_CHAPTER_WORDS;
  const share = Math.max(1, Math.round((total * covered.length) / beats.length));
  if (rest.length === 0) return { segments: [covered], words: [share], done: 1 };
  const after = planSegments(rest, Math.max(1, total - share));
  return { segments: [covered, ...after.segments], words: [share, ...after.words], done: 1 };
}

/** 写手输出的文字按换行切成段落：去掉首尾空白（含全角空格）与空行。 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n/)
    // trim 去掉的空白包括全角空格（段首缩进）。
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

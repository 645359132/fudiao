// 章节计划的均一检查（需求 B87，M8-01）：整本书的章名长短、各章字数、章尾收法与过渡章的分布。
// 《长夜问刀》200 个章名全是四字、每章字数的标准差只有均值的一成、章章悬念收尾，读者一眼看出是机器排的。
import type { ChapterRhythm } from '@fudiao/shared';

export type PlanVarietyItem = {
  readonly title: string;
  readonly targetWords: number | null;
  readonly rhythm: Pick<ChapterRhythm, 'type' | 'ending'> | null;
};

export type PlanVarietyProblem = {
  readonly kind: 'titles' | 'words' | 'endings' | 'transitions';
  readonly description: string;
};

/** 少于这么多章不查。 */
export const VARIETY_MIN_CHAPTERS = 6;
/** 同一长度的章名不超过这个比例，且至少有三种长度。 */
export const TITLE_SHARE_MAX = 0.6;
export const TITLE_LENGTHS_MIN = 3;
/** 各章字数的变异系数至少这么大。 */
export const WORDS_CV_MIN = 0.15;
/** 连续几章同一种收法算问题。 */
export const ENDING_RUN = 3;
/** 每连续这么多章里至少一章过渡或日常。 */
export const TRANSITION_WINDOW = 10;

const titleLength = (title: string) => [...title.trim()].length;

export function planVariety(items: readonly PlanVarietyItem[]): PlanVarietyProblem[] {
  const problems: PlanVarietyProblem[] = [];
  if (items.length < VARIETY_MIN_CHAPTERS) return problems;

  const lengths = new Map<number, number>();
  for (const item of items) lengths.set(titleLength(item.title), (lengths.get(titleLength(item.title)) ?? 0) + 1);
  const [topLength, topCount] = [...lengths.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  if (lengths.size < TITLE_LENGTHS_MIN || topCount > items.length * TITLE_SHARE_MAX) {
    problems.push({ kind: 'titles', description: `${items.length} 章里 ${topCount} 章的章名都是 ${topLength} 字：章名长短应当不一，两到七字混用，口语化的也可以` });
  }

  const words = items.map((i) => i.targetWords).filter((w): w is number => w !== null && w > 0);
  if (words.length >= VARIETY_MIN_CHAPTERS) {
    const mean = words.reduce((a, b) => a + b, 0) / words.length;
    const cv = Math.sqrt(words.reduce((a, b) => a + (b - mean) ** 2, 0) / words.length) / mean;
    if (cv < WORDS_CV_MIN) problems.push({ kind: 'words', description: `各章字数几乎一样（变异系数 ${cv.toFixed(2)}）：按情节轻重让字数上下浮动三成` });
  }

  let run = 0;
  for (let i = 0; i < items.length; i++) {
    const ending = items[i]?.rhythm?.ending ?? null;
    const previous = items[i - 1]?.rhythm?.ending ?? null;
    run = ending !== null && ending === previous ? run + 1 : 1;
    if (ending !== null && run === ENDING_RUN) {
      problems.push({ kind: 'endings', description: `第 ${i - ENDING_RUN + 2} 到 ${i + 1} 章都用同一种收法：连续两章不要同一种章尾` });
      run = 0;
    }
  }

  const planned = items.filter((i) => i.rhythm !== null).length;
  if (planned >= items.length / 2 && items.length >= TRANSITION_WINDOW) {
    for (let start = 0; start + TRANSITION_WINDOW <= items.length; start++) {
      const window = items.slice(start, start + TRANSITION_WINDOW);
      if (window.some((i) => i.rhythm?.type === 'transition' || i.rhythm?.type === 'daily')) continue;
      problems.push({ kind: 'transitions', description: `第 ${start + 1} 到 ${start + TRANSITION_WINDOW} 章连着 ${TRANSITION_WINDOW} 章没有过渡或日常章：每五到八章安排一章缓一口气` });
      break;
    }
  }
  return problems;
}

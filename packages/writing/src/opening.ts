// 开篇打磨（需求 B81）的客观数字：纯函数。只作参考，交给模型诊断时一并给出，复诊后用来对比前后。
import { maskDialogue, visibleLength } from './prose';
import type { CastMember } from './types';

/** 一章开篇的数字。protagonistAt 是主角的名字（或别名）第一次出现之前有多少字，没出现时为 null。 */
export type OpeningMetrics = {
  readonly words: number;
  readonly protagonistAt: number | null;
  /** 对白（引号里的字）占全章字数的比例。 */
  readonly dialogueRatio: number;
  /** 前一千字里设定名（人物、地点等的名字与别名）出现的次数：太多说明一上来就堆设定。 */
  readonly namesInOpening: number;
  readonly longestParagraph: number;
};

/** 前一千字。 */
export const OPENING_WORDS = 1_000;

const countOf = (text: string, name: string): number => {
  if (name === '') return 0;
  let n = 0;
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + name.length)) n += 1;
  return n;
};

export function openingMetrics(paragraphs: readonly { readonly text: string }[], protagonist: CastMember | null, names: readonly string[]): OpeningMetrics {
  const text = paragraphs.map((p) => p.text).join('\n');
  const words = visibleLength(text);
  if (words === 0) return { words: 0, protagonistAt: null, dialogueRatio: 0, namesInOpening: 0, longestParagraph: 0 };
  const masked = maskDialogue(text);
  const dialogue = words - visibleLength(masked);
  let protagonistAt: number | null = null;
  if (protagonist !== null) {
    const first = [protagonist.name, ...protagonist.aliases]
      .map((n) => n.trim())
      .filter((n) => n !== '')
      .map((n) => text.indexOf(n))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    protagonistAt = first === undefined ? null : visibleLength(text.slice(0, first));
  }
  // 前一千个字（按可见字数截）。
  let cut = 0;
  for (let seen = 0; cut < text.length && seen < OPENING_WORDS; cut++) if (visibleLength(text[cut] ?? '') > 0) seen += 1;
  const opening = text.slice(0, cut);
  // 较长的名字先数并遮掉，“林相公”不再算一次“林”开头的别的名字。
  let rest = opening;
  let namesInOpening = 0;
  for (const name of [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))].sort((a, b) => b.length - a.length)) {
    namesInOpening += countOf(rest, name);
    rest = rest.split(name).join('□'.repeat(name.length));
  }
  return {
    words,
    protagonistAt,
    dialogueRatio: dialogue / words,
    namesInOpening,
    longestParagraph: Math.max(...paragraphs.map((p) => visibleLength(p.text))),
  };
}

/** 主角：前几章里名字（含别名）出现次数最多的人物，次数相同取先出现的；没有人物出现时为 null。 */
export function guessProtagonist(texts: readonly string[], cast: readonly CastMember[]): CastMember | null {
  const all = texts.join('\n');
  let best: { member: CastMember; count: number; first: number } | null = null;
  for (const member of cast) {
    const names = [member.name, ...member.aliases].map((n) => n.trim()).filter((n) => n !== '');
    const count = names.reduce((n, name) => n + countOf(all, name), 0);
    if (count === 0) continue;
    const first = Math.min(...names.map((n) => all.indexOf(n)).filter((i) => i >= 0));
    if (best === null || count > best.count || (count === best.count && first < best.first)) best = { member, count, first };
  }
  return best?.member ?? null;
}

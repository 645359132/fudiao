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

/**
 * 各个名字在文中出现的位置：较长的名字先找并遮掉，“张三丰”出现的地方不再算一次“张三”，“树林”里的“林”也不算一次别名“林”
 * 的……只在没有更长的名字盖住时算。返回每个名字（去掉空白与空名）的位置列表。
 */
function findNames(text: string, names: readonly string[]): ReadonlyMap<string, readonly number[]> {
  const found = new Map<string, number[]>();
  let rest = text;
  for (const name of [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))].sort((a, b) => b.length - a.length)) {
    const at: number[] = [];
    for (let i = rest.indexOf(name); i >= 0; i = rest.indexOf(name, i + name.length)) at.push(i);
    found.set(name, at);
    if (at.length > 0) rest = rest.split(name).join('□'.repeat(name.length));
  }
  return found;
}

export function openingMetrics(paragraphs: readonly { readonly text: string }[], protagonist: CastMember | null, names: readonly string[]): OpeningMetrics {
  const text = paragraphs.map((p) => p.text).join('\n');
  const words = visibleLength(text);
  if (words === 0) return { words: 0, protagonistAt: null, dialogueRatio: 0, namesInOpening: 0, longestParagraph: 0 };
  const masked = maskDialogue(text);
  const dialogue = words - visibleLength(masked);
  let protagonistAt: number | null = null;
  if (protagonist !== null) {
    const own = [protagonist.name, ...protagonist.aliases].map((n) => n.trim()).filter((n) => n !== '');
    // 和别的名字一起找：别人的长名字盖住的地方（“林舟”在“林舟之父”里）不算主角出场。
    const positions = findNames(text, [...names, ...own]);
    const first = own.flatMap((n) => positions.get(n) ?? []).sort((a, b) => a - b)[0];
    protagonistAt = first === undefined ? null : visibleLength(text.slice(0, first));
  }
  // 前一千个字（按可见字数截）。
  let cut = 0;
  for (let seen = 0; cut < text.length && seen < OPENING_WORDS; cut++) if (visibleLength(text[cut] ?? '') > 0) seen += 1;
  const opening = text.slice(0, cut);
  const namesInOpening = [...findNames(opening, names).values()].reduce((n, at) => n + at.length, 0);
  return {
    words,
    protagonistAt,
    dialogueRatio: dialogue / words,
    namesInOpening,
    longestParagraph: Math.max(...paragraphs.map((p) => visibleLength(p.text))),
  };
}

/**
 * 主角：前几章里名字（含别名）出现次数最多的人物，次数相同取先出现的；没有人物出现时为 null。
 * 名字互相包含时（“张三”与“张三丰”）按最长的算，“张三丰”出现十次不会让“张三”成为主角。
 */
export function guessProtagonist(texts: readonly string[], cast: readonly CastMember[]): CastMember | null {
  const all = texts.join('\n');
  const positions = findNames(
    all,
    cast.flatMap((m) => [m.name, ...m.aliases]),
  );
  let best: { member: CastMember; count: number; first: number } | null = null;
  for (const member of cast) {
    const at = [member.name, ...member.aliases].flatMap((n) => positions.get(n.trim()) ?? []);
    if (at.length === 0) continue;
    const first = Math.min(...at);
    if (best === null || at.length > best.count || (at.length === best.count && first < best.first)) best = { member, count: at.length, first };
  }
  return best?.member ?? null;
}

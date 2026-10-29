// 文风的程序检查（需求 B87，M8-01）：按 style.ts 的数字提出审核问题——最近几章用得太多的说法本章又用了、本章的高频实词与固定搭配、
// 句首模板、对话占比低于本章的目标、叙述句长太均匀、连续几章同一种收法、一段长对白在交代前情。
// 都是读者一眼看出“AI 写的”的证据（两个模型对《长夜问刀》的判定），所以归为 ai_tone 或 pacing，严重程度低，对话占比为中。
import { maskDialogue, MAX_HITS_PER_RULE, visibleLength } from './prose';
import { chapterStyle, dialogueMood, ENDING_KIND_LABEL, percent, type EndingKind } from './style';
import type { IssueAnchor, ParagraphText, ProgramIssue } from './types';

export type StyleCheckInput = {
  /** 设定的名字与别名：名字不算词。 */
  readonly names: readonly string[];
  /** 最近几章用得太多的实词与固定搭配（风格账本）。 */
  readonly overused: readonly string[];
  /** 最近几章用得太多的句首（风格账本）。 */
  readonly overusedOpenings: readonly string[];
  /** 前面几章的章尾方式，从远到近。 */
  readonly previousEndings: readonly EndingKind[];
  /** 本章对话占比的目标；null 为不检查。 */
  readonly dialogueTarget: number | null;
};

/** 两字的词在本章至少出现这么多次（并且每千字 1.6 次）才算用得太多；三字以上的说法 3 次（每千字 0.6 次）。 */
export const HIGH_TERM_MIN = { short: 8, long: 3 } as const;
const HIGH_TERM_PER_THOUSAND = { short: 1.6, long: 0.6 } as const;
/** 同一个句首在本章至少这么多句（并且每千字 1.2 句）。 */
export const OPENING_MIN = 6;
const OPENING_PER_THOUSAND = 1.2;
/** 对话占比低于目标的这个比例时提出问题；太短的章不查。 */
export const DIALOGUE_FLOOR = 0.6;
export const DIALOGUE_MIN_WORDS = 800;
/** 叙述句子的变异系数低于此、句子够多时算太均匀。 */
export const SENTENCE_CV_MIN = 0.35;
export const SENTENCE_MIN_COUNT = 40;
/** 对白至少这么多句、问句感叹与没说完的话合起来不到这个比例时，对白像在交代。 */
export const DIALOGUE_MOOD_SENTENCES = 15;
export const DIALOGUE_MOOD_MIN = 0.1;
/** 连续几章同一种收法。 */
export const ENDING_RUN = 3;
/** 一段对白长于这个字数、又带着交代前情的词时提示。 */
export const LONG_QUOTE_CHARS = 120;
const EXPOSITION = /当年|十年前|多年前|那时候|其实|早在|布局|真相|原来|说来话长|当初/u;

const issue = (kind: ProgramIssue['kind'], severity: ProgramIssue['severity'], anchor: IssueAnchor, description: string, suggestion: string): ProgramIssue => ({
  kind,
  severity,
  anchor,
  evidence: [],
  description,
  suggestion,
});

const whole = (p: ParagraphText): IssueAnchor => ({ paragraphId: p.id, paragraphVersion: p.version, start: 0, end: 0, quote: '' });
const at = (p: ParagraphText, start: number, length: number): IssueAnchor => ({ paragraphId: p.id, paragraphVersion: p.version, start, end: start + length, quote: p.text.slice(start, start + length) });

/** 对白以外第一次出现的位置与总次数。 */
function locate(paragraphs: readonly ParagraphText[], term: string): { readonly anchor: IssueAnchor; readonly count: number } | null {
  let first: IssueAnchor | null = null;
  let count = 0;
  for (const p of paragraphs) {
    const masked = maskDialogue(p.text);
    for (let i = masked.indexOf(term); i >= 0; i = masked.indexOf(term, i + term.length)) {
      count += 1;
      first ??= at(p, i, term.length);
    }
  }
  return first === null ? null : { anchor: first, count };
}

/** 以某个开头起句的第一处。 */
function locateHead(paragraphs: readonly ParagraphText[], head: string): IssueAnchor | null {
  for (const p of paragraphs) {
    const masked = maskDialogue(p.text);
    for (let i = masked.indexOf(head); i >= 0; i = masked.indexOf(head, i + 1)) {
      const before = masked.slice(0, i).replace(/[^\p{Script=Han}\p{P}]+$/u, '');
      if (before === '' || /[。！？；!?…]$/u.test(before)) return at(p, i, head.length);
    }
  }
  return null;
}

export function styleChecks(paragraphs: readonly ParagraphText[], input: StyleCheckInput): ProgramIssue[] {
  const filled = paragraphs.filter((p) => p.text.trim() !== '');
  const texts = filled.map((p) => p.text);
  const words = visibleLength(texts.join('\n'));
  const first = filled[0];
  const last = filled.at(-1);
  if (first === undefined || last === undefined || words === 0) return [];
  const issues: ProgramIssue[] = [];
  const reported: string[] = [];
  const overlaps = (term: string) => reported.some((r) => r.includes(term) || term.includes(r));
  const perThousand = words / 1000;
  const style = chapterStyle(texts, input.names);

  // 最近几章用得太多的说法，本章又用了。
  let hits = 0;
  for (const term of input.overused) {
    if (hits >= MAX_HITS_PER_RULE) break;
    const found = locate(filled, term);
    if (found === null) continue;
    hits += 1;
    reported.push(term);
    issues.push(issue('ai_tone', 'low', found.anchor, `“${term}”最近几章已经用得太多，本章又用了 ${found.count} 次`, '换一种说法或者删掉；是必须提到的东西时用别的词指代'));
  }

  // 固定搭配。
  hits = 0;
  for (const c of style.collocations) {
    if (hits >= MAX_HITS_PER_RULE) break;
    if (overlaps(c.term)) continue;
    const found = locate(filled, c.term);
    if (found === null) continue;
    hits += 1;
    reported.push(c.term);
    issues.push(issue('ai_tone', 'low', found.anchor, `“${c.term}”在本章重复了 ${c.count} 次`, '同一个动作或感觉第二次出现时换个写法，或者不写'));
  }

  // 本章的高频实词。
  hits = 0;
  for (const t of style.terms) {
    if (hits >= MAX_HITS_PER_RULE) break;
    const kind = t.term.length <= 2 ? 'short' : 'long';
    if (t.count < Math.max(HIGH_TERM_MIN[kind], Math.ceil(perThousand * HIGH_TERM_PER_THOUSAND[kind])) || overlaps(t.term)) continue;
    const found = locate(filled, t.term);
    if (found === null) continue;
    hits += 1;
    reported.push(t.term);
    issues.push(issue('ai_tone', 'low', found.anchor, `“${t.term}”在本章出现 ${t.count} 次`, '留最需要的一两处，其余换说法或删掉'));
  }

  // 句首模板：账本里的句首本章又用了两次以上，或本章自己有一个句首用得太多。
  hits = 0;
  const openings = style.openings;
  const threshold = Math.max(OPENING_MIN, Math.ceil(perThousand * OPENING_PER_THOUSAND));
  for (const o of openings) {
    if (hits >= MAX_HITS_PER_RULE) break;
    const stale = input.overusedOpenings.includes(o.term) && o.count >= 2;
    if (!stale && o.count < threshold) continue;
    const anchor = locateHead(filled, o.term);
    if (anchor === null) continue;
    hits += 1;
    issues.push(
      issue(
        'ai_tone',
        'low',
        anchor,
        stale ? `句子以“${o.term}……”开头最近几章已经用得太多，本章又用了 ${o.count} 次` : `本章有 ${o.count} 句都以“${o.term}……”开头`,
        '换主语、从动作或环境写起，或者把几句合成一句',
      ),
    );
  }

  // 对话占比。
  if (input.dialogueTarget !== null && words >= DIALOGUE_MIN_WORDS && style.dialogueRatio < input.dialogueTarget * DIALOGUE_FLOOR) {
    issues.push(
      issue('pacing', 'medium', whole(first), `本章对话只占 ${percent(style.dialogueRatio)}，低于本章的目标（约 ${percent(input.dialogueTarget)}）`, '把一部分叙述与心理描写改成人物之间的对话，让人物用自己的话推动情节'),
    );
  }
  // 对白几乎都是陈述句（HC3：人的话里问、叹与省略号多；Human or Not?：读者凭情绪认人）。
  const d = style.dialogue;
  if (d.sentences >= DIALOGUE_MOOD_SENTENCES && dialogueMood(d) < DIALOGUE_MOOD_MIN) {
    issues.push(
      issue(
        'pacing',
        'low',
        whole(first),
        `对白几乎都是陈述句：${d.sentences} 句里只有 ${d.question + d.exclamation + d.unfinished} 句是问句、感叹或没说完的话`,
        '让人物问、叹、说到一半被打断或答非所问；哪种情绪按人物与处境定，不堆感叹号',
      ),
    );
  }
  // 句长太均匀。
  if (style.sentences.count >= SENTENCE_MIN_COUNT && style.sentences.cv < SENTENCE_CV_MIN) {
    issues.push(issue('pacing', 'low', whole(first), `叙述的句子长短太均匀（变异系数 ${style.sentences.cv.toFixed(2)}）`, '紧张处用一句一顿的短句，铺陈处用一个长句连着写，让长短句交替'));
  }
  // 连续几章同一种收法。
  const recent = input.previousEndings.slice(-(ENDING_RUN - 1));
  if (recent.length === ENDING_RUN - 1 && recent.every((e) => e === style.ending)) {
    issues.push(issue('ai_tone', 'low', whole(last), `连续 ${ENDING_RUN} 章都以${ENDING_KIND_LABEL[style.ending]}收尾`, '换一种收法：一句对白、一个安静的画面、人物的一个决定或一点小幽默'));
  }
  // 一段长对白在交代前情。
  hits = 0;
  for (const p of filled) {
    if (hits >= MAX_HITS_PER_RULE) break;
    for (const m of p.text.matchAll(/[“「『]([^”」』]*)[”」』]/gu)) {
      const inner = m[1] ?? '';
      if (visibleLength(inner) < LONG_QUOTE_CHARS || !EXPOSITION.test(inner)) continue;
      hits += 1;
      issues.push(issue('pacing', 'low', at(p, m.index, Math.min(m[0].length, 40)), `一段 ${visibleLength(inner)} 字的对白在交代前情`, '人物在这个处境下说不了这么长的话：留一两句，其余靠动作、前文或别人的反应带出'));
      break;
    }
  }
  const order = new Map(filled.map((p, i) => [p.id, i]));
  return issues.sort((a, b) => (order.get(a.anchor.paragraphId) ?? 0) - (order.get(b.anchor.paragraphId) ?? 0) || a.anchor.start - b.anchor.start);
}

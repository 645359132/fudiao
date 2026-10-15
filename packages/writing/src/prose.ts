// 文字体检（需求 B74）：不需要模型、结果确定的检查——AI 常见句式、生成退化（复读、截断）与写作材料泄漏进正文。
// 规则的思路参考 oh-story-claudecode（MIT）的 story-deslop，按复调的段落与审核问题重写。
// 引号里的对白不查句式与泄漏：人物说话可以这样说，作家人物也可以谈“伏笔”。
import type { IssueKind, ParagraphText, ProgramIssue } from './types';

/** 每条规则在一章里最多报几处，免得同一种问题刷满审核列表。 */
export const MAX_HITS_PER_RULE = 5;

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
];
/** 遮住对白用的字：不会被任何规则匹配，长度不变，位置仍对得上原文。 */
const MASK = '⁣';

/** 引号里的文字换成遮罩字（引号本身保留）。没有配对的引号不遮。 */
export function maskDialogue(text: string): string {
  const out = [...text];
  let i = 0;
  while (i < out.length) {
    const pair = QUOTE_PAIRS.find(([open]) => open === out[i]);
    if (pair === undefined) {
      i += 1;
      continue;
    }
    const close = out.indexOf(pair[1], i + 1);
    if (close < 0) break;
    for (let j = i + 1; j < close; j++) out[j] = MASK;
    i = close + 1;
  }
  return out.join('');
}

/** 汉字、字母与数字的个数（标点与空白不算）。 */
export const visibleLength = (text: string): number => (text.match(/[\p{Script=Han}A-Za-z0-9]/gu) ?? []).length;

type Hit = { readonly p: ParagraphText; readonly start: number; readonly quote: string };

const issue = (kind: IssueKind, severity: ProgramIssue['severity'], hit: Hit, description: string, suggestion: string): ProgramIssue => ({
  kind,
  severity,
  anchor: { paragraphId: hit.p.id, paragraphVersion: hit.p.version, start: hit.start, end: hit.start + hit.quote.length, quote: hit.quote },
  evidence: [],
  description,
  suggestion,
});

/** 在遮住对白的文字里按正则找，引文取原文。 */
function find(paragraphs: readonly ParagraphText[], pattern: RegExp, accept: (p: ParagraphText, start: number, match: string) => boolean = () => true): Hit[] {
  const hits: Hit[] = [];
  for (const p of paragraphs) {
    const masked = maskDialogue(p.text);
    for (const m of masked.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
      const start = m.index;
      if (!accept(p, start, m[0])) continue;
      hits.push({ p, start, quote: p.text.slice(start, start + m[0].length) });
    }
  }
  return hits;
}

type Rule = {
  readonly kind: IssueKind;
  readonly severity: ProgramIssue['severity'];
  readonly pattern: RegExp;
  readonly accept?: (p: ParagraphText, start: number, match: string) => boolean;
  readonly description: string;
  readonly suggestion: string;
};

const RULES: readonly Rule[] = [
  {
    kind: 'ai_tone',
    severity: 'low',
    // “不是 A，而是 B”“不是 A，是 B”；“是不是”“不是吗”不算。
    pattern: /不是[^，。！？；“”\n]{1,30}[，,]\s*(?:而)?是/u,
    accept: (p, start) => p.text[start - 1] !== '是',
    description: '“不是……而是……”的对照句式，AI 腔常见',
    suggestion: '直接写成立的那一面，或者用人物的动作、选择把差别呈现出来',
  },
  {
    kind: 'ai_tone',
    severity: 'low',
    pattern: /(?:没有?[^，。！？；\n]{1,10}[，,]){3,}/u,
    description: '连着三个以上“没……”的否定排比',
    suggestion: '只留最要紧的一处，或者换成人物实际做了什么',
  },
  {
    kind: 'ai_tone',
    severity: 'low',
    pattern: /[她他它]们?不知道的是|殊不知|之所以[^。！？\n]{1,30}是因为/u,
    description: '全知的解释式旁白，替读者把话说透了',
    suggestion: '删去解释，让读者从情节里自己看出来',
  },
  {
    kind: 'ai_tone',
    severity: 'high',
    pattern: /细纲|情节点|卷纲|目标情绪|章首钩子|章尾钩子|字数目标|本章目标|出场人物[：:]/u,
    description: '写作材料里的用语出现在正文中（大纲、情节点之类）',
    suggestion: '删去这些词，按情节写成正文',
  },
  {
    kind: 'ai_tone',
    severity: 'high',
    pattern: /作为(?:一个|一名)?(?:AI|人工智能|语言模型|AI ?助手)(?![^，。！？\n]{0,2}(?:研究|技术|公司|产品))|我(?:无法|不能)(?:继续)?(?:为你|帮你)?(?:写|创作|生成|续写)/u,
    description: '模型的自称或拒绝出现在正文中',
    suggestion: '删去这一句，必要时让写手重写这一段',
  },
  {
    kind: 'ai_tone',
    severity: 'high',
    pattern: /[（(](?:此处|以下|这里|下文|后续)?\s*(?:省略|略)[^）)]{0,20}[）)]|未完待续|TODO|占位符|�/u,
    description: '占位或省略的标记出现在正文中，这一段没有写完',
    suggestion: '把省略的部分写出来，或让写手重写这一段',
  },
  {
    kind: 'ai_tone',
    severity: 'high',
    pattern: /^\s*(?:Sure|Certainly|Of course|Here(?:'s| is)|As an AI)\b/iu,
    description: '模型对提问者说的话混进了正文',
    suggestion: '删去这一句',
  },
];

/** 章尾的总结或预告式收束：只看最后几段。 */
const TRAILER = /没人知道|谁也不知道|一切才刚刚开始|才刚刚开始|拉开了?序幕|命运的齿轮|新的篇章|注定[^。！？\n]{0,8}不平凡|一切都将不同/u;
const TRAILER_CHARS = 600;

/** 比喻词：一章里太密时提示。 */
const SIMILE = /仿佛|宛如|如同|犹如|好像|像是/gu;
const SIMILE_MIN = 7;
const SIMILE_PER_THOUSAND = 3;

const SENTENCE_END = /[。！？!?…”"』」）)】]$/u;
const REPEAT_MIN_LENGTH = 12;
const REPEAT_MIN_COUNT = 3;
const DUPLICATE_MIN_LENGTH = 8;

/** 同一长句（对白以外）在一章里出现三次以上；相邻两段一字不差。都是生成退化的迹象。 */
function repetition(paragraphs: readonly ParagraphText[]): ProgramIssue[] {
  const issues: ProgramIssue[] = [];
  const seen = new Map<string, { hit: Hit; count: number }>();
  for (const p of paragraphs) {
    const masked = maskDialogue(p.text);
    for (const m of masked.matchAll(/[^。！？!?]+[。！？!?]?/gu)) {
      const sentence = m[0].trim();
      if (sentence.includes(MASK) || visibleLength(sentence) < REPEAT_MIN_LENGTH) continue;
      const key = sentence.replace(/\s+/g, '');
      const entry = seen.get(key);
      if (entry === undefined) seen.set(key, { hit: { p, start: m.index + m[0].indexOf(sentence), quote: sentence }, count: 1 });
      else entry.count += 1;
    }
  }
  for (const { hit, count } of seen.values()) {
    if (count < REPEAT_MIN_COUNT) continue;
    issues.push(issue('pacing', 'high', hit, `同一句话在本章出现了 ${count} 次`, '保留一处，其余删去或改写；多半是生成时在原地打转'));
  }
  paragraphs.forEach((p, i) => {
    const before = paragraphs[i - 1];
    const text = p.text.trim();
    if (before === undefined || text !== before.text.trim() || visibleLength(text) < DUPLICATE_MIN_LENGTH) return;
    issues.push(issue('pacing', 'high', { p, start: 0, quote: p.text }, '这一段与上一段一字不差', '删去重复的一段'));
  });
  return issues;
}

/** 最后一段没有以句末标点结束：多半是输出被截断。 */
function truncation(paragraphs: readonly ParagraphText[]): ProgramIssue[] {
  const last = [...paragraphs].reverse().find((p) => p.text.trim() !== '');
  if (last === undefined) return [];
  const text = last.text.trimEnd();
  if (SENTENCE_END.test(text)) return [];
  // 引文取最后一个标点之后没写完的那一截（最多 20 字）。
  const cut = Math.max(...[...'，。！？；：、'].map((c) => text.lastIndexOf(c)));
  const tail = text.slice(Math.max(cut + 1, text.length - 20));
  return [issue('ai_tone', 'high', { p: last, start: text.length - tail.length, quote: tail }, '本章最后一段没有写完（可能是输出被截断）', '把这一段写完，或让写手接着写')];
}

/** 章尾用总结、预告收束。 */
function trailer(paragraphs: readonly ParagraphText[]): ProgramIssue[] {
  const tail: ParagraphText[] = [];
  let length = 0;
  for (const p of [...paragraphs].reverse()) {
    if (length >= TRAILER_CHARS) break;
    tail.unshift(p);
    length += p.text.length;
  }
  return find(tail, TRAILER)
    .slice(0, 1)
    .map((hit) => issue('ai_tone', 'medium', hit, '章尾用总结或预告收束，像在替读者下结论', '停在动作、对白或一个具体的悬念上，不要总结'));
}

/** 比喻太密（对白以外）。锚在第一处。 */
function similes(paragraphs: readonly ParagraphText[]): ProgramIssue[] {
  const hits = find(paragraphs, SIMILE);
  const chars = paragraphs.reduce((n, p) => n + visibleLength(maskDialogue(p.text)), 0);
  const first = hits[0];
  if (first === undefined || hits.length < SIMILE_MIN || (hits.length * 1000) / Math.max(chars, 1) < SIMILE_PER_THOUSAND) return [];
  return [issue('ai_tone', 'low', { ...first, quote: '' }, `比喻用得太密：本章“仿佛、好像、如同”之类出现 ${hits.length} 次`, '留下最贴切的一两处，其余直接写')];
}

/** 文字体检的全部问题，按段落顺序。 */
export function proseChecks(paragraphs: readonly ParagraphText[]): ProgramIssue[] {
  // 同一规则在一段里只报第一处。
  const firstPerParagraph = (hits: Hit[]) => hits.filter((h, i) => hits.findIndex((x) => x.p.id === h.p.id) === i);
  const ruled = RULES.flatMap((r) =>
    firstPerParagraph(find(paragraphs, r.pattern, r.accept))
      .slice(0, MAX_HITS_PER_RULE)
      .map((hit) => issue(r.kind, r.severity, hit, r.description, r.suggestion)),
  );
  const all = [...ruled, ...repetition(paragraphs), ...trailer(paragraphs), ...similes(paragraphs), ...truncation(paragraphs)];
  const order = new Map(paragraphs.map((p, i) => [p.id, i]));
  return all.sort((a, b) => (order.get(a.anchor.paragraphId) ?? 0) - (order.get(b.anchor.paragraphId) ?? 0) || a.anchor.start - b.anchor.start);
}

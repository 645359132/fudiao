// 文字体检（需求 B74）：不需要模型、结果确定的检查——AI 常见句式、生成退化（复读、截断）与写作材料泄漏进正文。
// 规则的思路参考 oh-story-claudecode（MIT）的 story-deslop，以及 Humanizer-zh 与 blader/humanizer（都是 MIT）
// 列出的中文 AI 痕迹（对照壳子、堆叠的限定、“进行＋动词”、重复开头、破折号当万能连接），按复调的段落与审核问题重写。
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
    // “不仅是 A，更是 B”“与其说 A，不如说 B”：和“不是……而是……”一样，是为了抬高后一半。
    pattern: /不仅仅?是[^，。！？；“”\n]{1,30}[，,]\s*更是|与其说[^，。！？；“”\n]{1,30}[，,]\s*不如说/u,
    description: '“不仅是……更是……”“与其说……不如说……”的对照句式，AI 腔常见',
    suggestion: '直接写成立的那一面，不用否定或让步的一半来抬高它',
  },
  {
    kind: 'ai_tone',
    severity: 'low',
    pattern: /进行(?:了|着|过)?(?:一[次场番阵])?(?:深呼吸|呼吸|思考|交流|沟通|观察|讨论|对话|交谈|调查|分析|反思|回忆|检查|确认|比较|搜索|搜寻|询问|解释|说明|描述|试探|较量)/u,
    description: '“进行＋动词”的冗长说法',
    suggestion: '直接用动词：“进行了一次深呼吸”写成“深吸一口气”',
  },
  {
    kind: 'ai_tone',
    severity: 'low',
    pattern: /(?:似乎|好像|仿佛|大概|也许)(?:有些|有点|有一种|某种)|某种(?:难以|说不清|说不出|无法)[^，。！？\n]{0,6}的/u,
    description: '堆叠的限定（“似乎有些”“仿佛有一种”“某种难以言说的”），把话说虚了',
    suggestion: '留一个限定或者都删掉，写出具体是什么',
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
const TRAILER = /没人知道|谁也不知道|一切才刚刚开始|才刚刚开始|拉开了?序幕|命运的齿轮|新的篇章|注定[^。！？\n]{0,8}不平凡|一切都将不同|远远没有结束|故事还在继续|这只是一个开始/u;
const TRAILER_CHARS = 600;

/** 比喻词：一章里太密时提示。 */
const SIMILE = /仿佛|宛如|如同|犹如|好像|像是/gu;
const SIMILE_MIN = 7;
const SIMILE_PER_THOUSAND = 3;

/** 破折号：一章里太密时提示（解释、插入与转折确实需要的几处不算多）。 */
const DASH = /——|—/gu;
const DASH_MIN = 6;
const DASH_PER_THOUSAND = 2;
/** 接连几句以同样的开头起句：两个字的开头（人名、名词）三句就算；单个代词（“他……。他……。”）平常也多，四句才算。 */
const OPENING_RUN = 3;
const PRONOUN_RUN = 4;
const PRONOUNS = new Set(['他', '她', '它', '我', '你']);

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

/** 破折号太密（对白以外）。锚在第一处。 */
function dashes(paragraphs: readonly ParagraphText[]): ProgramIssue[] {
  const hits = find(paragraphs, DASH);
  const chars = paragraphs.reduce((n, p) => n + visibleLength(maskDialogue(p.text)), 0);
  const first = hits[0];
  if (first === undefined || hits.length < DASH_MIN || (hits.length * 1000) / Math.max(chars, 1) < DASH_PER_THOUSAND) return [];
  return [issue('ai_tone', 'low', { ...first, quote: '' }, `破折号用得太密：本章出现 ${hits.length} 处`, '只留解释、插入或转折确实需要的几处，其余换成句号、逗号或改写')];
}

/** 一段里接连几句都以同样的词起头（“他……。他……。他……。他……”）：按公式排的节奏。对白以外；锚在这一串的第一句。 */
function repeatedOpenings(paragraphs: readonly ParagraphText[]): ProgramIssue[] {
  const issues: ProgramIssue[] = [];
  const han = /^[\p{Script=Han}]{2}$/u;
  for (const p of paragraphs) {
    const masked = maskDialogue(p.text);
    const sentences = [...masked.matchAll(/[^。！？!?]+[。！？!?]?/gu)].map((m) => ({ start: m.index, text: m[0] }));
    let run: { readonly start: number; readonly head: string }[] = [];
    const flush = () => {
      const first = run[0];
      if (first !== undefined && run.length >= (PRONOUNS.has(first.head) ? PRONOUN_RUN : OPENING_RUN)) {
        const sentence = sentences.find((s) => s.start === first.start)?.text.trim() ?? first.head;
        issues.push(issue('ai_tone', 'low', { p, start: first.start, quote: p.text.slice(first.start, first.start + Math.min(sentence.length, 20)) }, `接连 ${run.length} 句都以“${first.head}”起头`, '合并成一句，或者换主语、从动作写起'));
      }
      run = [];
    };
    for (const s of sentences) {
      const body = s.text.replace(/^\s+/, '');
      const head = PRONOUNS.has(body.slice(0, 1)) ? body.slice(0, 1) : body.slice(0, 2);
      if (!han.test(head) && !PRONOUNS.has(head)) {
        flush();
        continue;
      }
      if (run[0]?.head !== head) flush();
      run.push({ start: s.start + (s.text.length - body.length), head });
    }
    flush();
  }
  return issues.slice(0, MAX_HITS_PER_RULE);
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
  const all = [...ruled, ...repetition(paragraphs), ...repeatedOpenings(paragraphs), ...trailer(paragraphs), ...similes(paragraphs), ...dashes(paragraphs), ...truncation(paragraphs)];
  const order = new Map(paragraphs.map((p, i) => [p.id, i]));
  return all.sort((a, b) => (order.get(a.anchor.paragraphId) ?? 0) - (order.get(b.anchor.paragraphId) ?? 0) || a.anchor.start - b.anchor.start);
}

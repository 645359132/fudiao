// 审核的程序检查（需求 B64）：不需要模型就能确定的问题，先于模型审核运行。
// 结果都定位到段落；针对整章的问题锚在相关段落上，引文为空。
import type { CastMember, ChapterOrder, ForeshadowItem, IssueAnchor, ParagraphText, ProgramIssue } from './types';
import { proseChecks } from './prose';

/** 揭晓内容短于此长度时不做字面检查：太短的词组在正文里出现未必是说破，交给模型审核。 */
export const MIN_REVEAL_LENGTH = 6;

function occurrences(text: string, phrase: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(phrase); i >= 0; i = text.indexOf(phrase, i + phrase.length)) at.push(i);
  return at;
}

const anchorAt = (p: ParagraphText, start: number, quote: string): IssueAnchor => ({
  paragraphId: p.id,
  paragraphVersion: p.version,
  start,
  end: start + quote.length,
  quote,
});

const wholeParagraph = (p: ParagraphText): IssueAnchor => ({ paragraphId: p.id, paragraphVersion: p.version, start: 0, end: 0, quote: '' });

/** 规避表达（B37）的每一处命中。 */
export function avoidPhraseHits(paragraphs: readonly ParagraphText[], phrases: readonly string[]): ProgramIssue[] {
  const wanted = [...new Set(phrases.map((p) => p.trim()).filter((p) => p !== ''))];
  const hits: { p: ParagraphText; start: number; phrase: string }[] = [];
  for (const p of paragraphs) {
    for (const phrase of wanted) for (const start of occurrences(p.text, phrase)) hits.push({ p, start, phrase });
  }
  hits.sort((a, b) => paragraphs.indexOf(a.p) - paragraphs.indexOf(b.p) || a.start - b.start);
  return hits.map(({ p, start, phrase }) => ({
    kind: 'ai_tone',
    severity: 'low',
    anchor: anchorAt(p, start, phrase),
    evidence: [],
    description: `命中规避表达“${phrase}”`,
    suggestion: '换成这个人物此刻具体的动作、神情或细节',
  }));
}

/** 还不能说破的伏笔，揭晓内容原样出现在正文中。 */
export function revealLeaks(paragraphs: readonly ParagraphText[], mustNotReveal: readonly ForeshadowItem[]): ProgramIssue[] {
  const issues: ProgramIssue[] = [];
  for (const f of mustNotReveal) {
    const reveal = f.reveal.trim();
    if (reveal.length < MIN_REVEAL_LENGTH) continue;
    for (const p of paragraphs) {
      for (const start of occurrences(p.text, reveal)) {
        issues.push({
          kind: 'foreshadow',
          severity: 'high',
          anchor: anchorAt(p, start, reveal),
          evidence: [{ type: 'foreshadow', id: f.id }],
          description: `伏笔“${f.title}”的揭晓内容在计划回收之前被说破`,
          suggestion: '只写现象或线索，把揭晓留到计划回收的章节',
        });
      }
    }
  }
  return issues;
}

/** 写到计划回收的章节或之后，伏笔仍未回收。锚在本章最后一段。 */
export function overdueForeshadows(chapterId: string, paragraphs: readonly ParagraphText[], foreshadows: readonly ForeshadowItem[], order: ChapterOrder): ProgramIssue[] {
  const last = paragraphs.at(-1);
  const here = order.get(chapterId);
  if (last === undefined || here === undefined) return [];
  return foreshadows
    .filter((f) => {
      if (f.status !== 'planned' && f.status !== 'planted') return false;
      const payoff = f.payoffChapterId === null ? undefined : order.get(f.payoffChapterId);
      return payoff !== undefined && payoff <= here;
    })
    .map((f) => ({
      kind: 'foreshadow',
      severity: 'medium',
      anchor: wholeParagraph(last),
      evidence: [{ type: 'foreshadow', id: f.id }],
      description: `伏笔“${f.title}”计划在本章或之前回收，账本中仍未回收`,
      suggestion: '在本章回收，或在伏笔账本中改期、标为已回收或废弃',
    }));
}

/** 章节计划中的人物，名字与别名都没有在本章出现。锚在第一段。 */
export function missingCast(paragraphs: readonly ParagraphText[], cast: readonly CastMember[]): ProgramIssue[] {
  const first = paragraphs[0];
  if (first === undefined) return [];
  const text = paragraphs.map((p) => p.text).join('\n');
  return cast
    .filter((c) => ![c.name, ...c.aliases].some((n) => n.trim() !== '' && text.includes(n)))
    .map((c) => ({
      kind: 'off_plan',
      severity: 'low',
      anchor: wholeParagraph(first),
      evidence: [{ type: 'entity', id: c.id }],
      description: `章节计划中的“${c.name}”没有在本章出场`,
      suggestion: '让他出场，或修改章节计划',
    }));
}

export type ProgramCheckInput = {
  readonly chapterId: string;
  readonly paragraphs: readonly ParagraphText[];
  readonly avoidPhrases: readonly string[];
  readonly mustNotReveal: readonly ForeshadowItem[];
  readonly foreshadows: readonly ForeshadowItem[];
  readonly order: ChapterOrder;
  readonly cast: readonly CastMember[];
};

export function runProgramChecks(input: ProgramCheckInput): ProgramIssue[] {
  return [
    ...avoidPhraseHits(input.paragraphs, input.avoidPhrases),
    ...revealLeaks(input.paragraphs, input.mustNotReveal),
    ...overdueForeshadows(input.chapterId, input.paragraphs, input.foreshadows, input.order),
    ...missingCast(input.paragraphs, input.cast),
    // 文字体检（B74）：AI 常见句式、生成退化与写作材料泄漏。
    ...proseChecks(input.paragraphs),
  ];
}

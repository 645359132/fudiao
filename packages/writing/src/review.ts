// 模型审核输出的定位（需求 B64）：模型用标签指代段落与依据，这里换回段落标识、版本与依据标识。
// 定位不到原文、依据不存在的问题丢弃（模型编出来的引文与依据不能交给作者），并给出原因。
// 说明与建议里照抄的标签换成段落开头与依据的名称（M6-08 第 5 项），作者读到的不是 P29、E3。
import { paragraphMention, replaceLabels } from './labels';
import type { IssueAnchor, IssueEvidence, IssueKind, ParagraphText, ProgramIssue } from './types';

/** 模型写出的一条问题：paragraph 是段落标签（P1、P2……），evidence 是依据的标签。 */
export type ModelIssueDraft = {
  readonly paragraph: string;
  readonly quote: string;
  readonly kind: IssueKind;
  readonly severity: 'high' | 'medium' | 'low';
  readonly evidence: readonly string[];
  readonly description: string;
  readonly suggestion: string;
};

export const paragraphLabel = (index: number): string => `P${index + 1}`;

export type ReviewRefs = {
  /** 本章的段落，按顺序；第 i 段的标签是 paragraphLabel(i)。 */
  readonly paragraphs: readonly ParagraphText[];
  /** 提示词中列出的依据：标签 → 依据。段落标签不必列入。 */
  readonly evidence: ReadonlyMap<string, IssueEvidence>;
  /** 依据标签在说明里的称呼（例如 E1 → 钱四）；本章段落的标签自动换成段落开头，不必列入。 */
  readonly names?: ReadonlyMap<string, string>;
};

export type DroppedIssue = {
  readonly reason: 'unknown_paragraph' | 'quote_not_found' | 'unknown_evidence' | 'empty' | 'duplicate';
  readonly draft: ModelIssueDraft;
};

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['“', '”'],
  ['"', '"'],
  ['「', '」'],
  ['『', '』'],
  ['‘', '’'],
];

/** 引文在段中的位置；模型常在引文外多包一层引号，原样找不到时去掉一层再找。 */
function locate(text: string, quote: string): { start: number; quote: string } | null {
  const trimmed = quote.trim();
  const candidates = [trimmed];
  for (const [open, close] of QUOTE_PAIRS) {
    if (trimmed.length > open.length + close.length && trimmed.startsWith(open) && trimmed.endsWith(close)) candidates.push(trimmed.slice(open.length, -close.length).trim());
  }
  for (const candidate of candidates) {
    const start = candidate === '' ? -1 : text.indexOf(candidate);
    if (start >= 0) return { start, quote: candidate };
  }
  return null;
}

const sameSpot = (a: { kind: IssueKind; anchor: IssueAnchor }, b: { kind: IssueKind; anchor: IssueAnchor }) =>
  a.kind === b.kind &&
  a.anchor.paragraphId === b.anchor.paragraphId &&
  a.anchor.paragraphVersion === b.anchor.paragraphVersion &&
  a.anchor.quote === b.anchor.quote;

export function resolveModelIssues(drafts: readonly ModelIssueDraft[], refs: ReviewRefs): { issues: ProgramIssue[]; dropped: DroppedIssue[] } {
  const byLabel = new Map(refs.paragraphs.map((p, i) => [paragraphLabel(i), p]));
  const names = new Map([...refs.paragraphs.map((p, i) => [paragraphLabel(i), paragraphMention(p.text, i)] as const), ...(refs.names ?? [])]);
  const issues: ProgramIssue[] = [];
  const dropped: DroppedIssue[] = [];
  for (const draft of drafts) {
    const paragraph = byLabel.get(draft.paragraph.trim().toUpperCase());
    if (paragraph === undefined) {
      dropped.push({ reason: 'unknown_paragraph', draft });
      continue;
    }
    const located = draft.quote.trim() === '' ? { start: 0, quote: '' } : locate(paragraph.text, draft.quote);
    if (located === null) {
      dropped.push({ reason: 'quote_not_found', draft });
      continue;
    }
    const evidence: IssueEvidence[] = [];
    let unknown = false;
    for (const label of draft.evidence) {
      const key = label.trim();
      const other = byLabel.get(key.toUpperCase());
      const item = refs.evidence.get(key) ?? (other === undefined ? undefined : ({ type: 'paragraph', id: other.id } as const));
      if (item === undefined) {
        unknown = true;
        break;
      }
      if (!evidence.some((e) => e.type === item.type && e.id === item.id)) evidence.push(item);
    }
    if (unknown) {
      dropped.push({ reason: 'unknown_evidence', draft });
      continue;
    }
    if (draft.description.trim() === '') {
      dropped.push({ reason: 'empty', draft });
      continue;
    }
    const issue: ProgramIssue = {
      kind: draft.kind,
      severity: draft.severity,
      anchor: {
        paragraphId: paragraph.id,
        paragraphVersion: paragraph.version,
        start: located.start,
        end: located.start + located.quote.length,
        quote: located.quote,
      },
      evidence,
      description: replaceLabels(draft.description.trim(), names),
      suggestion: replaceLabels(draft.suggestion.trim(), names),
    };
    if (issues.some((i) => sameSpot(i, issue) && (issue.anchor.quote !== '' || i.description === issue.description))) {
      dropped.push({ reason: 'duplicate', draft });
      continue;
    }
    issues.push(issue);
  }
  return { issues, dropped };
}

/**
 * 去掉作者已经处理过（忽略、已修改、已交写手）的问题：同一段同一版本、同一类、同一处引文。
 * 针对整段的问题没有引文，按说明区分。段落改过之后版本不同，问题会重新提出。
 */
export function dropHandled<T extends { readonly kind: IssueKind; readonly anchor: IssueAnchor; readonly description: string }>(
  issues: readonly T[],
  handled: readonly { readonly kind: IssueKind; readonly anchor: IssueAnchor; readonly description: string }[],
): T[] {
  return issues.filter((issue) => !handled.some((h) => sameSpot(h, issue) && (issue.anchor.quote !== '' || h.description === issue.description)));
}

/** 重新定位的结果：有一条待处理的问题说的就是这一处（程序检查重新标出、换了标识）；锚点挪到现在的段落；或者已经定位不到。 */
export type Relocation =
  | { readonly kind: 'pending'; readonly id: string }
  | { readonly kind: 'moved'; readonly anchor: IssueAnchor }
  | { readonly kind: 'gone'; readonly reason: string };

/**
 * 一键交给写手修订时（B64 补充），前一条修订改了段落，后面的问题已经过期：在本章现在的段落里重新找它。
 * 引文优先在原来那一段里找（离原位置最近的一处），找不到再在全章找，只有一处时才算定位到；没有引文的问题（针对整段）
 * 跟着原来那一段走。定位到之后，有待处理的问题说的是同一处（同一类、同一段、同一引文，没有引文时同一说明）就用它；
 * regenerated 的问题（程序检查）每次修订后会重新检查、重新标出，没有重新标出就是已经改掉了；
 * 锚点没有动过却过期了，是这一章重新审核过、问题换成了新的。依据过期与否由调用方先判断。
 */
export function relocateIssue(
  issue: { readonly kind: IssueKind; readonly anchor: IssueAnchor; readonly description: string; readonly regenerated: boolean },
  paragraphs: readonly ParagraphText[],
  pending: readonly { readonly id: string; readonly kind: IssueKind; readonly anchor: IssueAnchor; readonly description: string }[],
): Relocation {
  const { quote } = issue.anchor;
  let anchor: IssueAnchor;
  if (quote === '') {
    const same = paragraphs.find((p) => p.id === issue.anchor.paragraphId);
    if (same === undefined) return { kind: 'gone', reason: '问题所在的段落已经不在了' };
    anchor = { paragraphId: same.id, paragraphVersion: same.version, start: 0, end: 0, quote: '' };
  } else {
    const same = paragraphs.find((p) => p.id === issue.anchor.paragraphId && p.text.includes(quote));
    const hits = same !== undefined ? [same] : paragraphs.filter((p) => p.text.includes(quote));
    if (hits.length === 0) return { kind: 'gone', reason: '修订后找不到这处原文了（多半已经一并改掉）' };
    if (hits.length > 1) return { kind: 'gone', reason: '这处原文在本章有好几处，定位不准' };
    const at = hits[0]!;
    let start = at.text.indexOf(quote);
    for (let i = start; i >= 0; i = at.text.indexOf(quote, i + 1)) {
      if (Math.abs(i - issue.anchor.start) < Math.abs(start - issue.anchor.start)) start = i;
    }
    anchor = { paragraphId: at.id, paragraphVersion: at.version, start, end: start + quote.length, quote };
  }
  const match = pending.find(
    (p) => p.kind === issue.kind && p.anchor.paragraphId === anchor.paragraphId && p.anchor.quote === quote && (quote !== '' || p.description === issue.description),
  );
  if (match !== undefined) return { kind: 'pending', id: match.id };
  if (issue.regenerated) return { kind: 'gone', reason: '修订后重新检查，没有再标出这一处（多半已经一并改掉）' };
  if (anchor.paragraphId === issue.anchor.paragraphId && anchor.paragraphVersion === issue.anchor.paragraphVersion) {
    return { kind: 'gone', reason: '这一章重新审核过，这条问题已经换成新的' };
  }
  return { kind: 'moved', anchor };
}

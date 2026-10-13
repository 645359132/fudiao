import { describe, expect, it } from 'vitest';
import { dropHandled, paragraphLabel, resolveModelIssues, type ModelIssueDraft, type ReviewRefs } from './review';

const refs: ReviewRefs = {
  paragraphs: [
    { id: 'pa', version: 3, text: '林舟推开当铺的门。' },
    { id: 'pb', version: 1, text: '钱四说：“这玉是你父亲的遗物吧。”' },
  ],
  evidence: new Map([
    ['E1', { type: 'entity', id: 'ent-lin' }],
    ['S1', { type: 'foreshadow', id: 'fs-jade' }],
    ['plan', { type: 'plan', id: 'ch-1' }],
  ]),
};

const draft = (over: Partial<ModelIssueDraft>): ModelIssueDraft => ({
  paragraph: 'P2',
  quote: '这玉是你父亲的遗物吧',
  kind: 'foreshadow',
  severity: 'high',
  evidence: ['S1'],
  description: '提前说破了玉佩的来历',
  suggestion: '只让钱四多看一眼',
  ...over,
});

describe('模型审核问题的定位', () => {
  it('段落标签从 P1 起', () => {
    expect([0, 1, 9].map(paragraphLabel)).toEqual(['P1', 'P2', 'P10']);
  });

  it('标签换回段落标识与版本，引文定位到段内下标，依据换回标识', () => {
    const { issues, dropped } = resolveModelIssues([draft({})], refs);
    expect(dropped).toEqual([]);
    expect(issues).toEqual([
      {
        kind: 'foreshadow',
        severity: 'high',
        anchor: { paragraphId: 'pb', paragraphVersion: 1, start: 5, end: 15, quote: '这玉是你父亲的遗物吧' },
        evidence: [{ type: 'foreshadow', id: 'fs-jade' }],
        description: '提前说破了玉佩的来历',
        suggestion: '只让钱四多看一眼',
      },
    ]);
  });

  it('引文外面多包了一层引号、首尾有空白时仍能定位；依据可以是本章的其他段落', () => {
    const { issues } = resolveModelIssues([draft({ paragraph: ' p1 ', quote: ' “推开当铺的门” ', kind: 'pacing', evidence: ['P2', 'E1', 'E1'] })], refs);
    expect(issues[0]?.anchor).toEqual({ paragraphId: 'pa', paragraphVersion: 3, start: 2, end: 8, quote: '推开当铺的门' });
    expect(issues[0]?.evidence).toEqual([
      { type: 'paragraph', id: 'pb' },
      { type: 'entity', id: 'ent-lin' },
    ]);
  });

  it('没有引文的问题针对整段，锚在段落上', () => {
    const { issues } = resolveModelIssues([draft({ quote: '', kind: 'off_plan', evidence: ['plan'] })], refs);
    expect(issues[0]?.anchor).toEqual({ paragraphId: 'pb', paragraphVersion: 1, start: 0, end: 0, quote: '' });
  });

  it('段落不存在、引文在该段中找不到、依据不存在、没有说明的问题丢弃，并给出原因', () => {
    const drafts = [
      draft({ paragraph: 'P9' }),
      draft({ quote: '正文里没有这句话' }),
      draft({ evidence: ['S1', 'F7'] }),
      draft({ description: '  ' }),
      draft({}),
    ];
    const { issues, dropped } = resolveModelIssues(drafts, refs);
    expect(issues).toHaveLength(1);
    expect(dropped.map((d) => d.reason)).toEqual(['unknown_paragraph', 'quote_not_found', 'unknown_evidence', 'empty']);
    expect(dropped[1]?.draft.quote).toBe('正文里没有这句话');
  });

  it('同一段同一处同一类的问题只留第一条', () => {
    const { issues, dropped } = resolveModelIssues([draft({}), draft({ description: '换了个说法' }), draft({ kind: 'pov_leak' })], refs);
    expect(issues.map((i) => i.kind)).toEqual(['foreshadow', 'pov_leak']);
    expect(dropped.map((d) => d.reason)).toEqual(['duplicate']);
  });
});

describe('作者处理过的问题不再提出', () => {
  const [issue] = resolveModelIssues([draft({})], refs).issues;
  if (issue === undefined) throw new Error('问题');

  it('同一段同一版本、同一类、同一处引文的问题去掉', () => {
    expect(dropHandled([issue], [{ kind: issue.kind, anchor: issue.anchor, description: '作者忽略时的说法' }])).toEqual([]);
  });

  it('段落改过（版本不同）、类型不同或引文不同的问题保留', () => {
    expect(dropHandled([issue], [{ kind: issue.kind, anchor: { ...issue.anchor, paragraphVersion: 2 }, description: '' }])).toEqual([issue]);
    expect(dropHandled([issue], [{ kind: 'pacing', anchor: issue.anchor, description: '' }])).toEqual([issue]);
    expect(dropHandled([issue], [{ kind: issue.kind, anchor: { ...issue.anchor, quote: '遗物' }, description: '' }])).toEqual([issue]);
  });

  it('针对整段的问题（没有引文）按说明区分', () => {
    const whole = { ...issue, anchor: { ...issue.anchor, start: 0, end: 0, quote: '' }, description: '计划中的“钱四”没有出场' };
    expect(dropHandled([whole], [{ kind: whole.kind, anchor: whole.anchor, description: '计划中的“林舟”没有出场' }])).toEqual([whole]);
    expect(dropHandled([whole], [{ kind: whole.kind, anchor: whole.anchor, description: whole.description }])).toEqual([]);
  });
});

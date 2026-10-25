import { describe, expect, it } from 'vitest';
import { dropHandled, paragraphLabel, relocateIssue, resolveModelIssues, type ModelIssueDraft, type ReviewRefs } from './review';

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

  it('说明与建议里的段落标签换成段落开头，依据标签按给出的称呼换（M6-08 第 5 项）', () => {
    const named: ReviewRefs = { ...refs, names: new Map([['E1', '林舟']]) };
    const { issues } = resolveModelIssues([draft({ description: 'P2 与 P1 衔接不上，E1 的反应没写', suggestion: '在[P1]后补一句；S1 不动' })], named);
    expect(issues[0]?.description).toBe('“钱四说：这玉是你……”一段 与 “林舟推开当铺的门。”一段 衔接不上，林舟 的反应没写');
    expect(issues[0]?.suggestion).toBe('在“林舟推开当铺的门。”一段后补一句；S1 不动');
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

describe('一键修订时重新定位过期的问题', () => {
  const anchor = (paragraphId: string, paragraphVersion: number, start: number, quote: string) => ({ paragraphId, paragraphVersion, start, end: start + quote.length, quote });
  const issue = (over: Partial<Parameters<typeof relocateIssue>[0]> = {}) => ({
    kind: 'pacing' as const,
    anchor: anchor('pa', 1, 4, '笑了笑'),
    description: '动作重复',
    regenerated: false,
    ...over,
  });

  it('引文还在原来那一段（取离原位置最近的一处）：锚点挪到现在的版本', () => {
    const now = [{ id: 'pa', version: 2, text: '他笑了笑，又笑了笑，转身走了。' }];
    expect(relocateIssue(issue({ anchor: anchor('pa', 1, 5, '笑了笑') }), now, [])).toEqual({ kind: 'moved', anchor: anchor('pa', 2, 6, '笑了笑') });
  });

  it('原来那一段里没有了：全章只有一处时定位到那一段（修订拆出的段落），几处或没有时说明', () => {
    const split = [
      { id: 'pa', version: 2, text: '他沉默了很久。' },
      { id: 'pz', version: 1, text: '终于笑了笑。' },
      { id: 'pb', version: 1, text: '门外下着雨。' },
    ];
    expect(relocateIssue(issue(), split, [])).toEqual({ kind: 'moved', anchor: anchor('pz', 1, 2, '笑了笑') });
    expect(relocateIssue(issue(), [...split, { id: 'pc', version: 1, text: '她也笑了笑。' }], [])).toMatchObject({ kind: 'gone', reason: expect.stringContaining('好几处') });
    expect(relocateIssue(issue(), [split[0]!, split[2]!], [])).toMatchObject({ kind: 'gone', reason: expect.stringContaining('找不到') });
  });

  it('没有引文的问题跟着原来那一段；那一段删掉了就定位不到', () => {
    const whole = issue({ anchor: anchor('pa', 1, 0, '') });
    expect(relocateIssue(whole, [{ id: 'pa', version: 3, text: '改过的一段。' }], [])).toEqual({ kind: 'moved', anchor: anchor('pa', 3, 0, '') });
    expect(relocateIssue(whole, [{ id: 'pb', version: 1, text: '另一段。' }], [])).toMatchObject({ kind: 'gone', reason: expect.stringContaining('段落已经不在') });
  });

  it('程序检查重新标出了同一处：用新的那一条；没有重新标出就是改掉了', () => {
    const now = [{ id: 'pa', version: 2, text: '他不禁笑了笑。' }];
    const tone = issue({ kind: 'ai_tone', anchor: anchor('pa', 1, 1, '不禁'), description: '命中规避表达“不禁”', regenerated: true });
    const fresh = { id: 'new', kind: 'ai_tone' as const, anchor: anchor('pa', 2, 1, '不禁'), description: '命中规避表达“不禁”' };
    expect(relocateIssue(tone, now, [fresh])).toEqual({ kind: 'pending', id: 'new' });
    expect(relocateIssue(tone, now, [{ ...fresh, kind: 'pacing' }])).toMatchObject({ kind: 'gone', reason: expect.stringContaining('没有再标出') });
    // 没有引文的问题按说明区分。
    const whole = issue({ kind: 'off_plan', anchor: anchor('pa', 1, 0, ''), description: '阿青没有出场', regenerated: true });
    expect(relocateIssue(whole, now, [{ id: 'x', kind: 'off_plan', anchor: anchor('pa', 2, 0, ''), description: '钱四没有出场' }])).toMatchObject({ kind: 'gone' });
  });

  it('锚点没动却过期了：这一章重新审核过，问题换成了新的', () => {
    expect(relocateIssue(issue(), [{ id: 'pa', version: 1, text: '他摇头笑了笑。' }], [])).toMatchObject({ kind: 'gone', reason: expect.stringContaining('重新审核') });
  });
});

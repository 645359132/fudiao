import { describe, expect, it } from 'vitest';
import { avoidPhraseHits, missingCast, overdueForeshadows, revealLeaks, runProgramChecks } from './checks';
import type { ForeshadowItem, ParagraphText } from './types';

const paragraphs: readonly ParagraphText[] = [
  { id: 'g1', version: 2, text: '林舟嘴角勾起一抹弧度，把玉佩推过柜台。' },
  { id: 'g2', version: 1, text: '钱四不禁皱眉：“这玉，不禁让我想起一件旧事。”' },
  { id: 'g3', version: 1, text: '他没说出口的是，玉佩是王家失物的仿品。' },
];

const order = new Map([
  ['c1', 0],
  ['c2', 1],
  ['c3', 2],
]);

const jade: ForeshadowItem = { id: 'f1', title: '玉佩的来历', reveal: '玉佩是王家失物的仿品', plantChapterId: 'c1', payoffChapterId: 'c3', status: 'planted' };

describe('规避表达', () => {
  it('每一处命中都定位到段落与段内位置', () => {
    const hits = avoidPhraseHits(paragraphs, ['不禁', '嘴角勾起一抹弧度', '仿佛']);
    expect(hits.map((h) => [h.anchor.paragraphId, h.anchor.paragraphVersion, h.anchor.start, h.anchor.quote])).toEqual([
      ['g1', 2, 2, '嘴角勾起一抹弧度'],
      ['g2', 1, 2, '不禁'],
      ['g2', 1, 11, '不禁'],
    ]);
    expect(hits.every((h) => h.kind === 'ai_tone' && h.severity === 'low')).toBe(true);
  });

  it('空白的表达不检查', () => {
    expect(avoidPhraseHits(paragraphs, ['', '  '])).toEqual([]);
  });
});

describe('揭晓内容提前说破', () => {
  it('还不能说破的伏笔，揭晓内容原样出现时列为问题，依据是伏笔', () => {
    const issues = revealLeaks(paragraphs, [jade]);
    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'foreshadow',
        severity: 'high',
        anchor: { paragraphId: 'g3', paragraphVersion: 1, start: 8, end: 18, quote: '玉佩是王家失物的仿品' },
        evidence: [{ type: 'foreshadow', id: 'f1' }],
      }),
    ]);
  });

  it('过短的揭晓内容不做字面检查（容易误报），交给模型审核', () => {
    expect(revealLeaks(paragraphs, [{ ...jade, reveal: '玉佩' }])).toEqual([]);
  });
});

describe('到期未回收的伏笔', () => {
  it('写到计划回收的章节或之后，伏笔仍未回收时列出，锚在本章最后一段', () => {
    const issues = overdueForeshadows('c3', paragraphs, [jade, { ...jade, id: 'f2', payoffChapterId: 'c3', status: 'paid_off' }], order);
    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'foreshadow',
        severity: 'medium',
        anchor: { paragraphId: 'g3', paragraphVersion: 1, start: 0, end: 0, quote: '' },
        evidence: [{ type: 'foreshadow', id: 'f1' }],
      }),
    ]);
  });

  it('还没到回收章节、没有定回收章节或已废弃的不列；本章没有段落时不列', () => {
    expect(overdueForeshadows('c2', paragraphs, [jade], order)).toEqual([]);
    expect(overdueForeshadows('c3', paragraphs, [{ ...jade, payoffChapterId: null }, { ...jade, status: 'dropped' }], order)).toEqual([]);
    expect(overdueForeshadows('c3', [], [jade], order)).toEqual([]);
  });
});

describe('计划中的人物未出场', () => {
  it('名字与别名都没出现时列出，锚在第一段', () => {
    const cast = [
      { id: 'e1', name: '林舟', aliases: [] },
      { id: 'e2', name: '钱四', aliases: ['钱掌柜'] },
      { id: 'e3', name: '阿青', aliases: ['青儿'] },
    ];
    const issues = missingCast(paragraphs, cast);
    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'off_plan',
        anchor: { paragraphId: 'g1', paragraphVersion: 2, start: 0, end: 0, quote: '' },
        evidence: [{ type: 'entity', id: 'e3' }],
      }),
    ]);
    expect(issues[0]?.description).toContain('阿青');
  });
});

describe('程序检查合并', () => {
  it('依次运行各项检查', () => {
    const issues = runProgramChecks({
      chapterId: 'c2',
      paragraphs,
      avoidPhrases: ['不禁'],
      mustNotReveal: [jade],
      foreshadows: [jade],
      order,
      cast: [{ id: 'e1', name: '林舟', aliases: [] }],
    });
    expect(issues.map((i) => i.kind)).toEqual(['ai_tone', 'ai_tone', 'foreshadow']);
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { aiCharacters, classify, deriveProvenance, editDistanceWithin, joinSpans, splitSpans, updateSpans, type Provenance, type SavedProvenance, type SourceKind } from './paragraph-source';

describe('编辑距离（带上界）', () => {
  it('不超过上界时给出距离，超过时为 null', () => {
    expect(editDistanceWithin('雨下得更紧了', '雨下得更紧了', 2)).toBe(0);
    expect(editDistanceWithin('雨下得更紧了', '雨下得很紧了', 2)).toBe(1);
    expect(editDistanceWithin('雨下得更紧了', '雨停了', 2)).toBeNull();
    expect(editDistanceWithin('', '甲乙', 2)).toBe(2);
  });

  it('与完整动态规划一致', () => {
    const full = (a: string, b: string) => {
      const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      return d[a.length]![b.length]!;
    };
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), fc.string({ maxLength: 12 }), fc.nat({ max: 12 }), (a, b, k) => {
        const exact = full(a, b);
        return editDistanceWithin(a, b, k) === (exact <= k ? exact : null);
      }),
    );
  });
});

describe('AI 字符区间随编辑更新', () => {
  it('插入的文字属于作者，删除的文字从区间中去掉', () => {
    // “雨下得更紧了。”全部来自 AI；在中间插入“似乎”，删掉句号。
    // 开头单独的“雨”与后面不连续，按巧合处理，算作者所写（宁可少算，不把改写误算为 AI）。
    expect(updateSpans('雨下得更紧了。', [{ start: 0, end: 7 }], '雨似乎下得更紧了')).toEqual([{ start: 3, end: 8 }]);
    expect(updateSpans('雨下得更紧了。', [{ start: 0, end: 7 }], '雨下得似乎更紧了')).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 8 },
    ]);
  });

  it('文字不变时区间不变；全部改写后区间为空', () => {
    expect(updateSpans('甲乙丙', [{ start: 1, end: 2 }], '甲乙丙')).toEqual([{ start: 1, end: 2 }]);
    expect(updateSpans('甲乙丙', [{ start: 0, end: 3 }], '丁戊')).toEqual([]);
  });

  it('改写时零散相同的单字不算 AI 文字', () => {
    // “雨下得更紧了”改写为“风停了”：“了”只是巧合，不保留。
    expect(updateSpans('雨下得更紧了', [{ start: 0, end: 6 }], '风停了')).toEqual([]);
  });

  it('作者写的文字移动位置后仍属于作者', () => {
    // 前半“他说：”为作者所写，后半来自 AI；在两者之间插入一句。
    expect(updateSpans('他说：雨很大。', [{ start: 3, end: 7 }], '他说，低声地：雨很大。')).toEqual([{ start: 7, end: 11 }]);
  });

  it('区间始终在文字范围内、有序且不重叠', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 10 }), fc.string({ maxLength: 10 }), fc.nat(), fc.nat(), (oldText, newText, a, b) => {
        const s = Math.min(a, b) % (oldText.length + 1);
        const e = Math.max(a, b) % (oldText.length + 1);
        const spans = updateSpans(oldText, e > s ? [{ start: s, end: e }] : [], newText);
        return spans.every((x, i) => x.start < x.end && x.end <= newText.length && (i === 0 || (spans[i - 1]?.end ?? 0) < x.start));
      }),
    );
  });

  it('合并：后一段的区间平移；拆分：按位置切开', () => {
    expect(joinSpans('甲乙', [{ start: 0, end: 2 }], '丙丁', [])).toEqual([{ start: 0, end: 2 }]);
    expect(joinSpans('甲乙', [], '丙丁', [{ start: 0, end: 2 }])).toEqual([{ start: 2, end: 4 }]);
    expect(joinSpans('甲乙', [{ start: 0, end: 2 }], '丙丁', [{ start: 0, end: 2 }])).toEqual([{ start: 0, end: 4 }]);
    expect(splitSpans([{ start: 1, end: 5 }], 3)).toEqual([[{ start: 1, end: 3 }], [{ start: 0, end: 2 }]]);
  });
});

describe('来源判定', () => {
  const p = (text: string, origin: string | null, spans: Provenance['spans']): Provenance => ({ text, aiOriginText: origin, spans });

  it('没有 AI 文字为手写', () => {
    expect(classify(p('雨夜', null, []))).toBe('handwritten');
  });

  it('AI 生成：与生成原文的编辑距离不超过原文的 10% 时仍为 AI 生成，超过时为 AI 生成后修改', () => {
    const origin = '雨下得更紧了，他没有回头，只是把伞压得更低。'; // 22 字，10% 为 2.2
    expect(classify(p(origin, origin, [{ start: 0, end: 22 }]))).toBe('ai_generated');
    expect(classify(p('雨下得更紧了，他没回头，只是把伞压得更低。', origin, [{ start: 0, end: 21 }]))).toBe('ai_generated');
    expect(classify(p('雨下得更紧了，他终于回头，看了她一眼。', origin, [{ start: 0, end: 7 }]))).toBe('ai_modified');
  });

  it('没有生成原文时：整段是 AI 文字为 AI 生成后修改，部分是为混合', () => {
    expect(classify(p('雨下得更紧了。他没有回头。', null, [{ start: 0, end: 7 }]))).toBe('mixed');
    expect(classify(p('雨下得更紧了。', null, [{ start: 0, end: 7 }]))).toBe('ai_modified');
  });

  it('AI 参与的字数：AI 区间内的字数', () => {
    expect(aiCharacters('雨下得更紧了。他没有回头。', [{ start: 0, end: 7 }])).toBe(7);
    expect(aiCharacters('雨夜', [])).toBe(0);
  });
});

describe('保存时推导来源', () => {
  const AI = '雨下得更紧了，他没有回头，只是把伞压得更低。';
  const ai = (id: string, text = AI): SavedProvenance => ({ id, text, aiOriginText: text, spans: [{ start: 0, end: text.length }], source: 'ai_generated' });
  const hand = (id: string, text: string): SavedProvenance => ({ id, text, aiOriginText: null, spans: [], source: 'handwritten' });
  const cur = (id: string, text: string, source: SourceKind = 'handwritten') => ({ id, text, source });
  const none = { splits: [], merges: [] };

  it('已有段落不采信编辑器标记：AI 段落即使编辑器标为手写，小改后仍为 AI 生成', () => {
    const r = deriveProvenance([ai('a')], [cur('a', AI.replace('没有', '没'))], none);
    expect(r.get('a')).toMatchObject({ source: 'ai_generated', aiOriginText: AI });
  });

  it('改动超过原文的 10% 为 AI 生成后修改；AI 文字全部删掉后为手写', () => {
    expect(deriveProvenance([ai('a')], [cur('a', '雨下得更紧了，他终于回头，看了她一眼。')], none).get('a')?.source).toBe('ai_modified');
    expect(deriveProvenance([ai('a')], [cur('a', '全是作者写的。')], none).get('a')).toEqual({ source: 'handwritten', spans: [], aiOriginText: null });
  });

  it('删掉 AI 段落的一句并保存后撤销：找回的文字仍算 AI 文字', () => {
    const cut = AI.replace('他没有回头，', '');
    const afterCut = deriveProvenance([ai('a')], [cur('a', cut)], none).get('a');
    expect(afterCut?.spans).toEqual([{ start: 0, end: cut.length }]);
    const saved: SavedProvenance = { id: 'a', text: cut, aiOriginText: AI, spans: afterCut?.spans ?? [], source: afterCut?.source ?? 'handwritten' };
    expect(deriveProvenance([saved], [cur('a', AI)], none).get('a')).toEqual({ source: 'ai_generated', spans: [{ start: 0, end: AI.length }], aiOriginText: AI });
  });

  it('手写段落里作者写什么都仍是手写', () => {
    expect(deriveProvenance([hand('a', '雨夜')], [cur('a', '雨夜，当铺。', 'ai_generated')], none).get('a')?.source).toBe('handwritten');
  });

  it('合并 AI 段落与手写段落为混合，并按字符区间记录', () => {
    const r = deriveProvenance([ai('a', '雨很大。'), hand('b', '他没有回头。')], [cur('a', '雨很大。他没有回头。')], { splits: [], merges: [{ removed: 'b', into: 'a' }] });
    expect(r.get('a')).toEqual({ source: 'mixed', spans: [{ start: 0, end: 4 }], aiOriginText: null });
  });

  it('合并两段 AI 生成的段落仍为 AI 生成', () => {
    const r = deriveProvenance([ai('a', '雨很大。'), ai('b', '他没有回头。')], [cur('a', '雨很大。他没有回头。')], { splits: [], merges: [{ removed: 'b', into: 'a' }] });
    expect(r.get('a')).toMatchObject({ source: 'ai_generated', aiOriginText: '雨很大。他没有回头。' });
  });

  it('拆分混合段落：各部分按区间判定', () => {
    const mixed: SavedProvenance = { id: 'a', text: '雨很大。他没有回头。', aiOriginText: null, spans: [{ start: 0, end: 4 }], source: 'mixed' };
    const r = deriveProvenance([mixed], [cur('a', '雨很大。'), cur('n', '他没有回头。', 'mixed')], { splits: [{ id: 'n', from: 'a' }], merges: [] });
    expect(r.get('a')).toMatchObject({ source: 'ai_modified', spans: [{ start: 0, end: 4 }] });
    expect(r.get('n')).toEqual({ source: 'handwritten', spans: [], aiOriginText: null });
  });

  it('拆分未修改的 AI 段落：两段都仍为 AI 生成', () => {
    const r = deriveProvenance([ai('a')], [cur('a', AI.slice(0, 7)), cur('n', AI.slice(7))], { splits: [{ id: 'n', from: 'a' }], merges: [] });
    expect(r.get('a')).toMatchObject({ source: 'ai_generated', aiOriginText: AI.slice(0, 7) });
    expect(r.get('n')).toMatchObject({ source: 'ai_generated', aiOriginText: AI.slice(7) });
  });

  // 编辑器的结构变化记录在整次编辑会话里只增不减，保存时交来的记录里有早已保存过的拆分与合并。
  it('拆分已保存过：之后删改其中一段超过 10% 为 AI 生成后修改', () => {
    const left = AI.slice(0, 7);
    const right = AI.slice(7);
    const r = deriveProvenance([ai('a', left), ai('n', right)], [cur('a', left), cur('n', right.slice(0, 5))], { splits: [{ id: 'n', from: 'a' }], merges: [] });
    expect(r.get('n')).toMatchObject({ source: 'ai_modified', aiOriginText: right });
    expect(r.get('a')).toMatchObject({ source: 'ai_generated', aiOriginText: left });
  });

  it('合并已保存过：之后删改合并后的段落超过 10% 为 AI 生成后修改', () => {
    const joined = '雨很大。他没有回头。';
    const r = deriveProvenance([ai('a', joined)], [cur('a', '雨很大。')], { splits: [], merges: [{ removed: 'b', into: 'a' }] });
    expect(r.get('a')).toMatchObject({ source: 'ai_modified', aiOriginText: joined });
  });

  it('保存过的拆分被撤销（记为合并）：两段的文字回到一段，仍为 AI 生成', () => {
    const r = deriveProvenance([ai('a', AI.slice(0, 7)), ai('n', AI.slice(7))], [cur('a', AI)], {
      splits: [{ id: 'n', from: 'a' }],
      merges: [{ removed: 'n', into: 'a' }],
    });
    expect(r.get('a')).toMatchObject({ source: 'ai_generated', aiOriginText: AI });
  });

  it('保存过的合并被撤销（被合并的段落带原标识回来）：两段仍为 AI 生成', () => {
    const r = deriveProvenance([ai('a', '雨很大。他没有回头。')], [cur('a', '雨很大。'), cur('b', '他没有回头。', 'ai_generated')], {
      splits: [],
      merges: [{ removed: 'b', into: 'a' }],
    });
    expect(r.get('a')).toMatchObject({ source: 'ai_generated', aiOriginText: '雨很大。' });
    expect(r.get('b')).toMatchObject({ source: 'ai_generated', aiOriginText: '他没有回头。' });
  });

  it('没有来历的新段落采用编辑器标记（接受候选稿、粘贴）', () => {
    const r = deriveProvenance([], [cur('x', '雨很大。', 'ai_generated'), cur('y', '他走了。'), cur('z', '', 'ai_generated')], none);
    expect(r.get('x')).toEqual({ source: 'ai_generated', spans: [{ start: 0, end: 4 }], aiOriginText: '雨很大。' });
    expect(r.get('y')?.source).toBe('handwritten');
    expect(r.get('z')?.source).toBe('handwritten');
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildWritingContext, collectWritingCandidates, estimateTokens, selectContext, type ContextItem, type WritingContextInput } from './writing-context';

const input: WritingContextInput = {
  project: { title: '雨夜', genre: '悬疑', synopsis: '当铺里的一封信引出旧案。', outline: '' },
  chapter: { id: 'c3', title: '第三章', summary: '沈砚回到当铺。', notes: '' },
  before: '雨下得更紧了。',
  selection: '他推开门。',
  after: '柜台后没有人。',
  previousChapters: [
    { id: 'c2', title: '第二章', summary: '林晚收到信。' },
    { id: 'c1', title: '第一章', summary: '雨夜初遇。' },
  ],
  entities: [
    { id: 'shen', name: '沈砚', kind: 'character', description: '当铺掌柜的旧友', attributes: [{ label: '年纪', value: '三十' }], mentions: 3, nearSelection: true },
    { id: 'shop', name: '当铺', kind: 'location', description: '城南的老当铺', attributes: [], mentions: 1, nearSelection: false },
    { id: 'empty', name: '空设定', kind: 'item', description: '', attributes: [], mentions: 1, nearSelection: false },
  ],
  facts: [
    { id: 'f1', content: '沈砚知道信是伪造的。', kind: 'knowledge', status: 'confirmed', subjects: ['shen'] },
    { id: 'f2', content: '当铺三年前失过火。', kind: 'world', status: 'needs_review', subjects: ['shop'] },
    { id: 'f3', content: '林晚是掌柜的女儿。', kind: 'world', status: 'candidate', subjects: [] },
  ],
};

const ids = (entries: readonly { item: ContextItem }[]) => entries.map((e) => e.item.id);

describe('写作上下文', () => {
  it('收集作品、本章、前后文、前面的章节、设定与事实；空的条目不收集', () => {
    const items = collectWritingCandidates(input);
    expect(items.map((i) => i.id)).toEqual(['project', 'chapter_notes', 'selection', 'before', 'after', 'chapter:c2', 'chapter:c1', 'entity:shen', 'entity:shop', 'fact:f1', 'fact:f2', 'fact:f3']);
    expect(items.find((i) => i.id === 'entity:shen')?.text).toBe('沈砚：当铺掌柜的旧友；年纪：三十');
    expect(items.filter((i) => i.required).map((i) => i.id)).toEqual(['selection', 'before', 'after']);
  });

  it('预算足够时纳入全部可用条目；待复核与未确认的事实不用，并说明原因', () => {
    const m = buildWritingContext(input, 10_000);
    expect(ids(m.included)).toEqual(['project', 'chapter_notes', 'chapter:c2', 'chapter:c1', 'entity:shen', 'entity:shop', 'fact:f1', 'before', 'selection', 'after']);
    expect(m.excluded.map((e) => [e.item.id, e.reason])).toEqual([
      ['fact:f2', '待复核的事实不用'],
      ['fact:f3', '未确认的事实不用'],
    ]);
    expect(m.usedTokens).toBe(m.included.reduce((n, e) => n + e.tokens, 0));
  });

  it('预算紧时必需条目总在，其余按相关性纳入，放不下的标为超出预算', () => {
    const required = estimateTokens(input.before + input.selection + input.after);
    const m = buildWritingContext(input, required + estimateTokens('梗概：沈砚回到当铺。') + estimateTokens('沈砚：当铺掌柜的旧友；年纪：三十'));
    expect(ids(m.included)).toEqual(['chapter_notes', 'entity:shen', 'before', 'selection', 'after']);
    expect(m.excluded.filter((e) => e.reason === '超出预算').map((e) => e.item.id)).toEqual(['entity:shop', 'fact:f1', 'project', 'chapter:c2', 'chapter:c1']);
    // 预算为 0 时只有必需条目。
    expect(ids(buildWritingContext(input, 0).included)).toEqual(['before', 'selection', 'after']);
  });

  it('作者移除的条目不纳入；作者加入的条目优先，超出预算时标明；必需与被阻止的条目不受作者增减影响', () => {
    const m = buildWritingContext(input, 0, { include: ['chapter:c1', 'fact:f2', 'selection'], exclude: ['entity:shen', 'before'] });
    expect(m.included.map((e) => [e.item.id, e.reason])).toEqual([
      ['chapter:c1', '作者加入（超出预算）'],
      ['before', '必需'],
      ['selection', '必需'],
      ['after', '必需'],
    ]);
    expect(m.excluded.find((e) => e.item.id === 'entity:shen')?.reason).toBe('作者移除');
    expect(buildWritingContext(input, 10_000, { include: [], exclude: ['entity:shen'] }).excluded.find((e) => e.item.id === 'entity:shen')?.reason).toBe('作者移除');
    expect(m.excluded.find((e) => e.item.id === 'fact:f2')?.reason).toBe('待复核的事实不用');
  });

  it('任意预算：每个条目恰好出现一次；未超出预算时用量不超过预算（作者加入的除外）', () => {
    const items = collectWritingCandidates(input);
    fc.assert(
      fc.property(fc.nat({ max: 400 }), fc.subarray(items.map((i) => i.id)), fc.subarray(items.map((i) => i.id)), (budget, include, exclude) => {
        const m = selectContext(items, budget, { include, exclude });
        const seen = [...ids(m.included), ...ids(m.excluded)].sort();
        expect(seen).toEqual(items.map((i) => i.id).sort());
        // 必需与作者加入的条目不受预算限制；按相关性纳入的条目只在预算之内。
        const forced = m.included.filter((e) => e.reason !== '相关').reduce((n, e) => n + e.tokens, 0);
        if (forced >= budget) expect(m.included.filter((e) => e.reason === '相关' && e.tokens > 0)).toEqual([]);
        else expect(m.usedTokens).toBeLessThanOrEqual(budget);
      }),
    );
  });
});

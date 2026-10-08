import { describe, expect, it } from 'vitest';
import { createEntityMatcher } from './entity-matcher';

const matcher = createEntityMatcher([
  { id: 'shen', kind: 'character', name: '沈砚', aliases: ['沈先生', '沈'] },
  { id: 'shop', kind: 'location', name: '当铺', aliases: ['城南当铺'] },
  { id: 'jade', kind: 'item', name: '玉佩', aliases: [] },
]);

const found = (text: string) => matcher.find(text).map((m) => [text.slice(m.from, m.to), m.entityId]);

describe('设定名匹配', () => {
  it('匹配名字与别名，位置按字符串下标', () => {
    expect(found('沈砚走进当铺，沈先生要赎回玉佩。')).toEqual([
      ['沈砚', 'shen'],
      ['当铺', 'shop'],
      ['沈先生', 'shen'],
      ['玉佩', 'jade'],
    ]);
  });

  it('重叠时取最长的匹配', () => {
    expect(found('他去了城南当铺。')).toEqual([['城南当铺', 'shop']]);
  });

  it('单字的名字与别名不匹配', () => {
    expect(found('沈家的人')).toEqual([]);
  });

  it('同名时先登记的条目优先；没有设定时没有匹配', () => {
    const twins = createEntityMatcher([
      { id: 'a', kind: 'character', name: '阿青', aliases: [] },
      { id: 'b', kind: 'character', name: '阿青', aliases: [] },
    ]);
    expect(twins.find('阿青来了').map((m) => m.entityId)).toEqual(['a']);
    expect(createEntityMatcher([]).find('阿青来了')).toEqual([]);
  });

  it('匹配结果带种类与名字，供高亮的样式与提示使用', () => {
    expect(matcher.find('玉佩')[0]).toEqual({ from: 0, to: 2, entityId: 'jade', kind: 'item', name: '玉佩' });
  });
});

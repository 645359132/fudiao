import { describe, expect, it } from 'vitest';
import { castGaps } from './cast';

describe('人物补全的缺口', () => {
  it('说明为空的、出场过却没有任何关系的列出，带第一次出场的章节与出场章数；出场多的在前', () => {
    const gaps = castGaps({
      characters: [
        { id: 'lin', name: '林舟', description: '落魄书生' },
        { id: 'qian', name: '钱四', description: '' },
        { id: 'qing', name: '阿青', description: '同乡' },
        { id: 'ghost', name: '无名氏', description: '' },
      ],
      relations: [{ fromId: 'lin', toId: 'qian' }],
      appearances: new Map([
        ['c2', ['lin', 'qing', 'qian']],
        ['c1', ['lin', 'qian', 'qian']],
        ['gone', ['qing']],
      ]),
      order: new Map([
        ['c1', 0],
        ['c2', 1],
      ]),
    });
    expect(gaps).toEqual([
      { id: 'qian', name: '钱四', noDescription: true, noRelation: false, firstChapterId: 'c1', chapters: 2 },
      { id: 'qing', name: '阿青', noDescription: false, noRelation: true, firstChapterId: 'c2', chapters: 1 },
      { id: 'ghost', name: '无名氏', noDescription: true, noRelation: false, firstChapterId: null, chapters: 0 },
    ]);
  });
});

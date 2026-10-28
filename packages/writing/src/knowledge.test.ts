import { describe, expect, it } from 'vitest';
import { factApplies } from './facts';
import { knowledgeForCast, type KnowledgeFact } from './knowledge';

const order = new Map(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map((id, i) => [id, i]));
type F = KnowledgeFact & { readonly id: string };
const fact = (id: string, kind: F['kind'], holderId: string | null, extra: Partial<F> = {}): F => ({
  id,
  kind,
  holderId,
  status: 'confirmed',
  validFromChapterId: null,
  validToChapterId: null,
  ...extra,
});

describe('事实的适用范围', () => {
  it('起始章节之前、结束章节之后不适用；没有给出的一端不限；起止章节不在目录里当作不限', () => {
    const f = fact('f', 'world', null, { validFromChapterId: 'c2', validToChapterId: 'c2' });
    expect([0, 1, 2].map((i) => factApplies(f, i, order))).toEqual([false, true, false]);
    expect([0, 1, 2].map((i) => factApplies(fact('f', 'world', null, { validFromChapterId: 'c2' }), i, order))).toEqual([false, true, true]);
    expect([0, 1, 2].map((i) => factApplies(fact('f', 'world', null, { validToChapterId: 'c2' }), i, order))).toEqual([true, true, false]);
    expect(factApplies(fact('f', 'world', null, { validFromChapterId: 'gone', validToChapterId: 'gone' }), 0, order)).toBe(true);
  });
});

describe('各出场人物知道什么（B59 补充）', () => {
  const facts = [
    fact('a-belief', 'belief', 'a'),
    fact('a-claim', 'claim', 'a'),
    fact('a-later', 'belief', 'a', { validFromChapterId: 'c7' }),
    fact('a-candidate', 'belief', 'a', { status: 'candidate' }),
    fact('world', 'world', null),
    fact('b-belief', 'belief', 'b'),
  ];

  it('知道的只有以本人为持有者、已确认、适用于本章的认知与说法；世界事实与别人的认知不算', () => {
    const result = knowledgeForCast({ castIds: ['a', 'b'], index: 5, order, appearances: [], written: new Set(), facts });
    expect(result.get('a')?.knows.map((f) => f.id)).toEqual(['a-belief', 'a-claim']);
    expect(result.get('b')?.knows.map((f) => f.id)).toEqual(['b-belief']);
  });

  it('在场与不在场只看本章之前最近几章里已写有记忆的；计划出场或记忆里有状态都算在场；从远到近', () => {
    const appearances = [
      { chapterId: 'c2', entityId: 'a' },
      { chapterId: 'c4', entityId: 'a' },
      { chapterId: 'c4', entityId: 'b' },
      { chapterId: 'c5', entityId: 'b' },
    ];
    // 第 3、6 章没有记忆（例如作者手写、还没整理），不算；第 1 章在窗口（第 7 章往前 5 章）之外。
    const written = new Set(['c1', 'c2', 'c4', 'c5']);
    const result = knowledgeForCast({ castIds: ['a', 'b', 'c'], index: 6, order, appearances, written, facts: [] });
    expect(result.get('a')).toMatchObject({ present: [1, 3], absent: [4] });
    expect(result.get('b')).toMatchObject({ present: [3, 4], absent: [1] });
    expect(result.get('c')).toMatchObject({ present: [], absent: [1, 3, 4] });
    // 窗口可以调小；第一章之前没有章。
    expect(knowledgeForCast({ castIds: ['a'], index: 6, order, appearances, written, facts: [], window: 2 }).get('a')).toMatchObject({ present: [], absent: [4] });
    expect(knowledgeForCast({ castIds: ['a'], index: 0, order, appearances, written, facts: [] }).get('a')).toMatchObject({ present: [], absent: [] });
  });

  it('同一个人物列了两次只算一次', () => {
    expect([...knowledgeForCast({ castIds: ['a', 'a'], index: 1, order, appearances: [], written: new Set(), facts }).keys()]).toEqual(['a']);
  });
});

import { describe, expect, it } from 'vitest';
import { relationApplies, relationsForCast, type RelationLike } from './relations';

const order = new Map([
  ['c1', 0],
  ['c2', 1],
  ['c3', 2],
]);
const rel = (id: string, fromId: string, toId: string, validFromChapterId: string | null = null, validToChapterId: string | null = null): RelationLike => ({
  id,
  fromId,
  toId,
  validFromChapterId,
  validToChapterId,
});

describe('人物关系的适用范围（B73）', () => {
  it('起始章节之前、结束章节之后不成立；没有给出的一端不限；起止章节不在目录里当作不限', () => {
    const r = rel('r', 'a', 'b', 'c2', 'c2');
    expect([0, 1, 2].map((i) => relationApplies(r, i, order))).toEqual([false, true, false]);
    expect([0, 1, 2].map((i) => relationApplies(rel('r', 'a', 'b', 'c2'), i, order))).toEqual([false, true, true]);
    expect([0, 1, 2].map((i) => relationApplies(rel('r', 'a', 'b', null, 'c2'), i, order))).toEqual([true, true, false]);
    expect(relationApplies(rel('r', 'a', 'b', 'gone', 'gone'), 0, order)).toBe(true);
  });

  it('写手带上至少一端出场、在本章成立的关系；两端都出场的在前；有上限', () => {
    const relations = [rel('one', 'a', 'x'), rel('both', 'b', 'a'), rel('none', 'x', 'y'), rel('later', 'a', 'b', 'c3'), rel('one2', 'y', 'b')];
    const cast = new Set(['a', 'b']);
    expect(relationsForCast(relations, cast, 1, order, 10).map((r) => r.id)).toEqual(['both', 'one', 'one2']);
    expect(relationsForCast(relations, cast, 2, order, 10).map((r) => r.id)).toEqual(['both', 'later', 'one', 'one2']);
    expect(relationsForCast(relations, cast, 2, order, 2).map((r) => r.id)).toEqual(['both', 'later']);
  });
});

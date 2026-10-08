import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { textDiff } from './text-diff';

const join = (parts: ReturnType<typeof textDiff>, keep: 'before' | 'after') =>
  parts
    .filter((p) => p.kind === 'same' || p.kind === (keep === 'before' ? 'removed' : 'added'))
    .map((p) => p.text)
    .join('');

describe('逐字差异', () => {
  it('标出删除与新增，相邻的同类片段合并', () => {
    expect(textDiff('他推开门。', '他轻轻推开了门。')).toEqual([
      { kind: 'same', text: '他' },
      { kind: 'added', text: '轻轻' },
      { kind: 'same', text: '推开' },
      { kind: 'added', text: '了' },
      { kind: 'same', text: '门。' },
    ]);
    expect(textDiff('雨很大', '风很大')).toEqual([
      { kind: 'removed', text: '雨' },
      { kind: 'added', text: '风' },
      { kind: 'same', text: '很大' },
    ]);
    expect(textDiff('', '新')).toEqual([{ kind: 'added', text: '新' }]);
    expect(textDiff('同', '同')).toEqual([{ kind: 'same', text: '同' }]);
  });

  it('任意两段文字：按删除方向拼回原文，按新增方向拼回新文', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 }), (a, b) => {
        const parts = textDiff(a, b);
        expect(join(parts, 'before')).toBe(a);
        expect(join(parts, 'after')).toBe(b);
      }),
    );
  });
});

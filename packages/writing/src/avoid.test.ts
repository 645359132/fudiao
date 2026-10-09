import { describe, expect, it } from 'vitest';
import { DEFAULT_AVOID_PHRASES, effectiveAvoidPhrases } from './avoid';

describe('规避词表', () => {
  it('作品没有自己的词表时用默认词表；作者清空后不检查', () => {
    expect(effectiveAvoidPhrases(null)).toBe(DEFAULT_AVOID_PHRASES);
    expect(effectiveAvoidPhrases([])).toEqual([]);
    expect(effectiveAvoidPhrases(['不禁'])).toEqual(['不禁']);
  });

  it('默认词表不含空项与重复项', () => {
    expect(DEFAULT_AVOID_PHRASES.every((p) => p.trim() === p && p !== '')).toBe(true);
    expect(new Set(DEFAULT_AVOID_PHRASES).size).toBe(DEFAULT_AVOID_PHRASES.length);
  });
});

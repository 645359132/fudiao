import { describe, expect, it } from 'vitest';
import { formatSkillStages, parseSkillStages } from './skill-stage';

describe('写作技能的阶段', () => {
  it('没写或写的都不认得时为写章节', () => {
    expect(parseSkillStages(undefined)).toEqual(['writing']);
    expect(parseSkillStages('')).toEqual(['writing']);
    expect(parseSkillStages('review')).toEqual(['writing']);
  });

  it('按固定顺序去重，空格、逗号与顿号都可以分开，不区分大小写', () => {
    expect(parseSkillStages('writing planning')).toEqual(['planning', 'writing']);
    expect(parseSkillStages('Planning，planning、writing')).toEqual(['planning', 'writing']);
    expect(parseSkillStages('planning')).toEqual(['planning']);
  });

  it('写成空格分开的文字，读回来相同', () => {
    expect(formatSkillStages(['writing', 'planning'])).toBe('planning writing');
    expect(formatSkillStages([])).toBe('writing');
    expect(parseSkillStages(formatSkillStages(['planning']))).toEqual(['planning']);
  });
});

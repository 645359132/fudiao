import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from './skills';

describe('内置写作技能', () => {
  it('按顺序列出九项技能，名称、适用说明、版本与文字齐全', () => {
    expect(BUILTIN_SKILLS.map((s) => s.key)).toEqual(['foreshadow', 'pacing', 'tension', 'scene', 'dialogue', 'pov', 'cliffhanger', 'polish', 'snowflake']);
    for (const s of BUILTIN_SKILLS) {
      expect(s.name).not.toBe('');
      expect(s.description.startsWith(`${s.name}：`)).toBe(true);
      expect(s.version).toMatch(/^\d+$/);
      expect(s.text.length).toBeGreaterThan(20);
      expect(s.text).not.toContain('---');
    }
  });

  it('雪花写作法用于规划，其余八项用于写章节', () => {
    expect(BUILTIN_SKILLS.filter((s) => s.stages.includes('planning')).map((s) => s.key)).toEqual(['snowflake']);
    expect(BUILTIN_SKILLS.filter((s) => s.stages.includes('writing'))).toHaveLength(8);
  });

  it('雪花写作法：一句话、三次挫折与结局、人物的动机目标冲突与领悟、按场景与后续拆章', () => {
    const text = BUILTIN_SKILLS.find((s) => s.key === 'snowflake')?.text ?? '';
    for (const part of ['一句话', '三次', '挫折', '结局', '动机', '目标', '冲突', '领悟', '视角人物', '场景', '后续', '两难', '决定']) expect(text).toContain(part);
  });

  it('伏笔技能要求不说破本章不得说破的内容', () => {
    expect(BUILTIN_SKILLS.find((s) => s.key === 'foreshadow')?.text).toContain('不得说破');
  });
});

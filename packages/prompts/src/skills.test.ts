import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from './skills';

describe('内置写作技能', () => {
  it('按顺序列出八项技能，名称、适用说明、版本与文字齐全', () => {
    expect(BUILTIN_SKILLS.map((s) => s.key)).toEqual(['foreshadow', 'pacing', 'tension', 'scene', 'dialogue', 'pov', 'cliffhanger', 'polish']);
    for (const s of BUILTIN_SKILLS) {
      expect(s.name).not.toBe('');
      expect(s.description.startsWith(`${s.name}：`)).toBe(true);
      expect(s.version).toMatch(/^\d+$/);
      expect(s.text.length).toBeGreaterThan(20);
      expect(s.text).not.toContain('---');
    }
  });

  it('伏笔技能要求不说破本章不得说破的内容', () => {
    expect(BUILTIN_SKILLS.find((s) => s.key === 'foreshadow')?.text).toContain('不得说破');
  });
});

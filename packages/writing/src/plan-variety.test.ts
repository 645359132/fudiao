import { describe, expect, it } from 'vitest';
import { planVariety, type PlanVarietyItem } from './plan-variety';

const item = (title: string, targetWords: number | null = null, rhythm: PlanVarietyItem['rhythm'] = null): PlanVarietyItem => ({ title, targetWords, rhythm });
const kinds = (items: PlanVarietyItem[]) => planVariety(items).map((p) => p.kind);

describe('章节计划的均一检查（B87）', () => {
  it('少于六章不查', () => {
    expect(planVariety(Array.from({ length: 5 }, () => item('四字章名', 5000)))).toEqual([]);
  });

  it('章名全是同一长度、各章字数几乎一样', () => {
    const uniform = Array.from({ length: 10 }, (_, i) => item(`四字章${i}`, 5000 + (i % 2) * 100));
    const problems = planVariety(uniform);
    expect(problems.map((p) => p.kind)).toEqual(['titles', 'words']);
    expect(problems[0]?.description).toContain('10 章里 10 章的章名都是 4 字');
    expect(problems[1]?.description).toContain('变异系数 0.01');
  });

  it('章名长短不一、字数浮动三成时没有问题；没填字数的不算', () => {
    const titles = ['雪夜', '当铺里的灯', '他没有回头', '三十里', '一碗凉粥与一把刀', '问刀', '出关', '对坐', '夜里来了个人', '算盘'];
    const words = [3500, 5000, 6200, 4000, 5500, 3200, 4800, 6500, 4200, 5800];
    expect(kinds(titles.map((t, i) => item(t, words[i] ?? null)))).toEqual([]);
    expect(kinds(titles.map((t) => item(t)))).toEqual([]);
  });

  it('连续三章同一种收法、连着十章没有过渡或日常章', () => {
    const titles = ['雪夜', '当铺里的灯', '他没有回头', '三十里', '一碗凉粥', '问刀', '出关', '对坐', '夜里来了人', '算盘', '雨', '收账的人'];
    const words = titles.map((_, i) => 4000 + (i % 3) * 1200);
    const all = titles.map((t, i) => item(t, words[i] ?? null, { type: 'battle', ending: i < 3 ? 'cliffhanger' : i % 2 === 0 ? 'dialogue' : 'quiet' }));
    const problems = planVariety(all);
    expect(problems.map((p) => p.kind)).toEqual(['endings', 'transitions']);
    expect(problems[0]?.description).toContain('第 1 到 3 章');
    expect(problems[1]?.description).toContain('第 1 到 10 章');
    const relaxed = all.map((x, i) => (i === 5 ? { ...x, rhythm: { type: 'daily' as const, ending: 'quiet' as const } } : x));
    expect(kinds(relaxed)).toEqual(['endings']);
  });

  it('不到一半的章有节奏时不查过渡章', () => {
    const titles = ['雪夜', '当铺里的灯', '他没有回头', '三十里', '一碗凉粥', '问刀', '出关', '对坐', '夜里来了人', '算盘'];
    const items = titles.map((t, i) => item(t, 4000 + (i % 3) * 1200, i < 3 ? { type: 'battle', ending: i === 1 ? 'quiet' : 'dialogue' } : null));
    expect(kinds(items)).toEqual([]);
  });
});

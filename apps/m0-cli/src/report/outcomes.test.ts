import { describe, expect, it } from 'vitest';
import { groupOutcomes, renderOutcomes, type RunOutcome } from './outcomes';

const outcome = (runId: string, holder: string, turns: string[] = []): RunOutcome => {
  const ending = ['结束：达到回合上限', `密信：${holder}`];
  return { runId, signature: ending.join('；'), ending, turns };
};

describe('走向归类', () => {
  const outcomes = [
    outcome('R3', '韦七手里', ['第 2 回合：密信从沈砚手里到韦七手里']),
    outcome('R1', '沈砚手里'),
    outcome('R2', '韦七手里', ['第 4 回合：密信从沈砚手里到韦七手里']),
  ];

  it('相同结局归为一类；类按次数排序，代表运行取标识最小的一次', () => {
    const groups = groupOutcomes(outcomes);
    expect(groups.map((g) => g.runs)).toEqual([['R2', 'R3'], ['R1']]);
    expect(groups[0]?.representative.turns).toEqual(['第 4 回合：密信从沈砚手里到韦七手里']);
  });

  it('结果与输入顺序无关', () => {
    expect(groupOutcomes([...outcomes].reverse())).toEqual(groupOutcomes(outcomes));
  });

  it('归类文件列出次数、结局与关键转折', () => {
    const text = renderOutcomes('仓库争夺密信', groupOutcomes(outcomes));
    expect(text).toContain('共 3 次运行，2 种结局。');
    expect(text).toContain('## 结局 1（2 次）');
    expect(text).toContain('- 密信：韦七手里');
    expect(text).toContain('- （没有物品易手、伤势变化、离场、机关触发或导演事件）');
  });
});

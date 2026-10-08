import { describe, expect, it } from 'vitest';
import { MAX_FINISHED_TASKS, reduceTasks, runningCount, type TaskRecord } from './tasks';

const start = (id: string) => ({ type: 'started' as const, task: { id, kind: 'selection_edit' as const, title: `续写 · ${id}`, chapterId: 'c1', startedAt: 't0' } });

describe('任务记录', () => {
  it('开始、收到文字与用量、结束；新的在前', () => {
    let tasks: TaskRecord[] = [];
    tasks = reduceTasks(tasks, start('a'));
    tasks = reduceTasks(tasks, start('b'));
    tasks = reduceTasks(tasks, { type: 'text', id: 'a', delta: '柜台' });
    tasks = reduceTasks(tasks, { type: 'text', id: 'a', delta: '后' });
    tasks = reduceTasks(tasks, { type: 'usage', id: 'a', usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    expect(tasks.map((t) => [t.id, t.status, t.text, t.cost])).toEqual([
      ['b', 'running', '', undefined],
      ['a', 'running', '柜台后', undefined],
    ]);
    expect(runningCount(tasks)).toBe(2);
    tasks = reduceTasks(tasks, { type: 'finished', id: 'a', status: 'cancelled', finishedAt: 't1' });
    expect(tasks[1]).toMatchObject({ status: 'cancelled', text: '柜台后', cost: null, finishedAt: 't1', usage: { outputTokens: 3 } });
    tasks = reduceTasks(tasks, { type: 'finished', id: 'b', status: 'done', finishedAt: 't2', text: '全文', cost: 0.01 });
    expect(tasks[0]).toMatchObject({ status: 'done', text: '全文', cost: 0.01 });
    expect(runningCount(tasks)).toBe(0);
    expect(reduceTasks(tasks, { type: 'clearFinished' })).toEqual([]);
  });

  it('已结束的任务只保留最近的若干个，进行中的不受影响', () => {
    let tasks: TaskRecord[] = reduceTasks([], start('running'));
    for (let i = 0; i < MAX_FINISHED_TASKS + 5; i++) {
      tasks = reduceTasks(tasks, start(`t${i}`));
      tasks = reduceTasks(tasks, { type: 'finished', id: `t${i}`, status: 'done', finishedAt: `t${i}` });
    }
    expect(tasks.filter((t) => t.status !== 'running')).toHaveLength(MAX_FINISHED_TASKS);
    expect(tasks.some((t) => t.id === 'running')).toBe(true);
    expect(tasks.some((t) => t.id === 't0')).toBe(false);
  });
});

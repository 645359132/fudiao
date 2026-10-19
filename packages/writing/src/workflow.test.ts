import type { WorkflowStepStatus } from '@fudiao/shared';
import { describe, expect, it } from 'vitest';
import { applyStepChanges, nextAction, runState, transition, type StepEvent, type StepState } from './workflow';

const steps = (...statuses: WorkflowStepStatus[]): StepState[] => statuses.map((status, i) => ({ key: `s${i}`, status, attempt: status === 'pending' ? 0 : 1 }));

function after(state: readonly StepState[], event: StepEvent): readonly StepState[] {
  const changes = transition(state, event);
  if (!changes.ok) throw new Error(changes.error);
  return applyStepChanges(state, changes.value);
}

const statuses = (state: readonly StepState[]) => state.map((s) => s.status);

describe('工作流的步骤状态机', () => {
  it('按顺序开始一步：执行次数加一；前面还有没完成的步骤时不能开始', () => {
    const started = after(steps('done', 'pending', 'pending'), { type: 'start', idx: 1 });
    expect(started[1]).toEqual({ key: 's1', status: 'running', attempt: 1 });
    expect(transition(steps('done', 'pending', 'pending'), { type: 'start', idx: 2 })).toMatchObject({ ok: false });
    expect(transition(steps('awaiting_author', 'pending'), { type: 'start', idx: 1 })).toMatchObject({ ok: false });
    // 跳过的步骤不挡住后面的。
    expect(statuses(after(steps('skipped', 'pending'), { type: 'start', idx: 1 }))).toEqual(['skipped', 'running']);
  });

  it('同一时间只有一步在进行；出错与可能过时的步骤再开始时执行次数接着加，中断的接着做同一次', () => {
    expect(transition(steps('running', 'pending'), { type: 'start', idx: 0 })).toMatchObject({ ok: false });
    for (const status of ['failed', 'stale'] as const) {
      const again = after([{ key: 'a', status, attempt: 2 }], { type: 'start', idx: 0 });
      expect(again[0]).toEqual({ key: 'a', status: 'running', attempt: 3 });
    }
    // 中断时已经完成的模型调用按同一个步骤键复用，不重复计费。
    expect(after([{ key: 'a', status: 'interrupted', attempt: 2 }], { type: 'start', idx: 0 })[0]).toEqual({ key: 'a', status: 'running', attempt: 2 });
    expect(transition(steps('done'), { type: 'start', idx: 0 })).toMatchObject({ ok: false });
  });

  it('进行中的一步产出后等作者或直接完成；出错、中断只能发生在进行中的步骤', () => {
    expect(statuses(after(steps('running', 'pending'), { type: 'produced', idx: 0, waitForAuthor: true }))).toEqual(['awaiting_author', 'pending']);
    expect(statuses(after(steps('running', 'pending'), { type: 'produced', idx: 0, waitForAuthor: false }))).toEqual(['done', 'pending']);
    expect(statuses(after(steps('running'), { type: 'fail', idx: 0 }))).toEqual(['failed']);
    expect(statuses(after(steps('running'), { type: 'interrupt', idx: 0 }))).toEqual(['interrupted']);
    for (const type of ['produced', 'fail', 'interrupt'] as const) {
      const event: StepEvent = type === 'produced' ? { type, idx: 0, waitForAuthor: false } : { type, idx: 0 };
      expect(transition(steps('pending'), event)).toMatchObject({ ok: false });
    }
  });

  it('采用只对等作者的步骤；保留只对可能过时的步骤', () => {
    expect(statuses(after(steps('awaiting_author'), { type: 'adopt', idx: 0 }))).toEqual(['done']);
    expect(transition(steps('done'), { type: 'adopt', idx: 0 })).toMatchObject({ ok: false });
    expect(statuses(after(steps('stale'), { type: 'keep', idx: 0 }))).toEqual(['done']);
    expect(transition(steps('done'), { type: 'keep', idx: 0 })).toMatchObject({ ok: false });
    // 与开始一样按顺序：前面还有没完成的步骤时不能采用或保留。
    expect(transition(steps('awaiting_author', 'awaiting_author'), { type: 'adopt', idx: 1 })).toMatchObject({ ok: false });
    expect(transition(steps('pending', 'stale'), { type: 'keep', idx: 1 })).toMatchObject({ ok: false });
  });

  it('重做一步：它回到待做，后面已完成的步骤标为可能过时，其他的不动', () => {
    const redone = after(steps('done', 'done', 'skipped', 'done', 'pending'), { type: 'redo', idx: 1 });
    expect(statuses(redone)).toEqual(['done', 'pending', 'skipped', 'stale', 'pending']);
    // 执行次数保留，下次开始时接着加，步骤键因此不同。
    expect(redone[1]?.attempt).toBe(1);
    // 后面等作者的草稿依据的是旧结果，回到待做。
    expect(statuses(after(steps('done', 'skipped', 'awaiting_author'), { type: 'redo', idx: 0 }))).toEqual(['pending', 'skipped', 'pending']);
    expect(transition(steps('running', 'done'), { type: 'redo', idx: 1 })).toMatchObject({ ok: false });
    expect(transition(steps('pending'), { type: 'redo', idx: 0 })).toMatchObject({ ok: false });
  });

  it('撤回一次采用：已完成的步骤回到等作者，后面已完成的标为可能过时', () => {
    expect(statuses(after(steps('done', 'done', 'done'), { type: 'withdraw', idx: 1 }))).toEqual(['done', 'awaiting_author', 'stale']);
    expect(transition(steps('awaiting_author'), { type: 'withdraw', idx: 0 })).toMatchObject({ ok: false });
  });

  it('跳过：进行中与已完成的步骤不能跳过', () => {
    for (const status of ['pending', 'interrupted', 'failed', 'awaiting_author', 'stale'] as const) {
      expect(statuses(after(steps(status), { type: 'skip', idx: 0 }))).toEqual(['skipped']);
    }
    expect(transition(steps('running'), { type: 'skip', idx: 0 })).toMatchObject({ ok: false });
    expect(transition(steps('done'), { type: 'skip', idx: 0 })).toMatchObject({ ok: false });
  });

  it('不存在的步骤报原因', () => {
    expect(transition(steps('pending'), { type: 'start', idx: 3 })).toMatchObject({ ok: false });
  });

  it('下一件事：按顺序第一项没完成也没跳过的步骤决定', () => {
    expect(nextAction(steps('done', 'pending'))).toEqual({ kind: 'run', idx: 1 });
    expect(nextAction(steps('done', 'interrupted'))).toEqual({ kind: 'run', idx: 1 });
    expect(nextAction(steps('skipped', 'awaiting_author', 'pending'))).toEqual({ kind: 'wait', idx: 1 });
    expect(nextAction(steps('stale', 'done'))).toEqual({ kind: 'stale', idx: 0 });
    expect(nextAction(steps('failed', 'pending'))).toEqual({ kind: 'failed', idx: 0 });
    expect(nextAction(steps('done', 'running'))).toEqual({ kind: 'busy', idx: 1 });
    expect(nextAction(steps('done', 'skipped'))).toEqual({ kind: 'finished' });
  });

  it('整次运行的状态由各步推出', () => {
    expect(runState(steps('pending', 'pending'), false)).toBe('ready');
    expect(runState(steps('done', 'pending'), false)).toBe('paused');
    expect(runState(steps('done', 'interrupted'), false)).toBe('paused');
    expect(runState(steps('running', 'pending'), false)).toBe('running');
    expect(runState(steps('awaiting_author'), false)).toBe('waiting');
    expect(runState(steps('done', 'stale'), false)).toBe('waiting');
    expect(runState(steps('failed'), false)).toBe('failed');
    expect(runState(steps('done', 'skipped'), false)).toBe('done');
    expect(runState(steps('done', 'pending'), true)).toBe('abandoned');
  });

  it('任意一串操作之后：至多一步在进行；进行中、等作者与已完成的步骤前面都已完成或跳过', () => {
    // 固定种子的线性同余数列，结果只由种子决定。
    let seed = 20261019;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const types = ['start', 'produced', 'fail', 'adopt', 'skip', 'redo', 'keep', 'interrupt', 'withdraw'] as const;
    for (let trial = 0; trial < 200; trial++) {
      let state: readonly StepState[] = steps('pending', 'pending', 'pending', 'pending');
      for (let i = 0; i < 40; i++) {
        const type = types[rand(types.length)]!;
        const idx = rand(4);
        const event: StepEvent = type === 'produced' ? { type, idx, waitForAuthor: rand(2) === 0 } : { type, idx };
        const changes = transition(state, event);
        if (changes.ok) state = applyStepChanges(state, changes.value);
        expect(state.filter((s) => s.status === 'running').length).toBeLessThanOrEqual(1);
        state.forEach((s, j) => {
          if (s.status === 'running' || s.status === 'awaiting_author' || s.status === 'done') {
            expect(state.slice(0, j).every((p) => p.status === 'done' || p.status === 'skipped')).toBe(true);
          }
        });
      }
    }
  });
});

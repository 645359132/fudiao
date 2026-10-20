// 写作工作流（需求 B78）的步骤状态机：纯函数。应用层按它的结果改作品库里的步骤，执行器按 nextAction 决定下一件事。
// 步骤按顺序做：一步开始、采用或保留之前，它前面的步骤都须已完成或已跳过；同一时间只有一步在进行。
import { err, ok, type Result, type WorkflowStepStatus } from '@fudiao/shared';

export type StepState = { readonly key: string; readonly status: WorkflowStepStatus; readonly attempt: number };

export type StepEvent =
  /**
   * 开始执行（待做、中断、出错或可能过时的步骤）：执行次数加一，模型步骤的步骤键因此不同；
   * 中断的步骤接着做同一次，执行次数不变。
   */
  | { readonly type: 'start'; readonly idx: number }
  /** 执行完：草稿等作者看、改、采用（或等作者确认），否则直接完成。 */
  | { readonly type: 'produced'; readonly idx: number; readonly waitForAuthor: boolean }
  | { readonly type: 'fail'; readonly idx: number }
  /** 应用关闭、崩溃或被停下时没有做完。 */
  | { readonly type: 'interrupt'; readonly idx: number }
  | { readonly type: 'adopt'; readonly idx: number }
  | { readonly type: 'skip'; readonly idx: number }
  /** 重做：回到待做，后面已完成的步骤可能过时，后面等作者的草稿回到待做。 */
  | { readonly type: 'redo'; readonly idx: number }
  /** 作者看过可能过时的步骤，决定保留它的结果。 */
  | { readonly type: 'keep'; readonly idx: number }
  /** 撤回一次采用：回到等作者（草稿还在），后面同重做。 */
  | { readonly type: 'withdraw'; readonly idx: number };

/** 一项改动：哪一步改成什么状态（开始时带上新的执行次数）。 */
export type StepChange = { readonly idx: number; readonly status: WorkflowStepStatus; readonly attempt?: number };

/** 接下来该做的事。 */
export type NextAction =
  | { readonly kind: 'run'; readonly idx: number }
  | { readonly kind: 'wait'; readonly idx: number }
  | { readonly kind: 'stale'; readonly idx: number }
  | { readonly kind: 'failed'; readonly idx: number }
  | { readonly kind: 'busy'; readonly idx: number }
  | { readonly kind: 'finished' };

/** 整次运行的状态：可以开始、进行中、等作者、出错、停在中途、已完成、已放弃。 */
export type RunState = 'ready' | 'running' | 'waiting' | 'failed' | 'paused' | 'done' | 'abandoned';

const finished = (s: StepState) => s.status === 'done' || s.status === 'skipped';

const STATUS_LABEL: Readonly<Record<WorkflowStepStatus, string>> = {
  pending: '待做',
  running: '进行中',
  awaiting_author: '等你处理',
  done: '已完成',
  failed: '出错',
  skipped: '已跳过',
  interrupted: '中断',
  stale: '可能过时',
};

/** 重做或撤回之后，后面的步骤：已完成的可能过时，等作者的回到待做。 */
function invalidateAfter(steps: readonly StepState[], idx: number): StepChange[] {
  return steps.flatMap((s, i): StepChange[] => {
    if (i <= idx) return [];
    if (s.status === 'done') return [{ idx: i, status: 'stale' }];
    if (s.status === 'awaiting_author') return [{ idx: i, status: 'pending' }];
    return [];
  });
}

/** 一个事件引起的改动；不合法时返回原因（给作者看的一句话）。 */
export function transition(steps: readonly StepState[], event: StepEvent): Result<readonly StepChange[], string> {
  const step = steps[event.idx];
  if (step === undefined) return err(`没有第 ${event.idx + 1} 步`);
  const name = `第 ${event.idx + 1} 步（${STATUS_LABEL[step.status]}）`;
  const running = steps.findIndex((s) => s.status === 'running');
  const inOrder = steps.slice(0, event.idx).every(finished);
  const refuse = (why: string) => err(`${name}${why}`);

  switch (event.type) {
    case 'start':
      if (running >= 0) return err(`第 ${running + 1} 步还在进行`);
      if (!['pending', 'interrupted', 'failed', 'stale'].includes(step.status)) return refuse('不能开始');
      if (!inOrder) return refuse('前面还有没完成的步骤');
      // 中断的步骤接着做同一次（步骤键不变，已完成的模型调用直接复用）；其余开始新的一次。
      return ok([{ idx: event.idx, status: 'running', attempt: step.status === 'interrupted' && step.attempt > 0 ? step.attempt : step.attempt + 1 }]);
    case 'produced':
      if (step.status !== 'running') return refuse('不在进行中');
      return ok([{ idx: event.idx, status: event.waitForAuthor ? 'awaiting_author' : 'done' }]);
    case 'fail':
      if (step.status !== 'running') return refuse('不在进行中');
      return ok([{ idx: event.idx, status: 'failed' }]);
    case 'interrupt':
      if (step.status !== 'running') return refuse('不在进行中');
      return ok([{ idx: event.idx, status: 'interrupted' }]);
    case 'adopt':
      if (step.status !== 'awaiting_author') return refuse('没有等作者采用的结果');
      if (!inOrder) return refuse('前面还有没完成的步骤');
      return ok([{ idx: event.idx, status: 'done' }]);
    case 'keep':
      if (step.status !== 'stale') return refuse('不是可能过时的步骤');
      if (!inOrder) return refuse('前面还有没完成的步骤');
      return ok([{ idx: event.idx, status: 'done' }]);
    case 'skip':
      if (step.status === 'running' || step.status === 'done' || step.status === 'skipped') return refuse('不能跳过');
      return ok([{ idx: event.idx, status: 'skipped' }]);
    case 'redo':
      if (running >= 0) return err(`第 ${running + 1} 步还在进行`);
      if (step.status === 'pending') return refuse('还没有做过');
      return ok([{ idx: event.idx, status: 'pending' }, ...invalidateAfter(steps, event.idx)]);
    case 'withdraw':
      if (running >= 0) return err(`第 ${running + 1} 步还在进行`);
      if (step.status !== 'done') return refuse('还没有采用');
      return ok([{ idx: event.idx, status: 'awaiting_author' }, ...invalidateAfter(steps, event.idx)]);
  }
}

/** 把改动应用到步骤列表上（应用层写入作品库后得到的也是这个结果）。 */
export function applyStepChanges(steps: readonly StepState[], changes: readonly StepChange[]): readonly StepState[] {
  const byIdx = new Map(changes.map((c) => [c.idx, c]));
  return steps.map((s, i) => {
    const c = byIdx.get(i);
    return c === undefined ? s : { ...s, status: c.status, attempt: c.attempt ?? s.attempt };
  });
}

/** 接下来该做的事：有一步在进行时等它；否则看按顺序第一项没完成也没跳过的步骤。 */
export function nextAction(steps: readonly StepState[]): NextAction {
  const running = steps.findIndex((s) => s.status === 'running');
  if (running >= 0) return { kind: 'busy', idx: running };
  const idx = steps.findIndex((s) => !finished(s));
  const step = steps[idx];
  if (step === undefined) return { kind: 'finished' };
  switch (step.status) {
    case 'awaiting_author':
      return { kind: 'wait', idx };
    case 'stale':
      return { kind: 'stale', idx };
    case 'failed':
      return { kind: 'failed', idx };
    case 'pending':
    case 'interrupted':
      return { kind: 'run', idx };
    // 进行中的步骤在上面已经处理；已完成、已跳过的不会是第一项没完成的步骤。
    case 'running':
    case 'done':
    case 'skipped':
      return { kind: 'busy', idx };
  }
}

/** 整次运行的状态，由各步推出。 */
export function runState(steps: readonly StepState[], abandoned: boolean): RunState {
  if (abandoned) return 'abandoned';
  const next = nextAction(steps);
  switch (next.kind) {
    case 'finished':
      return 'done';
    case 'busy':
      return 'running';
    case 'wait':
    case 'stale':
      return 'waiting';
    case 'failed':
      return 'failed';
    case 'run':
      return steps.every((s) => s.status === 'pending' && s.attempt === 0) ? 'ready' : 'paused';
  }
}

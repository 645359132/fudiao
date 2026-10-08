// 任务中心（需求 B16、B19）：正在进行与已结束的模型任务，含进度（已收到的文字）、部分结果与已知用量。
// 只保留在本次运行期间；持久的调用记录在作品库的 llm_call（“用量与费用”）。M3 的批量推演接入同一份任务记录。
import type { LlmUsage } from '@fudiao/llm';

export type TaskStatus = 'running' | 'done' | 'cancelled' | 'failed';

export type TaskRecord = {
  readonly id: string;
  readonly kind: 'selection_edit';
  /** 给作者看的标题，例如“续写 · 第一章”。 */
  readonly title: string;
  readonly chapterId: string | null;
  readonly status: TaskStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** 已收到的文字（部分结果）。 */
  readonly text: string;
  /** 服务返回的用量；还没有返回时为 null。 */
  readonly usage: LlmUsage | null;
  /** 费用：undefined 为还不知道（进行中），null 为未知（价格未配置或没有用量）。 */
  readonly cost: number | null | undefined;
  readonly error: string | null;
};

/** 保留的已结束任务数，超过时丢弃最早的。 */
export const MAX_FINISHED_TASKS = 50;

export type TaskEvent =
  | { readonly type: 'started'; readonly task: Pick<TaskRecord, 'id' | 'kind' | 'title' | 'chapterId' | 'startedAt'> }
  | { readonly type: 'text'; readonly id: string; readonly delta: string }
  | { readonly type: 'usage'; readonly id: string; readonly usage: LlmUsage }
  | {
      readonly type: 'finished';
      readonly id: string;
      readonly status: Exclude<TaskStatus, 'running'>;
      readonly finishedAt: string;
      readonly text?: string;
      readonly cost?: number | null;
      readonly error?: string | null;
    }
  | { readonly type: 'clearFinished' };

/** 新的在前。已结束的任务最多保留 MAX_FINISHED_TASKS 个。 */
export function reduceTasks(tasks: readonly TaskRecord[], event: TaskEvent): TaskRecord[] {
  const update = (id: string, patch: (t: TaskRecord) => Partial<TaskRecord>) => tasks.map((t) => (t.id === id ? { ...t, ...patch(t) } : t));
  switch (event.type) {
    case 'started':
      return [{ ...event.task, status: 'running', finishedAt: null, text: '', usage: null, cost: undefined, error: null }, ...tasks];
    case 'text':
      return update(event.id, (t) => ({ text: t.text + event.delta }));
    case 'usage':
      return update(event.id, () => ({ usage: event.usage }));
    case 'finished': {
      const next = update(event.id, (t) => ({
        status: event.status,
        finishedAt: event.finishedAt,
        text: event.text ?? t.text,
        cost: event.cost === undefined ? null : event.cost,
        error: event.error ?? null,
      }));
      let finished = 0;
      return next.filter((t) => t.status === 'running' || ++finished <= MAX_FINISHED_TASKS);
    }
    case 'clearFinished':
      return tasks.filter((t) => t.status === 'running');
  }
}

export const runningCount = (tasks: readonly TaskRecord[]): number => tasks.filter((t) => t.status === 'running').length;

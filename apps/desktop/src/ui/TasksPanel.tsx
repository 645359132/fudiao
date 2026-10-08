import type { TaskRecord } from '../app/tasks';
import { useApp } from './store-context';

const STATUS: Record<TaskRecord['status'], string> = {
  running: '进行中',
  done: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

const n = (v: number) => v.toLocaleString('zh-CN');

/** 已知用量与费用（B19）：进行中的任务只显示已收到的部分；没有价格或用量时费用标为未知。 */
function usageText(t: TaskRecord): string {
  const tokens = t.usage === null ? '用量未知' : `输入 ${n(t.usage.inputTokens + t.usage.cacheReadTokens)}、输出 ${n(t.usage.outputTokens)} Token`;
  const cost = t.cost === undefined ? '' : t.cost === null ? '，费用未知' : `，费用 $${t.cost.toFixed(4)}`;
  return `${tokens}${cost}`;
}

/** 任务中心（需求 B16、B19）：本次运行中的模型任务，可以取消进行中的任务、复制部分结果。 */
export function TasksPanel() {
  const tasks = useApp((s) => s.tasks);
  const cancel = useApp((s) => s.cancelTask);
  const clear = useApp((s) => s.clearFinishedTasks);
  const copy = useApp((s) => s.copyText);
  const showPanel = useApp((s) => s.showPanel);
  return (
    <section aria-label="任务" className="sources tasks">
      <div className="history-head">
        <h2>任务</h2>
        <button type="button" disabled={!tasks.some((t) => t.status !== 'running')} onClick={clear}>
          清除已结束的任务
        </button>
        <button type="button" onClick={() => void showPanel('chapter')}>
          返回正文
        </button>
      </div>
      <p className="muted">这里列出本次运行中的模型任务；关闭应用后清空。每次调用的记录与费用见“作品 → 用量与费用”。</p>
      {tasks.length === 0 ? (
        <p className="muted">还没有任务。</p>
      ) : (
        <ul className="backup-list task-list" aria-label="任务列表">
          {tasks.map((t) => (
            <li key={t.id} aria-label={t.title}>
              <span>{t.title}</span>
              <span className={t.status === 'failed' ? 'context-budget over' : 'muted'}>
                {STATUS[t.status]}
                {t.error !== null && `：${t.error}`}
              </span>
              <span className="muted">
                已收到 {n([...t.text].length)} 字 · {usageText(t)}
              </span>
              {t.status === 'running' ? (
                <button type="button" aria-label={`取消 ${t.title}`} onClick={() => cancel(t.id)}>
                  取消
                </button>
              ) : (
                <button type="button" aria-label={`复制 ${t.title} 的结果`} disabled={t.text === ''} onClick={() => void copy(t.text)}>
                  {t.status === 'done' ? '复制结果' : '复制部分结果'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

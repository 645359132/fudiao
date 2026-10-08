import { useState } from 'react';
import type { SelectionOperation } from '@fudiao/prompts';
import { needsSelection, OPERATION_LABELS, OPERATIONS } from '../app/selection-ops';
import { CandidateCard } from './CandidateCard';
import { useApp } from './store-context';

const STATUS: Record<'running' | 'done' | 'cancelled' | 'failed', string> = {
  running: '生成中……',
  done: '已完成',
  cancelled: '已取消，保留已生成的部分',
  failed: '失败',
};

/**
 * 选区操作（需求 B16）：对选中的文字续写、改写、扩写、缩写或润色，结果流式显示，可以取消与重试。
 * 结果是候选稿，不会自动写入正文。
 */
export function AiWriteDrawer() {
  const open = useApp((s) => s.writeDrawerOpen);
  const selected = useApp((s) => s.writeSelectedText);
  const job = useApp((s) => s.aiWrite);
  const run = useApp((s) => s.runSelectionOp);
  const cancel = useApp((s) => s.cancelSelectionOp);
  const refresh = useApp((s) => s.openAiWrite);
  const close = useApp((s) => s.closeAiWrite);
  const openContext = useApp((s) => s.openContext);
  const copy = useApp((s) => s.copyText);
  const candidates = useApp((s) => s.candidates);
  const [instruction, setInstruction] = useState('');
  if (!open) return null;
  const running = job?.status === 'running';
  const start = (op: SelectionOperation) => void run(op, instruction);

  return (
    <aside className="entity-drawer context-drawer ai-write" aria-label="AI 写作">
      <div className="entity-head">
        <h3>AI 写作</h3>
        <span className="spacer" />
        <button type="button" disabled={running} onClick={() => void refresh()}>
          按当前选区
        </button>
        <button type="button" aria-label="关闭 AI 写作" onClick={close}>
          ×
        </button>
      </div>
      <p className="muted selected-preview">
        {selected === '' ? '没有选中文字：只能续写，从光标处接着写。' : `选中的文字：${selected.length > 60 ? `${selected.slice(0, 60)}……` : selected}`}
      </p>
      <div className="op-buttons" role="group" aria-label="操作">
        {OPERATIONS.map((op) => (
          <button key={op} type="button" disabled={running || (needsSelection(op) && selected === '')} onClick={() => start(op)}>
            {OPERATION_LABELS[op]}
          </button>
        ))}
      </div>
      <label className="instruction">
        附加要求（可不填）
        <input value={instruction} placeholder="例如：语气更冷一些" disabled={running} onChange={(e) => setInstruction(e.currentTarget.value)} />
      </label>
      <button type="button" className="link" onClick={() => void openContext()}>
        查看会用到的上下文
      </button>
      {job !== null && (
        <section className="ai-result" aria-label="生成结果">
          <p className={job.status === 'failed' ? 'context-budget over' : 'muted'} role="status">
            {OPERATION_LABELS[job.operation]}：{STATUS[job.status]}
            {job.error !== null && `（${job.error}）`}
          </p>
          {job.status === 'running' || job.candidateId === null || !candidates.some((c) => c.id === job.candidateId) ? (
            <div className="ai-text" aria-live="polite">
              {job.text}
            </div>
          ) : null}
          <div className="form-actions">
            {running ? (
              <button type="button" onClick={cancel}>
                取消
              </button>
            ) : (
              <>
                <button type="button" onClick={() => void run(job.operation, job.instruction)}>
                  重试
                </button>
                <button type="button" disabled={job.text === ''} onClick={() => void copy(job.text)}>
                  复制
                </button>
              </>
            )}
          </div>
        </section>
      )}
      {candidates.length > 0 && (
        <section aria-label="本章待处理的候选稿">
          <h4>本章待处理的候选稿（{candidates.length}）</h4>
          {candidates.map((c) => (
            <CandidateCard key={`${c.id}:${c.version}`} candidate={c} />
          ))}
        </section>
      )}
    </aside>
  );
}

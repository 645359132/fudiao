import { useState } from 'react';
import type { PlanChapterView } from '../app/planning';
import type { WriterJob } from '../state/store';
import { PLAN_STATUS_LABEL } from '../app/labels';
import { useApp } from './store-context';


function writingCell(item: PlanChapterView, job: WriterJob | null): string {
  const { plan } = item;
  if (job?.chapterId === item.chapter.id && job.stage === 'writing') return `正在写${job.total > 0 ? `（${job.done} / ${job.total} 段）` : ''}`;
  if (job?.queued.includes(item.chapter.id) === true) return '排队中';
  if (plan === null) return item.hasText ? '有正文' : '—';
  if (plan.status === 'writing' && plan.progress !== null) return `写作中（${plan.progress.done} / ${plan.progress.segments.length} 段）`;
  // 审核状态在“审核”一列，这里只说写没写完。
  return plan.status === 'reviewed' ? PLAN_STATUS_LABEL.written : PLAN_STATUS_LABEL[plan.status];
}

function memoryCell(item: PlanChapterView, busy: boolean): string {
  if (busy) return '正在生成…';
  if (!item.hasText) return '—';
  if (item.memory === null) return '没有';
  return item.memory.status === 'stale' ? '待复核' : '有效';
}

function reviewCell(item: PlanChapterView, busy: boolean): string {
  if (busy) return '正在审核…';
  if (item.pendingIssues > 0) return `待处理 ${item.pendingIssues} 条`;
  if (item.plan?.status === 'reviewed') return '已审核';
  return item.hasText ? '未审核' : '—';
}

/**
 * 成书流程看板（需求 B65）：按章显示计划、写作、长篇记忆与审核的状态；
 * 写下一章、依次写完或排定一段章节，可选写完后自动审核。作者随时可以停下，直接修改任何一步的结果。
 */
export function PipelineBoard() {
  const planning = useApp((s) => s.planning);
  const job = useApp((s) => s.writerJob);
  const reviewing = useApp((s) => s.reviewingChapterId);
  const building = useApp((s) => s.memoryBuilding);
  const busy = useApp((s) => s.busy);
  const write = useApp((s) => s.writeChapters);
  const stop = useApp((s) => s.cancelWriting);
  const reviewOne = useApp((s) => s.reviewFromBoard);
  const openIssues = useApp((s) => s.openChapterReview);
  const [review, setReview] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  if (planning === null) return null;

  // 待写或没写完、并且有计划的章节，按书中顺序。
  const pending = planning.chapters.filter((c) => c.plan !== null && (c.plan.status === 'todo' || c.plan.status === 'writing'));
  const ids = pending.map((c) => c.chapter.id);
  const fromId = ids.includes(from) ? from : (ids[0] ?? '');
  const toId = ids.includes(to) ? to : (ids.at(-1) ?? '');
  const range = ids.slice(ids.indexOf(fromId), ids.indexOf(toId) + 1);
  const idle = !busy && job === null && reviewing === null && building === null;
  const count = (f: (c: PlanChapterView) => boolean) => planning.chapters.filter(f).length;
  const issues = planning.chapters.reduce((n, c) => n + c.pendingIssues, 0);

  return (
    <section aria-label="成书进度">
      <h3>成书进度</h3>
      <p role="status" className="muted">
        共 {planning.chapters.length} 章：有计划 {count((c) => c.plan !== null)} 章，已写 {count((c) => c.plan?.status === 'written' || c.plan?.status === 'reviewed')} 章，已审核{' '}
        {count((c) => c.plan?.status === 'reviewed')} 章；待处理的审核问题 {issues} 条。
      </p>
      <table className="source-table" aria-label="各章进度">
        <thead>
          <tr>
            <th scope="col">章节</th>
            <th scope="col">计划</th>
            <th scope="col">写作</th>
            <th scope="col">长篇记忆</th>
            <th scope="col">审核</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {planning.chapters.map((item) => {
            const id = item.chapter.id;
            const here = job?.chapterId === id;
            return (
              <tr key={id} aria-label={item.chapter.title}>
                <th scope="row">{item.chapter.title}</th>
                <td>{item.plan === null ? '没有' : item.problems.length > 0 ? `有（${item.problems.length} 处要核对）` : '有'}</td>
                <td>{writingCell(item, job)}</td>
                <td>{memoryCell(item, (here && job.stage === 'memory') || building === id)}</td>
                <td>{reviewCell(item, (here && job.stage === 'review') || reviewing === id)}</td>
                <td>
                  {item.hasText ? (
                    <button type="button" disabled={!idle} aria-label={`审核${item.chapter.title}`} onClick={() => void reviewOne(id)}>
                      审核
                    </button>
                  ) : null}
                  {item.pendingIssues > 0 ? (
                    <button type="button" disabled={!idle} aria-label={`查看${item.chapter.title}的问题`} onClick={() => void openIssues(id)}>
                      查看问题
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="skill-actions">
        <button type="button" disabled={!idle || ids.length === 0} onClick={() => void write(ids.slice(0, 1), { review })}>
          写下一章
        </button>
        <button type="button" disabled={!idle || ids.length === 0} onClick={() => void write(ids, { review })}>
          依次写完待写的 {ids.length} 章
        </button>
        <label>
          <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
          写完后审核
        </label>
        {job !== null ? (
          <button type="button" onClick={stop}>
            停下
          </button>
        ) : null}
      </div>
      {ids.length > 1 ? (
        <div className="skill-actions">
          <label>
            从
            <select aria-label="从哪一章写起" value={fromId} onChange={(e) => setFrom(e.target.value)}>
              {pending.map((c) => (
                <option key={c.chapter.id} value={c.chapter.id}>
                  {c.chapter.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            到
            <select aria-label="写到哪一章" value={toId} onChange={(e) => setTo(e.target.value)}>
              {pending.map((c) => (
                <option key={c.chapter.id} value={c.chapter.id}>
                  {c.chapter.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!idle || range.length === 0} onClick={() => void write(range, { review })}>
            排定这 {range.length} 章
          </button>
        </div>
      ) : null}
    </section>
  );
}

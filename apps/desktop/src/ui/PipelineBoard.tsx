import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PlanChapterView } from '../app/planning';
import type { WriterJob } from '../state/store';
import { PLAN_STATUS_LABEL } from '../app/labels';
import { SCENE_BOOK_STAGE_LABEL, type SceneBookStageNote } from '../app/workflows';
import { BookRevision } from './BookRevision';
import { useApp } from './store-context';


function writingCell(item: PlanChapterView, job: WriterJob | undefined, queued: boolean, sceneBook: SceneBookStageNote | null): string {
  const { plan } = item;
  if (job !== undefined && job.stage === 'writing') return `正在写${job.total > 0 ? `（${job.done} / ${job.total} 段）` : ''}`;
  // 推演整书（B86）正在做这一章：写手还没接手的阶段也在这里显示。
  if (sceneBook !== null && sceneBook.chapterId === item.chapter.id) return `推演成章：${SCENE_BOOK_STAGE_LABEL[sceneBook.stage]}`;
  if (queued) return '排队中';
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
 * 章数多于这些时，成书进度的表格与下面的章节计划各自放进一个滚动框，只渲染看得见的几十章（同章节目录的虚拟列表）。
 * 以前每章都全部渲染，200 章的书点“计划”要等一两秒（作者反馈 2026-10-25）。
 */
export const PLAN_VIRTUAL_FROM = 60;

type RowState = {
  readonly jobs: readonly WriterJob[];
  readonly sceneBook: SceneBookStageNote | null;
  readonly queued: ReadonlySet<string>;
  readonly building: string | null;
  readonly reviewing: string | null;
  readonly idle: boolean;
  readonly reviewOne: (id: string) => void;
  readonly openIssues: (id: string) => void;
};

/** 各章进度的表格。章数多于 PLAN_VIRTUAL_FROM 时只渲染看得见的行，上下用空行占住其余行的高度。 */
function ProgressTable({ chapters, state }: { readonly chapters: readonly PlanChapterView[]; readonly state: RowState }) {
  // useVirtualizer 的实例在滚动时原地更新，React Compiler 的缓存会让表格停在旧的范围，这一个组件不交给编译器（同章节目录）。
  'use no memo';
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = chapters.length > PLAN_VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    count: chapters.length,
    enabled: virtual,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 38,
    getItemKey: (i) => chapters[i]?.chapter.id ?? i,
    overscan: 10,
    initialRect: { width: 0, height: 480 },
  });
  const items = virtual ? virtualizer.getVirtualItems() : null;
  const shown = items === null ? chapters.map((item, index) => ({ item, index })) : items.flatMap((v) => (chapters[v.index] === undefined ? [] : [{ item: chapters[v.index]!, index: v.index }]));
  const top = items === null ? 0 : (items[0]?.start ?? 0);
  const bottom = items === null ? 0 : Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0));
  const measure = virtual ? virtualizer.measureElement : undefined;
  const { jobs, sceneBook, queued, building, reviewing, idle, reviewOne, openIssues } = state;
  return (
    <div className={virtual ? 'board-scroll' : undefined} ref={scrollRef}>
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
          {top > 0 ? (
            <tr aria-hidden="true" className="spacer-row" style={{ height: top }}>
              <td colSpan={6} />
            </tr>
          ) : null}
          {shown.map(({ item, index }) => {
            const id = item.chapter.id;
            const mine = jobs.find((j) => j.chapterId === id);
            return (
              <tr key={id} ref={measure} data-index={index} aria-label={item.chapter.title}>
                <th scope="row">{item.chapter.title}</th>
                <td>{item.plan === null ? '没有' : item.problems.length > 0 ? `有（${item.problems.length} 处要核对）` : '有'}</td>
                <td>{writingCell(item, mine, queued.has(id), sceneBook)}</td>
                <td>{memoryCell(item, mine?.stage === 'memory' || building === id)}</td>
                <td>{reviewCell(item, mine?.stage === 'review' || reviewing === id)}</td>
                <td>
                  {item.hasText ? (
                    <button type="button" disabled={!idle} aria-label={`审核${item.chapter.title}`} onClick={() => reviewOne(id)}>
                      审核
                    </button>
                  ) : null}
                  {item.pendingIssues > 0 ? (
                    <button type="button" disabled={!idle} aria-label={`查看${item.chapter.title}的问题`} onClick={() => openIssues(id)}>
                      查看问题
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
          {bottom > 0 ? (
            <tr aria-hidden="true" className="spacer-row" style={{ height: bottom }}>
              <td colSpan={6} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 成书流程看板（需求 B65）：按章显示计划、写作、长篇记忆与审核的状态；
 * 写下一章、依次写完或排定一段章节，可选写完后自动审核；审核出的问题可以一键交给写手修订（先估算费用）。
 * 作者随时可以停下，直接修改任何一步的结果。
 */
export function PipelineBoard() {
  const planning = useApp((s) => s.planning);
  const job = useApp((s) => s.writerJob);
  const jobs = useApp((s) => s.writerJobs);
  const sceneBook = useApp((s) => s.sceneBookStage);
  const reviewing = useApp((s) => s.reviewingChapterId);
  const building = useApp((s) => s.memoryBuilding);
  // AI 助手在后台写某一章时，这本书的写手已经在用（一本书一次只由一个写手写）。
  const assistantWriting = useApp((s) => s.assistantJobs.some((j) => j.kind === 'writing'));
  const busy = useApp((s) => s.busy);
  const write = useApp((s) => s.writeChapters);
  const stop = useApp((s) => s.cancelWriting);
  const reviewOne = useApp((s) => s.reviewFromBoard);
  const queue = useApp((s) => s.reviewQueue);
  const reviewAll = useApp((s) => s.reviewChapters);
  const stopQueue = useApp((s) => s.cancelReviewQueue);
  const openIssues = useApp((s) => s.openChapterReview);
  const revising = useApp((s) => s.reviseQueue !== null);
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
  const idle = !busy && job === null && !assistantWriting && reviewing === null && building === null && queue === null && !revising;
  // 已经写好的章节（写手没在写的），按书中顺序：可以依次审核。
  const written = planning.chapters.filter((c) => c.hasText && c.plan?.status !== 'writing').map((c) => c.chapter.id);
  const titleOf = (id: string) => planning.chapters.find((c) => c.chapter.id === id)?.chapter.title ?? '';
  const count = (f: (c: PlanChapterView) => boolean) => planning.chapters.filter(f).length;
  const issues = planning.chapters.reduce((n, c) => n + c.pendingIssues, 0);
  const queued = new Set(job?.queued ?? []);

  return (
    <section aria-label="成书进度">
      <h3>成书进度</h3>
      <p role="status" className="muted">
        共 {planning.chapters.length} 章：有计划 {count((c) => c.plan !== null)} 章，已写 {count((c) => c.plan?.status === 'written' || c.plan?.status === 'reviewed')} 章，已审核{' '}
        {count((c) => c.plan?.status === 'reviewed')} 章；待处理的审核问题 {issues} 条。
      </p>
      {queue !== null ? (
        <p role="status" aria-label="依次审核" className="skill-actions">
          <span>
            正在依次审核：第 {queue.done + 1} / {queue.total} 章《{titleOf(queue.chapterId)}》{queue.queued.length > 0 ? `，后面还有 ${queue.queued.length} 章` : ''}
          </span>
          <button type="button" onClick={stopQueue}>
            停下审核
          </button>
        </p>
      ) : null}
      <ProgressTable
        chapters={planning.chapters}
        state={{ jobs, sceneBook, queued, building, reviewing, idle, reviewOne: (id) => void reviewOne(id), openIssues: (id) => void openIssues(id) }}
      />
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
        <button type="button" disabled={!idle || written.length === 0} onClick={() => void reviewAll(written)}>
          依次审核已写好的 {written.length} 章
        </button>
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
      <BookRevision chapters={planning.chapters} idle={idle} />
    </section>
  );
}

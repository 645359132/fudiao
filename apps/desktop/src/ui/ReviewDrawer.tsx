import { useEffect, useState } from 'react';
import { ISSUE_SOURCE_LABEL } from '../app/labels';
import type { ReviewIssueView, RevisionScope } from '../app/review';
import { useRevisionStatus } from './BookRevision';
import { useApp } from './store-context';

const KIND: Readonly<Record<ReviewIssueView['kind'], string>> = {
  setting_conflict: '设定冲突',
  timeline: '时间线',
  pov_leak: '视角越界',
  foreshadow: '伏笔',
  character: '人物言行',
  off_plan: '偏离计划',
  pacing: '重复与节奏',
  ai_tone: 'AI 腔',
};

const SEVERITY: Readonly<Record<ReviewIssueView['severity'], string>> = { high: '严重', medium: '中等', low: '轻微' };

/** “全部交给写手修订”可选的严重程度。 */
const RANGES: Readonly<Record<'all' | 'serious' | 'high', { readonly label: string; readonly severities: RevisionScope['severities'] }>> = {
  all: { label: '全部问题', severities: null },
  serious: { label: '严重与中等', severities: ['high', 'medium'] },
  high: { label: '只修严重', severities: ['high'] },
};
/** 针对整章的问题（程序检查、没有引文）一键修订时跳过。 */
const wholeChapter = (i: ReviewIssueView) => i.source === 'program' && i.anchor.quote === '';

function Issue({ issue, locked, reviseLocked }: { readonly issue: ReviewIssueView; readonly locked: boolean; readonly reviseLocked: boolean }) {
  const reveal = useApp((s) => s.revealIssue);
  const resolve = useApp((s) => s.resolveIssue);
  const revise = useApp((s) => s.reviseIssue);
  const revising = useApp((s) => s.review?.revisingId === issue.id);
  return (
    <li className={`issue issue-${issue.severity}`} aria-label={`${KIND[issue.kind]}问题`}>
      <div className="issue-head">
        <span className="issue-kind">{KIND[issue.kind]}</span>
        <span className="muted">
          {SEVERITY[issue.severity]} · {ISSUE_SOURCE_LABEL[issue.source]}
        </span>
      </div>
      <button type="button" className="issue-quote" title="在正文中选中这一处" onClick={() => reveal(issue)}>
        {issue.anchor.quote === '' ? '定位到相关段落' : `“${issue.anchor.quote}”`}
      </button>
      <p>{issue.description}</p>
      {issue.evidenceText.length > 0 ? (
        <ul className="issue-evidence" aria-label="依据">
          {issue.evidenceText.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      {issue.suggestion === '' ? null : <p className="muted">建议：{issue.suggestion}</p>}
      <div className="skill-actions">
        <button type="button" disabled={locked} onClick={() => void resolve(issue.id, 'ignored')}>
          忽略
        </button>
        <button type="button" disabled={locked} title="我已经自己改好了" onClick={() => void resolve(issue.id, 'fixed')}>
          已修改
        </button>
        <button type="button" disabled={locked || reviseLocked} title="写手只改这一段，写入前保存快照" onClick={() => void revise(issue.id)}>
          {revising ? '写手正在修订…' : '交给写手修订'}
        </button>
      </div>
    </li>
  );
}

/**
 * 审核（需求 B64）：本章待处理的问题，定位到段落与引文，写明依据与修改建议。
 * 作者可以忽略、自己修改后标为已修改，或交给写手修订这一段；也可以按严重程度把本章的问题一键交给写手（B64 补充）。
 */
export function ReviewDrawer() {
  const open = useApp((s) => s.drawer?.kind === 'review');
  const review = useApp((s) => s.review);
  const chapterId = useApp((s) => s.selectedChapterId);
  const saved = useApp((s) => s.saveStatus.kind === 'saved');
  const close = useApp((s) => s.closeReview);
  const run = useApp((s) => s.runReview);
  const cancel = useApp((s) => s.cancelReview);
  const refresh = useApp((s) => s.refreshReview);
  const reviseAll = useApp((s) => s.reviseIssues);
  const stopRevising = useApp((s) => s.cancelReviseQueue);
  // 一键修订在进行（本章或书一级的一批）：单条修订先等它做完；正在修订的正是本章时，这一章的问题都先不动。
  const batch = useApp((s) => s.reviseQueue);
  const writing = useApp((s) => s.writerJob !== null);
  const status = useRevisionStatus();
  const [range, setRange] = useState<keyof typeof RANGES>('all');
  const visible = open && review !== null && review.chapterId === chapterId;
  // 正文保存后重新读取：改过的段落上的问题已经过期。
  useEffect(() => {
    if (visible && saved) void refresh();
  }, [visible, saved, refresh]);
  if (!visible) return null;
  const here = batch !== null && (batch.chapterId === review.chapterId || batch.chapterId === '');
  const locked = review.running || review.revisingId !== null || here;
  const reviseLocked = batch !== null || writing;
  const severities = RANGES[range].severities;
  const chosen = review.issues.filter((i) => severities === null || severities.includes(i.severity));
  const revisable = chosen.filter((i) => !wholeChapter(i)).length;
  return (
    <aside className="entity-drawer review-drawer" aria-label="审核">
      <div className="entity-head">
        <h3>审核</h3>
        <span className="spacer" />
        <button type="button" disabled={locked} onClick={() => void run()}>
          审核本章
        </button>
        <button type="button" aria-label="关闭审核" onClick={close}>
          ×
        </button>
      </div>
      <p role="status" className="muted">
        {here && status !== null ? status : review.running ? '正在审核…' : review.revisingId !== null ? '写手正在修订…' : (review.note ?? `待处理的问题 ${review.issues.length} 条`)}
        {here ? (
          <button type="button" onClick={stopRevising}>
            停下修订
          </button>
        ) : locked ? (
          <button type="button" onClick={cancel}>
            取消
          </button>
        ) : null}
      </p>
      {review.issues.length > 0 ? (
        <div className="skill-actions">
          <select aria-label="一键修订的范围" value={range} disabled={locked} onChange={(e) => setRange(e.target.value as keyof typeof RANGES)}>
            {Object.entries(RANGES).map(([key, r]) => (
              <option key={key} value={key}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={locked || reviseLocked || revisable === 0}
            title={`本章 ${chosen.length} 条逐条交给写手修订${chosen.length > revisable ? `（${chosen.length - revisable} 条针对整章，跳过）` : ''}；改之前存一份快照`}
            onClick={() => void reviseAll({ chapterIds: [review.chapterId], severities })}
          >
            全部交给写手修订
          </button>
        </div>
      ) : null}
      <ul className="issue-list" aria-label="待处理的问题">
        {review.issues.map((issue) => (
          <Issue key={issue.id} issue={issue} locked={locked} reviseLocked={reviseLocked} />
        ))}
      </ul>
    </aside>
  );
}

import { useEffect } from 'react';
import type { ReviewIssueView } from '../app/review';
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

function Issue({ issue, locked }: { readonly issue: ReviewIssueView; readonly locked: boolean }) {
  const reveal = useApp((s) => s.revealIssue);
  const resolve = useApp((s) => s.resolveIssue);
  const revise = useApp((s) => s.reviseIssue);
  const revising = useApp((s) => s.review?.revisingId === issue.id);
  return (
    <li className={`issue issue-${issue.severity}`} aria-label={`${KIND[issue.kind]}问题`}>
      <div className="issue-head">
        <span className="issue-kind">{KIND[issue.kind]}</span>
        <span className="muted">
          {SEVERITY[issue.severity]} · {issue.source === 'program' ? '程序检查' : '模型审核'}
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
        <button type="button" disabled={locked} title="写手只改这一段，写入前保存快照" onClick={() => void revise(issue.id)}>
          {revising ? '写手正在修订…' : '交给写手修订'}
        </button>
      </div>
    </li>
  );
}

/**
 * 审核（需求 B64）：本章待处理的问题，定位到段落与引文，写明依据与修改建议。
 * 作者可以忽略、自己修改后标为已修改，或交给写手修订这一段。
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
  const visible = open && review !== null && review.chapterId === chapterId;
  // 正文保存后重新读取：改过的段落上的问题已经过期。
  useEffect(() => {
    if (visible && saved) void refresh();
  }, [visible, saved, refresh]);
  if (!visible) return null;
  const locked = review.running || review.revisingId !== null;
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
        {review.running ? '正在审核…' : review.revisingId !== null ? '写手正在修订…' : (review.note ?? `待处理的问题 ${review.issues.length} 条`)}
        {locked ? (
          <button type="button" onClick={cancel}>
            取消
          </button>
        ) : null}
      </p>
      <ul className="issue-list" aria-label="待处理的问题">
        {review.issues.map((issue) => (
          <Issue key={issue.id} issue={issue} locked={locked} />
        ))}
      </ul>
    </aside>
  );
}

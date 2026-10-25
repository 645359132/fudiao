import { useState } from 'react';
import type { PlanChapterView } from '../app/planning';
import type { RevisionQuote, RevisionScope } from '../app/review';
import { useApp } from './store-context';

type Severity = NonNullable<RevisionScope['severities']>[number];
const SEVERITIES: readonly { readonly key: Severity; readonly label: string }[] = [
  { key: 'high', label: '严重' },
  { key: 'medium', label: '中等' },
  { key: 'low', label: '轻微' },
];

/** 预计读成一句话：条数、跳过的、调用次数、用量与费用。 */
export function quoteText(q: RevisionQuote): string {
  const cost = q.costUsd === null ? `${q.model ?? '默认模型'}没有配置价格，费用未知` : `约 $${q.costUsd.toFixed(2)}（按 ${q.model ?? '默认模型'} 的价格）`;
  const tokens = Math.round((q.inputTokens + q.outputTokens) / 1000);
  return `交给写手 ${q.issues} 条，涉及 ${q.chapterIds.length} 章${q.wholeChapter > 0 ? `（其中 ${q.wholeChapter} 条针对整章，会跳过）` : ''}：预计调用模型 ${q.calls} 次、约 ${tokens} 千 Token，${cost}。思考的多少因模型而异，只作参考。`;
}

/** 一键修订的进度读成一句话（成书进度与审核抽屉共用）。 */
export function useRevisionStatus(): string | null {
  const queue = useApp((s) => s.reviseQueue);
  const title = useApp((s) => s.work?.chapters.find((c) => c.id === s.reviseQueue?.chapterId)?.title ?? '');
  if (queue === null) return null;
  const where = queue.chapters > 1 && title !== '' ? `第 ${queue.chapterIndex + 1} / ${queue.chapters} 章《${title}》，` : '';
  return `写手正在修订审核问题：${where}已处理 ${queue.done} / ${queue.total} 条（修订 ${queue.revised}、跳过 ${queue.skipped}、失败 ${queue.failed}）`;
}

/**
 * 书一级的一键修订（B64 补充）：选范围与严重程度，先估算条数与费用，作者确认后在后台逐章交给写手。
 * 改了范围或严重程度要重新估算，开始的正是估算的那个范围。
 */
export function BookRevision({ chapters, idle }: { readonly chapters: readonly PlanChapterView[]; readonly idle: boolean }) {
  const queue = useApp((s) => s.reviseQueue);
  const result = useApp((s) => s.reviseResult);
  const quoteRevision = useApp((s) => s.quoteRevision);
  const revise = useApp((s) => s.reviseIssues);
  const stop = useApp((s) => s.cancelReviseQueue);
  const status = useRevisionStatus();
  const [chosen, setChosen] = useState<readonly Severity[]>(['high', 'medium']);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [quote, setQuote] = useState<{ readonly scope: RevisionScope; readonly value: RevisionQuote } | null>(null);
  const [busy, setBusy] = useState(false);

  const withIssues = chapters.filter((c) => c.pendingIssues > 0);
  if (withIssues.length === 0 && queue === null && result === null) return null;
  const ids = withIssues.map((c) => c.chapter.id);
  const fromId = ids.includes(from) ? from : (ids[0] ?? '');
  const toId = ids.includes(to) ? to : (ids.at(-1) ?? '');
  const range = ids.slice(ids.indexOf(fromId), ids.indexOf(toId) + 1);
  const whole = range.length === ids.length;
  const scope: RevisionScope = { chapterIds: whole ? null : range, severities: chosen.length === SEVERITIES.length ? null : [...chosen] };
  const total = withIssues.filter((c) => range.includes(c.chapter.id)).reduce((n, c) => n + c.pendingIssues, 0);
  // 改了范围或严重程度，先前的估算作废。
  const change = (f: () => void) => {
    f();
    setQuote(null);
  };
  const estimate = async () => {
    setBusy(true);
    const value = await quoteRevision(scope);
    setBusy(false);
    if (value !== null) setQuote({ scope, value });
  };
  const begin = async () => {
    if (quote === null) return;
    const started = quote.scope;
    setQuote(null);
    await revise(started);
  };

  return (
    <section aria-label="一键修订审核问题" className="book-revision">
      <h4>一键修订审核问题</h4>
      {status !== null ? (
        <p role="status" className="skill-actions">
          <span>{status}</span>
          <button type="button" onClick={stop}>
            停下修订
          </button>
        </p>
      ) : (
        <>
          {result !== null ? (
            <p role="status" className="muted">
              {result}
            </p>
          ) : null}
          {ids.length > 0 ? (
            <>
              <div className="skill-actions">
                {ids.length > 1 ? (
                  <>
                    <label>
                      从
                      <select aria-label="从哪一章修起" value={fromId} onChange={(e) => change(() => setFrom(e.target.value))}>
                        {withIssues.map((c) => (
                          <option key={c.chapter.id} value={c.chapter.id}>
                            {c.chapter.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      到
                      <select aria-label="修到哪一章" value={toId} onChange={(e) => change(() => setTo(e.target.value))}>
                        {withIssues.map((c) => (
                          <option key={c.chapter.id} value={c.chapter.id}>
                            {c.chapter.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}
                {SEVERITIES.map((s) => (
                  <label key={s.key}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(s.key)}
                      onChange={(e) => change(() => setChosen(e.target.checked ? SEVERITIES.map((x) => x.key).filter((k) => k === s.key || chosen.includes(k)) : chosen.filter((k) => k !== s.key)))}
                    />
                    {s.label}
                  </label>
                ))}
                <button type="button" disabled={!idle || busy || chosen.length === 0 || range.length === 0} onClick={() => void estimate()}>
                  估算 {range.length} 章 {total} 条问题的费用
                </button>
              </div>
              {quote !== null ? (
                <div className="skill-actions" role="group" aria-label="修订前确认">
                  <span>
                    范围里待处理：严重 {quote.value.bySeverity.high} 条、中等 {quote.value.bySeverity.medium} 条、轻微 {quote.value.bySeverity.low} 条。{quoteText(quote.value)}每章改之前存快照，可以在版本快照里恢复。
                  </span>
                  <button type="button" disabled={!idle || quote.value.issues - quote.value.wholeChapter === 0} onClick={() => void begin()}>
                    开始修订
                  </button>
                  <button type="button" onClick={() => setQuote(null)}>
                    不修了
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

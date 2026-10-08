import { SOURCE_LABELS } from '@fudiao/editor';
import type { SourceKind, SourceTally } from '@fudiao/store';
import { useApp } from './store-context';

const KINDS: readonly SourceKind[] = ['handwritten', 'ai_generated', 'ai_modified', 'mixed'];

const number = (n: number) => n.toLocaleString('zh-CN');
/** AI 参与比例：AI 文字的字数占总字数，保留一位小数。 */
export const aiRatio = (t: SourceTally) => (t.words === 0 ? '—' : `${((t.aiWords / t.words) * 100).toFixed(1)}%`);

function Cells({ tally }: { readonly tally: SourceTally }) {
  return (
    <>
      <td>{number(tally.words)}</td>
      <td>{aiRatio(tally)}</td>
      {KINDS.map((k) => (
        <td key={k}>{number(tally.bySource[k])}</td>
      ))}
    </>
  );
}

/** 段落来源（需求 B33）：每章与全书的 AI 参与比例、各来源的字数，以及正文来源色条的开关。 */
export function SourcesPanel() {
  const stats = useApp((s) => s.sourceStats);
  const show = useApp((s) => s.library?.preferences.showParagraphSource ?? true);
  const setShow = useApp((s) => s.setShowParagraphSource);
  const showPanel = useApp((s) => s.showPanel);
  const busy = useApp((s) => s.busy);

  return (
    <section aria-label="段落来源" className="sources">
      <div className="history-head">
        <h2>段落来源</h2>
        <button type="button" onClick={() => void showPanel('chapter')}>
          返回正文
        </button>
      </div>
      <p className="muted">
        AI 参与比例 = 来自 AI 的文字字数 ÷ 总字数。接受的候选稿记为“AI 生成”；作者改动超过生成原文的 10% 后记为“AI 生成后修改”；合并了不同来源的段落记为“混合”，按字符分别计入。不含回收站中的章节。发布前请核实连载平台对
        AI 内容的披露规则。
      </p>
      <label className="check">
        <input type="checkbox" checked={show} disabled={busy} onChange={(e) => void setShow(e.currentTarget.checked)} />
        在正文左侧显示来源色条（对所有作品生效）
      </label>
      <ul className="source-legend" aria-label="色条说明">
        {KINDS.filter((k) => k !== 'handwritten').map((k) => (
          <li key={k}>
            <span className={`swatch source-${k}`} aria-hidden="true" />
            {SOURCE_LABELS[k]}
          </li>
        ))}
        <li>手写段落不显示色条</li>
      </ul>
      {stats === null ? null : (
        <table className="source-table" aria-label="来源统计">
          <thead>
            <tr>
              <th scope="col">章节</th>
              <th scope="col">字数</th>
              <th scope="col">AI 参与比例</th>
              {KINDS.map((k) => (
                <th key={k} scope="col">
                  {SOURCE_LABELS[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.chapters.map((c) => (
              <tr key={c.chapterId}>
                <th scope="row">{c.title}</th>
                <Cells tally={c} />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">全书</th>
              <Cells tally={stats.total} />
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}

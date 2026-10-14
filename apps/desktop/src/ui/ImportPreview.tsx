import { useState } from 'react';
import { splitText, summarize, type SplitRule } from '../app/text-import';
import { baseName } from '../state/store';
import { useApp } from './store-context';

/** 可改选的编码：识别结果不对时由作者指定。 */
const ENCODINGS = ['UTF-8', 'GB18030', 'Big5', 'UTF-16LE', 'UTF-16BE'];

const RULES: { readonly kind: SplitRule['kind']; readonly label: string }[] = [
  { kind: 'auto', label: '自动识别章节标题（第…章、序章、楔子、番外等）' },
  { kind: 'markdown', label: 'Markdown 标题（# 至 ###）' },
  { kind: 'none', label: '不拆分，整篇为一章' },
  { kind: 'custom', label: '自定义规则（正则表达式，匹配一整行）' },
];

/** 导入预览（需求 B07“明确编码和章节拆分方式”）：确认之后才写入作品。 */
export function ImportPreview() {
  const draft = useApp((s) => s.importDraft);
  const setRule = useApp((s) => s.setImportRule);
  const setEncoding = useApp((s) => s.setImportEncoding);
  const cancel = useApp((s) => s.cancelImport);
  const confirm = useApp((s) => s.confirmImport);
  const busy = useApp((s) => s.busy);
  const [pattern, setPattern] = useState('^【.+】$');
  if (draft === null) return null;

  const { decoded, rule } = draft;
  const split = splitText(decoded.text, rule, baseName(decoded.fileName));
  const preview = split.ok ? summarize(split.value) : [];
  const total = preview.reduce((n, c) => n + c.words, 0);
  const volumes = new Set(preview.flatMap((c) => (c.volume === undefined ? [] : [c.volume]))).size;
  const encodings = ENCODINGS.some((e) => e.toLowerCase() === decoded.encoding.toLowerCase()) ? ENCODINGS : [decoded.encoding, ...ENCODINGS];

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="导入预览">
      <div className="dialog">
        <h2>{draft.target === 'new' ? '导入为新作品' : '导入章节到当前作品末尾'}</h2>
        <p className="muted">文件：{decoded.fileName}</p>
        <label>
          编码
          <select value={encodings.find((e) => e.toLowerCase() === decoded.encoding.toLowerCase()) ?? decoded.encoding} onChange={(e) => void setEncoding(e.target.value)}>
            {encodings.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        {decoded.hadErrors && <p className="field-error">有文字无法按这种编码识别（显示为 �），请换一种编码。</p>}
        <fieldset>
          <legend>章节拆分</legend>
          {RULES.map((r) => (
            <label key={r.kind} className="radio">
              <input
                type="radio"
                name="split-rule"
                checked={rule.kind === r.kind}
                onChange={() => setRule(r.kind === 'custom' ? { kind: 'custom', pattern } : { kind: r.kind })}
              />
              {r.label}
            </label>
          ))}
          {rule.kind === 'custom' && (
            <input
              aria-label="自定义规则"
              value={pattern}
              onChange={(e) => {
                setPattern(e.target.value);
                setRule({ kind: 'custom', pattern: e.target.value });
              }}
            />
          )}
        </fieldset>
        {split.ok ? (
          <>
            <p>
              共 {preview.length} 章，{total.toLocaleString('zh-CN')} 字
              {volumes > 0 ? `，分 ${volumes} 卷` : ''}
            </p>
            <ol className="import-chapters" aria-label="拆分结果">
              {preview.slice(0, 500).map((c, i) => (
                <li key={i}>
                  <span>
                    {c.volume !== undefined && c.volume !== preview[i - 1]?.volume ? <strong className="import-volume">{c.volume}</strong> : null}
                    {c.title}
                  </span>
                  <span className="muted">
                    {c.paragraphs} 段 · {c.words.toLocaleString('zh-CN')} 字
                  </span>
                </li>
              ))}
            </ol>
            {preview.length > 500 && <p className="muted">只列出前 500 章。</p>}
          </>
        ) : (
          <p className="field-error">{split.error}</p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy || !split.ok || preview.length === 0} onClick={() => void confirm()}>
            导入
          </button>
          <button type="button" onClick={() => void cancel()}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

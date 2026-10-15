import { useEffect, useRef, useState } from 'react';
import type { AssistantItem } from '../app/assistant';
import { toolLabel } from '../app/assistant-tools';
import { Icon } from './Icon';
import { useApp } from './store-context';

const SUGGESTIONS_NO_WORK = ['帮我开一本古风悬疑小说，主角是被革职的捕快', '打开我最近写的那部作品'];
const SUGGESTIONS = ['给主角建一张人物卡片', '完善这部作品的世界观：地点、组织与规则', '按大纲生成 20 章的章节计划', '续写正在看的这一章', '审核正在看的这一章'];
/** 选中文字后对话框上方的快捷说法。 */
const SELECTION_ASKS: readonly (readonly [string, string])[] = [
  ['润色', '把选中的文字润色一下'],
  ['扩写', '把选中的文字扩写得更细一些'],
  ['缩写', '把选中的文字缩短一些，保留要紧的内容'],
  ['改写', '把选中的文字改写一遍，节奏更紧一些'],
];
/** 动作结果里的标识是给模型看的，界面上不显示。 */
const ID_TAG = /\s*\[[0-9A-HJKMNP-TV-Z]{26}\]/g;
const withoutIds = (text: string) => text.replace(ID_TAG, '');

function Steps({ item }: { readonly item: Extract<AssistantItem, { role: 'results' }> }) {
  return (
    <ul className="assistant-steps" aria-label="助手执行的动作">
      {item.results.map((r, i) => {
        const [first = '', ...rest] = withoutIds(r.detail).split('\n');
        return (
          <li key={i} className={r.ok ? 'step ok' : 'step failed'}>
            <span className="step-icon">
              <Icon name={r.ok ? 'check' : 'alert'} size={13} />
            </span>
            <span className="step-body">
              <strong>{toolLabel(r.tool)}</strong> <span className="step-detail">{first}</span>
              {rest.length > 0 ? (
                <details>
                  <summary>展开</summary>
                  <pre>{rest.join('\n')}</pre>
                </details>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Pending({ item, active }: { readonly item: Extract<AssistantItem, { role: 'pending' }>; readonly active: boolean }) {
  const resolve = useApp((s) => s.resolveAssistant);
  return (
    <div className="assistant-confirm" role="group" aria-label="需要确认">
      <p>
        <Icon name="alert" size={14} /> 助手想要<strong>{item.summary}</strong>，确认吗？
      </p>
      {active ? (
        <div className="form-actions">
          <button type="button" className="primary danger" onClick={() => void resolve(true)}>
            确认执行
          </button>
          <button type="button" onClick={() => void resolve(false)}>
            不要执行
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * AI 助手（B69）：右侧的对话框。作者用平常的话说要做的事，助手用作者配置的默认模型理解意图、操作软件，
 * 每个动作的结果列在对话里；删除与覆盖类的动作先请作者确认。
 */
export function AssistantPanel() {
  const items = useApp((s) => s.assistantItems);
  const running = useApp((s) => s.assistantRunning);
  const owner = useApp((s) => s.assistantFor);
  const workId = useApp((s) => s.work?.project.id ?? '');
  const hasWork = useApp((s) => s.work !== null);
  const load = useApp((s) => s.loadAssistant);
  const send = useApp((s) => s.sendAssistant);
  const stop = useApp((s) => s.stopAssistant);
  const clear = useApp((s) => s.clearAssistant);
  const toggle = useApp((s) => s.toggleAssistant);
  const openModelServices = useApp((s) => s.openModelServices);
  const draft = useApp((s) => s.assistantDraft);
  const progress = useApp((s) => s.assistantProgress);
  const selection = useApp((s) => (s.panel === 'chapter' && s.editorSelection !== null && s.editorSelection.key !== s.selectionDismissed ? s.editorSelection : null));
  const dismissSelection = useApp((s) => s.dismissSelection);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);

  // 打开或换了作品时读取那部作品的对话。
  useEffect(() => {
    if (owner !== workId) void load();
  }, [owner, workId, load]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [items.length, running, draft, progress]);

  const submit = (value: string) => {
    if (value.trim() === '' || running) return;
    // 发出即清空输入框；没有发出去（例如正文没能保存）时放回去。
    setText('');
    void send(value).then((sent) => {
      if (!sent) setText((now) => (now === '' ? value : now));
    });
  };
  const last = items.at(-1);

  return (
    <aside className="assistant" aria-label="AI 助手">
      <header className="assistant-head">
        <span className="assistant-title">
          <Icon name="sparkle" /> AI 助手
        </span>
        <span className="spacer" />
        <button type="button" className="ghost" disabled={running || items.length === 0} title="清空对话，重新开始" onClick={() => void clear()}>
          新对话
        </button>
        <button type="button" className="ghost icon-only" aria-label="收起助手" title="收起助手" onClick={toggle}>
          <Icon name="close" />
        </button>
      </header>
      <div className="assistant-log" role="log" aria-label="对话">
        {items.length === 0 ? (
          <div className="assistant-empty">
            <p className="assistant-hello">想做什么，直接告诉我。</p>
            <p className="muted">
              我可以开新书、建卷与章节、写人物卡片和世界观、做章节计划与伏笔、让写手写章或续写、修改你选中的文字、审核与导出。用的是你在
              <button type="button" className="link" aria-label="打开模型服务" onClick={() => void openModelServices()}>
                模型服务
              </button>
              里设置的默认模型。
            </p>
            <div className="assistant-suggestions">
              {(hasWork ? SUGGESTIONS : SUGGESTIONS_NO_WORK).map((s) => (
                <button key={s} type="button" className="chip" disabled={running} onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          items.map((item) => {
            switch (item.role) {
              case 'user':
                return (
                  <div key={item.id} className="bubble user">
                    {item.text}
                  </div>
                );
              case 'assistant':
                return item.output.message.trim() === '' ? null : (
                  <div key={item.id} className="bubble bot">
                    {item.output.message}
                  </div>
                );
              case 'results':
                return <Steps key={item.id} item={item} />;
              case 'pending':
                return <Pending key={item.id} item={item} active={!running && last?.id === item.id} />;
            }
          })
        )}
        {running && draft !== null && draft.trim() !== '' ? (
          <div className="bubble bot streaming" aria-live="polite">
            {draft}
            <span className="caret" aria-hidden="true" />
          </div>
        ) : null}
        {running && (progress !== null || draft === null) ? (
          <div className="assistant-thinking" role="status">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {progress ?? '正在思考……'}
          </div>
        ) : null}
        <div ref={end} />
      </div>
      {selection !== null ? (
        <div className="assistant-selection" role="group" aria-label="选中的文字">
          <span className="assistant-selection-text" title={selection.preview}>
            已选中 {selection.length} 字：「{selection.preview}
            {selection.length > selection.preview.length ? '…' : ''}」
          </span>
          <span className="assistant-selection-asks">
            {SELECTION_ASKS.map(([label, ask]) => (
              <button key={label} type="button" className="chip" disabled={running} onClick={() => submit(ask)}>
                {label}
              </button>
            ))}
          </span>
          <button type="button" className="ghost icon-only" aria-label="不带上选中的文字" title="这次不带上选中的文字" onClick={dismissSelection}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}
      <form
        className="assistant-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <textarea
          aria-label="给助手的话"
          rows={3}
          placeholder={hasWork ? '例如：给第三章加一个反派出场的情节点' : '例如：帮我开一本武侠小说'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 回车发送，Shift+回车换行；输入法组合中的回车用来选字，不发送。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(text);
            }
          }}
        />
        {running ? (
          <button type="button" className="send" aria-label="停止" title="停止" onClick={stop}>
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" className="send primary" aria-label="发送" title="发送（回车）" disabled={text.trim() === ''}>
            <Icon name="send" />
          </button>
        )}
      </form>
    </aside>
  );
}

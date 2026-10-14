import { useEffect, useRef, useState } from 'react';
import type { AssistantItem } from '../app/assistant';
import { Icon } from './Icon';
import { useApp } from './store-context';

/** 动作在对话里的名称。 */
const TOOL_LABEL: Readonly<Record<string, string>> = {
  list_chapters: '查看章节',
  read_chapter: '读章节',
  search_text: '查找正文',
  get_entity: '查看设定',
  list_facts: '查看事实',
  get_chapter_plan: '查看章节计划',
  create_work: '新建作品',
  open_work: '打开作品',
  update_work: '修改作品信息',
  create_volume: '新建卷',
  update_volume: '修改卷',
  move_volume: '调整卷的顺序',
  delete_volume: '删除卷',
  create_chapter: '新建章节',
  update_chapter: '修改章节',
  move_chapter: '移动章节',
  trash_chapter: '移入回收站',
  open_chapter: '打开章节',
  create_entity: '新建设定',
  update_entity: '修改设定',
  delete_entity: '删除设定',
  add_fact: '记录事实',
  save_chapter_plan: '保存章节计划',
  plan_chapters: '生成章节计划',
  write_chapter: '写手写章',
  continue_chapter: '续写',
  open_page: '打开页面',
};

const SUGGESTIONS_NO_WORK = ['帮我开一本古风悬疑小说，主角是被革职的捕快', '打开我最近写的那部作品'];
const SUGGESTIONS = ['给主角建一张人物卡片', '完善这部作品的世界观：地点、组织与规则', '按大纲生成 20 章的章节计划', '续写正在看的这一章', '把全书分成三卷'];

function Steps({ item }: { readonly item: Extract<AssistantItem, { role: 'results' }> }) {
  return (
    <ul className="assistant-steps" aria-label="助手执行的动作">
      {item.results.map((r, i) => {
        const [first = '', ...rest] = r.detail.split('\n');
        return (
          <li key={i} className={r.ok ? 'step ok' : 'step failed'}>
            <span className="step-icon">
              <Icon name={r.ok ? 'check' : 'alert'} size={13} />
            </span>
            <span className="step-body">
              <strong>{TOOL_LABEL[r.tool] ?? r.tool}</strong> <span className="step-detail">{first}</span>
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
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);

  // 打开或换了作品时读取那部作品的对话。
  useEffect(() => {
    if (owner !== workId) void load();
  }, [owner, workId, load]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [items.length, running]);

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
              我可以开新书、建卷与章节、写人物卡片和世界观、做章节计划、让写手写章或续写。用的是你在
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
        {running ? (
          <div className="assistant-thinking" role="status">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            正在处理……
          </div>
        ) : null}
        <div ref={end} />
      </div>
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

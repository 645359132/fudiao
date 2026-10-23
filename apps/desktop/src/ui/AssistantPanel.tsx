import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { undoTarget, waitingItem, type AssistantConversationView, type AssistantItem, type AssistantUsage } from '../app/assistant';
import { toolLabel } from '../app/assistant-tools';
import type { AssistantEffort } from '../app/library';
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

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 历史对话：这部作品的各段对话，点一段切过去接着看、接着说；正在看的那一段可以删掉。 */
function History({
  conversations,
  current,
  disabled,
  onOpen,
  onDelete,
}: {
  readonly conversations: readonly AssistantConversationView[];
  readonly current: string | null;
  readonly disabled: boolean;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
}) {
  const saved = conversations.some((c) => c.id === current);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="ghost" disabled={disabled} aria-label="历史对话" title="这部作品之前的对话">
          <Icon name="history" size={14} />
          历史
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content composer-menu" side="bottom" align="end" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Label className="menu-label">这部作品的对话</DropdownMenu.Label>
          {saved ? null : (
            <DropdownMenu.Item className="menu-item composer-option" disabled>
              <span className="composer-check">
                <Icon name="check" size={13} />
              </span>
              <span className="composer-option-name">新对话</span>
              <span className="muted composer-option-note">还没有说话</span>
            </DropdownMenu.Item>
          )}
          {conversations.map((c) => (
            <DropdownMenu.Item key={c.id} className="menu-item composer-option" onSelect={() => onOpen(c.id)}>
              <span className="composer-check">{c.id === current ? <Icon name="check" size={13} /> : null}</span>
              <span className="composer-option-name">{c.title}</span>
              <span className="muted composer-option-note">
                {when(c.updatedAt)} · {c.messages} 条
              </span>
            </DropdownMenu.Item>
          ))}
          {conversations.length === 0 ? (
            <DropdownMenu.Item className="menu-item" disabled>
              还没有之前的对话
            </DropdownMenu.Item>
          ) : null}
          {saved && current !== null ? (
            <>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item className="menu-item" onSelect={() => onDelete(current)}>
                <Icon name="trash" size={14} />
                删除正在看的这段对话
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

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

/** 一轮对话之后的“撤销这一轮的改动”：只在最近一轮有改动、还没有撤销时出现。 */
function UndoTurn() {
  const undo = useApp((s) => s.undoAssistant);
  return (
    <div className="assistant-undo">
      <button type="button" className="ghost" title="把助手这一轮对作品的改动改回去（候选稿、审核结果与推演记录照旧保留）" onClick={() => void undo()}>
        <Icon name="undo" size={13} /> 撤销这一轮的改动
      </button>
    </div>
  );
}

const EFFORTS: readonly AssistantEffort[] = ['low', 'medium', 'high'];
const EFFORT_LABEL: Readonly<Record<AssistantEffort, string>> = { low: '低', medium: '中', high: '高' };
const EFFORT_HINT: Readonly<Record<AssistantEffort, string>> = {
  low: '想得浅：回复快，费用低',
  medium: '平衡：大多数事情用它',
  high: '想得深：复杂的安排更稳，回复慢、费用高',
};

const tokens = (n: number) => n.toLocaleString('zh-CN');

/** 对话框下方的模型选择：选中的就是默认模型，所有 AI 功能都用它（与“模型服务”页的默认模型相同）。 */
function ModelMenu() {
  const services = useApp((s) => s.modelServices);
  const setDefault = useApp((s) => s.setDefaultModel);
  const openModelServices = useApp((s) => s.openModelServices);
  const running = useApp((s) => s.assistantRunning);
  const models = services?.models ?? [];
  const current = models.find((m) => m.id === services?.defaultModelId) ?? null;
  const providerName = (id: string) => services?.providers.find((p) => p.id === id)?.name ?? '';
  const name = current?.displayName ?? (models.length === 0 ? '还没有模型' : '选择模型');
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="composer-chip" disabled={running} aria-label={`模型：${name}`} title="选择模型（所有 AI 功能都用它）">
          <Icon name="model" size={14} />
          <span className="composer-chip-text">{name}</span>
          <Icon name="chevronDown" size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content composer-menu" side="top" align="start" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Label className="menu-label">模型（所有 AI 功能都用它）</DropdownMenu.Label>
          {models.length === 0 ? (
            <DropdownMenu.Item className="menu-item" disabled>
              还没有添加模型
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.RadioGroup value={services?.defaultModelId ?? ''} onValueChange={(id) => void setDefault(id)}>
              {models.map((m) => (
                <DropdownMenu.RadioItem key={m.id} className="menu-item composer-option" value={m.id}>
                  <span className="composer-check">
                    <DropdownMenu.ItemIndicator>
                      <Icon name="check" size={13} />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="composer-option-name">{m.displayName}</span>
                  <span className="muted composer-option-note">
                    {providerName(m.providerId)}
                    {m.capabilities.selfTestPassed ? '' : ' · 未通过能力自检'}
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          )}
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" onSelect={() => void openModelServices()}>
            <Icon name="settings" size={14} />
            管理模型服务…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** 助手每一步的思考深度。模型不能调节思考深度时不可选。 */
function EffortMenu() {
  const effort = useApp((s) => s.library?.preferences.assistant.effort ?? 'medium');
  const setEffort = useApp((s) => s.setAssistantEffort);
  const running = useApp((s) => s.assistantRunning);
  const adjustable = useApp((s) => {
    const services = s.modelServices;
    const model = services?.models.find((m) => m.id === services.defaultModelId);
    return model === undefined || model.capabilities.reasoningControl === 'effort';
  });
  const label = adjustable ? `思考：${EFFORT_LABEL[effort]}` : '思考：不可调';
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="composer-chip"
          disabled={running || !adjustable}
          aria-label={label}
          title={adjustable ? 'AI 助手每一步想多深（写手、审核等任务各用自己的深度）' : '这个模型不能调节思考深度'}
        >
          <Icon name="brain" size={14} />
          <span className="composer-chip-text">{label}</span>
          <Icon name="chevronDown" size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content composer-menu" side="top" align="start" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Label className="menu-label">AI 助手的思考深度</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={effort} onValueChange={(value) => void setEffort(value as AssistantEffort)}>
            {EFFORTS.map((e) => (
              <DropdownMenu.RadioItem key={e} className="menu-item composer-option" value={e}>
                <span className="composer-check">
                  <DropdownMenu.ItemIndicator>
                    <Icon name="check" size={13} />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="composer-option-name">{EFFORT_LABEL[e]}</span>
                <span className="muted composer-option-note">{EFFORT_HINT[e]}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** 上下文用量：最近一步发给模型的内容占模型上下文上限的比例。新对话的第一步之前不显示。 */
function ContextMeter({ usage }: { readonly usage: AssistantUsage }) {
  const ratio = Math.min(1, usage.promptTokens / usage.contextWindow);
  const percent = ratio > 0 && ratio < 0.01 ? '<1%' : `${Math.round(ratio * 100)}%`;
  const level = ratio >= 0.9 ? ' danger' : ratio >= 0.7 ? ' warn' : '';
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      className={`context-meter${level}`}
      role="img"
      aria-label={`上下文用了 ${percent}`}
      title={`上下文：最近一步发给模型约 ${tokens(usage.promptTokens)} Token，占这个模型上限 ${tokens(usage.contextWindow)} 的 ${percent}。对话很长时，较早的部分会自动不再带上；也可以点“新对话”重新开始。`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="context-track" cx="8" cy="8" r={radius} />
        <circle className="context-fill" cx="8" cy="8" r={radius} strokeDasharray={`${circumference * ratio} ${circumference}`} transform="rotate(-90 8 8)" />
      </svg>
      上下文 {percent}
    </span>
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
  const conversations = useApp((s) => s.assistantConversations);
  const currentConversation = useApp((s) => s.assistantConversationId);
  const openConversation = useApp((s) => s.openAssistantConversation);
  const deleteConversation = useApp((s) => s.deleteAssistantConversation);
  const toggle = useApp((s) => s.toggleAssistant);
  const openModelServices = useApp((s) => s.openModelServices);
  const draft = useApp((s) => s.assistantDraft);
  const progress = useApp((s) => s.assistantProgress);
  const selection = useApp((s) => (s.panel === 'chapter' && s.editorSelection !== null && s.editorSelection.key !== s.selectionDismissed ? s.editorSelection : null));
  const dismissSelection = useApp((s) => s.dismissSelection);
  const usage = useApp((s) => s.assistantContext);
  const modelsLoaded = useApp((s) => s.modelServices !== null);
  const loadModels = useApp((s) => s.loadAssistantModels);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);

  // 对话框下方的模型选择要用模型列表；模型服务页打开过时已经有了。
  useEffect(() => {
    if (!modelsLoaded) void loadModels();
  }, [modelsLoaded, loadModels]);

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
  // 后台做完的改动记录可能排在等待确认的那一条后面：确认按钮照旧有效。
  const waiting = waitingItem(items);
  const undoable = running || waiting !== null ? null : undoTarget(items);
  const renderItem = (item: AssistantItem) => {
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
        return <Pending key={item.id} item={item} active={!running && waiting?.id === item.id} />;
      case 'changes':
        return null;
      case 'undo':
        // 助手自己做的撤销，结果已经列在动作里。
        return item.source === 'action' ? null : (
          <p key={item.id} className="assistant-undone" role="note">
            <Icon name="undo" size={13} /> {withoutIds(item.report)}
          </p>
        );
    }
  };

  return (
    <aside className="assistant" aria-label="AI 助手">
      <header className="assistant-head">
        <span className="assistant-title">
          <Icon name="sparkle" /> AI 助手
        </span>
        <span className="spacer" />
        {hasWork ? (
          <History
            conversations={conversations}
            current={currentConversation}
            disabled={running}
            onOpen={(id) => void openConversation(id)}
            onDelete={(id) => void deleteConversation(id)}
          />
        ) : null}
        <button type="button" className="ghost" disabled={running || items.length === 0} title="另开一段新对话，之前的对话留在“历史对话”里" onClick={() => void clear()}>
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
            const node = renderItem(item);
            return undoable?.lastId === item.id ? (
              <div key={item.id} className="assistant-turn-end">
                {node}
                <UndoTurn />
              </div>
            ) : (
              node
            );
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
        <div className="composer-bar">
          <ModelMenu />
          <EffortMenu />
          <span className="spacer" />
          {usage !== null && usage.contextWindow > 0 ? <ContextMeter usage={usage} /> : null}
          {running ? (
            <button type="button" className="send" aria-label="停止" title="停止" onClick={stop}>
              <Icon name="stop" />
            </button>
          ) : (
            <button type="submit" className="send primary" aria-label="发送" title="发送（回车）" disabled={text.trim() === ''}>
              <Icon name="send" />
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

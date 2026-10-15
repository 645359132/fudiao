import type { ContextEntry } from '@fudiao/context';
import { useApp } from './store-context';

const n = (v: number) => v.toLocaleString('zh-CN');

function Entry({ entry, action }: { readonly entry: ContextEntry; readonly action: { label: string; run: () => void } | null }) {
  return (
    <li className="context-entry">
      <div className="context-entry-head">
        <span className="context-title">{entry.item.title}</span>
        <span className="muted">
          {n(entry.tokens)} Token · {entry.reason}
        </span>
        {action !== null && (
          <button type="button" aria-label={`${action.label} ${entry.item.title}`} onClick={action.run}>
            {action.label}
          </button>
        )}
      </div>
      <p className="context-text">{entry.item.text.length > 160 ? `${entry.item.text.slice(0, 160)}……` : entry.item.text}</p>
    </li>
  );
}

/**
 * 上下文清单（需求 B18）：本次 AI 任务会用到的章节、设定与事实，以及因超出预算等原因没有纳入的内容。
 * 作者可以加入或移除条目；增减只在本次打开的作品中保留。
 */
export function ContextDrawer() {
  const open = useApp((s) => s.drawer?.kind === 'context');
  const manifest = useApp((s) => s.writingContext);
  const close = useApp((s) => s.closeContext);
  const refresh = useApp((s) => s.openContext);
  const toggle = useApp((s) => s.toggleContextItem);
  if (!open || manifest === null) return null;
  const over = manifest.usedTokens > manifest.budget;
  return (
    <aside className="entity-drawer context-drawer" aria-label="AI 上下文">
      <div className="entity-head">
        <h3>AI 上下文</h3>
        <span className="spacer" />
        <button type="button" onClick={() => void refresh()}>
          按光标位置重算
        </button>
        <button type="button" aria-label="关闭 AI 上下文" onClick={close}>
          ×
        </button>
      </div>
      <p className={over ? 'context-budget over' : 'context-budget'} role="status">
        已用 {n(manifest.usedTokens)} / 预算 {n(manifest.budget)} Token{over ? '（作者加入的内容超出预算）' : ''}
      </p>
      <h4>会用到</h4>
      <ul className="context-list" aria-label="会用到的上下文">
        {manifest.included.map((e) => (
          <Entry key={e.item.id} entry={e} action={e.item.required ? null : { label: '移除', run: () => void toggle(e.item.id, false) }} />
        ))}
      </ul>
      {manifest.excluded.length > 0 && (
        <>
          <h4>没有用到</h4>
          <ul className="context-list" aria-label="没有用到的上下文">
            {manifest.excluded.map((e) => (
              <Entry key={e.item.id} entry={e} action={e.item.blocked !== null ? null : { label: '加入', run: () => void toggle(e.item.id, true) }} />
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

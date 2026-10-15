import { useEffect, type CSSProperties } from 'react';
import { Tooltip } from 'radix-ui';
import { DEFAULT_LAYOUT, LAYOUT_LIMITS } from './app/library';
import type { AppStore } from './state/store';
import { AssistantPanel } from './ui/AssistantPanel';
import { ImportPreview } from './ui/ImportPreview';
import { LibraryScreen } from './ui/LibraryScreen';
import { MessageBar } from './ui/MessageBar';
import { ModelServicesScreen } from './ui/ModelServicesScreen';
import { Splitter } from './ui/Splitter';
import { StoreProvider, useApp } from './ui/store-context';
import { WorkScreen } from './ui/WorkScreen';

function Screens() {
  const init = useApp((s) => s.init);
  const hasWork = useApp((s) => s.work !== null);
  const modelServices = useApp((s) => s.modelServicesOpen);
  const assistantOpen = useApp((s) => s.assistantOpen);
  const theme = useApp((s) => s.library?.preferences.theme ?? 'system');
  const layout = useApp((s) => s.library?.preferences.layout ?? DEFAULT_LAYOUT);
  const setLayout = useApp((s) => s.setLayout);
  useEffect(() => {
    void init();
  }, [init]);
  // 外观：浅色或深色写在根元素上；跟随系统时去掉，由样式表按系统设置选择。
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset['theme'];
    else root.dataset['theme'] = theme;
  }, [theme]);
  const showAssistant = assistantOpen && !modelServices;
  // 两侧栏的宽度写成 CSS 变量；拖动分隔条时直接改变量，松开后保存到偏好。
  const widths = { '--sidebar-width': `${layout.sidebar}px`, '--assistant-width': `${layout.assistant}px` } as CSSProperties;
  return (
    <div className="app-shell" style={widths}>
      <MessageBar />
      <div className="app-main">{modelServices ? <ModelServicesScreen /> : hasWork ? <WorkScreen /> : <LibraryScreen />}</div>
      {/* AI 助手在右侧，作品列表与作品界面都可以用；模型服务页盖住整个窗口时收起。 */}
      {showAssistant ? (
        <Splitter
          label="调整 AI 助手的宽度"
          side="right"
          cssVar="--assistant-width"
          value={layout.assistant}
          min={LAYOUT_LIMITS.assistant.min}
          max={LAYOUT_LIMITS.assistant.max}
          defaultValue={DEFAULT_LAYOUT.assistant}
          onCommit={(assistant) => void setLayout({ assistant })}
        />
      ) : null}
      {showAssistant ? <AssistantPanel /> : null}
      <ImportPreview />
    </div>
  );
}

/** 应用外壳：没有打开作品时显示作品列表，打开后显示作品界面。 */
export function App({ store }: { readonly store: AppStore }) {
  return (
    <StoreProvider store={store}>
      <Tooltip.Provider delayDuration={350} skipDelayDuration={150}>
        <Screens />
      </Tooltip.Provider>
    </StoreProvider>
  );
}

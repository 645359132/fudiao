import { useEffect } from 'react';
import type { AppStore } from './state/store';
import { AssistantPanel } from './ui/AssistantPanel';
import { ImportPreview } from './ui/ImportPreview';
import { LibraryScreen } from './ui/LibraryScreen';
import { MessageBar } from './ui/MessageBar';
import { ModelServicesScreen } from './ui/ModelServicesScreen';
import { StoreProvider, useApp } from './ui/store-context';
import { WorkScreen } from './ui/WorkScreen';

function Screens() {
  const init = useApp((s) => s.init);
  const hasWork = useApp((s) => s.work !== null);
  const modelServices = useApp((s) => s.modelServicesOpen);
  const assistantOpen = useApp((s) => s.assistantOpen);
  useEffect(() => {
    void init();
  }, [init]);
  return (
    <div className="app-shell">
      <MessageBar />
      <div className="app-main">{modelServices ? <ModelServicesScreen /> : hasWork ? <WorkScreen /> : <LibraryScreen />}</div>
      {/* AI 助手在右侧，作品列表与作品界面都可以用；模型服务页盖住整个窗口时收起。 */}
      {assistantOpen && !modelServices ? <AssistantPanel /> : null}
      <ImportPreview />
    </div>
  );
}

/** 应用外壳：没有打开作品时显示作品列表，打开后显示作品界面。 */
export function App({ store }: { readonly store: AppStore }) {
  return (
    <StoreProvider store={store}>
      <Screens />
    </StoreProvider>
  );
}

import { useEffect } from 'react';
import type { AppStore } from './state/store';
import { ImportPreview } from './ui/ImportPreview';
import { LibraryScreen } from './ui/LibraryScreen';
import { MessageBar } from './ui/MessageBar';
import { StoreProvider, useApp } from './ui/store-context';
import { WorkScreen } from './ui/WorkScreen';

function Screens() {
  const init = useApp((s) => s.init);
  const hasWork = useApp((s) => s.work !== null);
  useEffect(() => {
    void init();
  }, [init]);
  return (
    <>
      <MessageBar />
      {hasWork ? <WorkScreen /> : <LibraryScreen />}
      <ImportPreview />
    </>
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

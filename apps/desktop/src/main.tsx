import { StrictMode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createAppService } from './app/service';
import { tauriDeps } from './platform/tauri';
import { createAppStore } from './state/store';
import './app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('缺少根节点');
const store = createAppStore(createAppService(tauriDeps()));

// 关闭窗口前先保存正文。保存失败时第一次关闭被拦下并说明原因；再次关闭则直接退出（草稿仍在，下次打开可恢复）。
let warned = false;
void getCurrentWindow().onCloseRequested(async (event) => {
  if (warned || (await store.getState().leaveChapter())) return;
  warned = true;
  event.preventDefault();
  store.setState({ message: '本章正文没有保存成功。可以复制全文或导出本章；再次关闭将直接退出，未保存的编辑留在草稿中。' });
});
// 窗口标题栏随外观变化；跟随系统时交给系统。
let titleBarTheme: string | null = null;
const syncTitleBar = () => {
  const theme = store.getState().library?.preferences.theme ?? 'system';
  if (theme === titleBarTheme) return;
  titleBarTheme = theme;
  getCurrentWindow()
    .setTheme(theme === 'system' ? null : theme)
    .catch(() => undefined);
};
store.subscribe(syncTitleBar);

createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

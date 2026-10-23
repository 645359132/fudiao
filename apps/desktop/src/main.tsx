import { StrictMode } from 'react';
import { invoke } from '@tauri-apps/api/core';
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

// 关闭窗口前：有任务在进行时先请作者确认（确认后经 setExit 再次关闭）；再保存正文。
// 保存失败时第一次关闭被拦下并说明原因；再次关闭则直接退出（草稿仍在，下次打开可恢复）。
let warned = false;
let confirmed = false;
store.getState().setExit(() => {
  confirmed = true;
  void getCurrentWindow().close();
});
void getCurrentWindow().onCloseRequested(async (event) => {
  if (!confirmed && !store.getState().requestExit()) {
    event.preventDefault();
    return;
  }
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
// 窗口标题是这个窗口里的书名：几本书各开在一个窗口里时（每个窗口各写一本书），任务栏上分得清。
let windowTitle: string | null = null;
const syncWindowTitle = () => {
  const work = store.getState().work?.project.title;
  const next = work === undefined ? '复调' : `${work} · 复调`;
  if (next === windowTitle) return;
  windowTitle = next;
  getCurrentWindow()
    .setTitle(next)
    .catch(() => undefined);
};
store.subscribe(syncWindowTitle);

// 页面重新载入（F5 或开发时整页刷新）时，Rust 端还记着这个窗口之前开的作品：先放下，
// 不然别的窗口打不开它，这个窗口也只显示作品列表。之后再渲染（渲染时才打开作品）。
void invoke('db_close')
  .catch(() => undefined)
  .finally(() =>
    createRoot(root).render(
      <StrictMode>
        <App store={store} />
      </StrictMode>,
    ),
  );

// 浏览器预览的入口（开发时用，不随产品发布）：pnpm --filter @fudiao/desktop dev --port 1430 后打开 /preview.html。
// 作品库在内存里，刷新页面即重来；?screen=library 停在作品列表，?theme=dark 或 light 指定外观（默认跟随系统），
// ?chapters=800 在演示作品里再加若干章（每 50 章一卷），看长篇的目录。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { App } from '../App';
import { createAppService } from '../app/service';
import { createAppStore } from '../state/store';
import '../app.css';
import { previewDeps } from './deps';
import { seedChapters, seedDemo } from './seed';

const root = document.getElementById('root');
if (root === null) throw new Error('缺少根节点');
const params = new URLSearchParams(location.search);

const SQL = await initSqlJs({ locateFile: () => wasmUrl });
const service = createAppService(previewDeps(SQL));
const { mainWorkId } = await seedDemo(service);
const extra = Number(params.get('chapters') ?? 0);
if (extra > 0) await seedChapters(service, extra);
const theme = params.get('theme');
if (theme === 'dark' || theme === 'light') await service.setPreferences({ theme });
const store = createAppStore(service);
await store.getState().init();
if (params.get('screen') !== 'library') await store.getState().openWork(mainWorkId);
if (params.get('assistant') === 'closed') store.getState().toggleAssistant();

createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

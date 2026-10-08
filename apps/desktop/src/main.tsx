import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createAppService } from './app/service';
import { tauriDeps } from './platform/tauri';
import { createAppStore } from './state/store';
import './app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('缺少根节点');
const store = createAppStore(createAppService(tauriDeps()));
createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

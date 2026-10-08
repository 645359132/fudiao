import { ChapterSidebar } from './ChapterSidebar';
import { BackupsPanel } from './BackupsPanel';
import { HistoryPanel } from './HistoryPanel';
import { SettingsPanel } from './SettingsPanel';
import { ChapterPanel, TrashPanel, WorkInfoPanel } from './panels';
import { useApp } from './store-context';

export function WorkScreen() {
  const title = useApp((s) => s.work?.project.title ?? '');
  const panel = useApp((s) => s.panel);
  const closeWork = useApp((s) => s.closeWork);
  const showPanel = useApp((s) => s.showPanel);
  const startTextImport = useApp((s) => s.startTextImport);
  const exportBook = useApp((s) => s.exportBook);
  const exportProject = useApp((s) => s.exportProject);
  const openBackups = useApp((s) => s.openBackups);
  const openSettings = useApp((s) => s.openSettings);
  const busy = useApp((s) => s.busy);
  return (
    <div className="work">
      <header className="work-bar">
        <button type="button" onClick={() => void closeWork()}>
          作品列表
        </button>
        <button type="button" className="work-title" aria-pressed={panel === 'info'} onClick={() => void showPanel('info')}>
          {title}
        </button>
        <span className="spacer" />
        <button type="button" aria-pressed={panel === 'settings'} onClick={() => void openSettings()}>
          设定
        </button>
        <details className="menu">
          <summary>作品</summary>
          <div className="menu-items" role="menu">
            <button type="button" role="menuitem" disabled={busy} onClick={() => void startTextImport('current')}>
              导入章节（TXT/Markdown）
            </button>
            <button type="button" role="menuitem" disabled={busy} onClick={() => void exportBook('txt')}>
              导出整本 TXT
            </button>
            <button type="button" role="menuitem" disabled={busy} onClick={() => void exportBook('md')}>
              导出整本 Markdown
            </button>
            <button type="button" role="menuitem" disabled={busy} onClick={() => void exportProject()}>
              导出作品包
            </button>
            <button type="button" role="menuitem" disabled={busy} onClick={() => void openBackups()}>
              备份与恢复
            </button>
          </div>
        </details>
      </header>
      <div className="work-body">
        <ChapterSidebar />
        <main className="work-main">{panel === 'info' ? <WorkInfoPanel /> : panel === 'trash' ? <TrashPanel /> : panel === 'history' ? <HistoryPanel /> : panel === 'backups' ? <BackupsPanel /> : panel === 'settings' ? <SettingsPanel /> : <ChapterPanel />}</main>
      </div>
    </div>
  );
}

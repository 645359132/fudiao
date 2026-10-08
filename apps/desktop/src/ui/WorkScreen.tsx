import { useEffect } from 'react';
import { ChapterSidebar } from './ChapterSidebar';
import { BackupsPanel } from './BackupsPanel';
import { FactsPanel } from './FactsPanel';
import { HistoryPanel } from './HistoryPanel';
import { SearchPanel } from './SearchPanel';
import { SettingsPanel } from './SettingsPanel';
import { SourcesPanel } from './SourcesPanel';
import { UsagePanel } from './UsagePanel';
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
  const openFacts = useApp((s) => s.openFacts);
  const openSourceStats = useApp((s) => s.openSourceStats);
  const openSearch = useApp((s) => s.openSearch);
  const openModelServices = useApp((s) => s.openModelServices);
  const openUsage = useApp((s) => s.openUsage);
  const pendingReview = useApp((s) => s.facts.filter((f) => f.status === 'needs_review').length);
  const busy = useApp((s) => s.busy);

  // Ctrl+F（或 Ctrl+Shift+F）打开全文查找；正文中选中的一行文字作为查询。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      const selected = window.getSelection()?.toString() ?? '';
      void openSearch(selected.includes('\n') || selected.length > 50 ? undefined : selected);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

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
        <button type="button" aria-pressed={panel === 'search'} title="全文查找（Ctrl+F）" onClick={() => void openSearch()}>
          查找
        </button>
        <button type="button" aria-pressed={panel === 'settings'} onClick={() => void openSettings()}>
          设定
        </button>
        <button type="button" aria-pressed={panel === 'facts'} onClick={() => void openFacts()}>
          事实{pendingReview > 0 ? `（待复核 ${pendingReview}）` : ''}
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
            <button type="button" role="menuitem" disabled={busy} onClick={() => void openSourceStats()}>
              段落来源
            </button>
            <button type="button" role="menuitem" disabled={busy} onClick={() => void openUsage()}>
              用量与费用
            </button>
            <button type="button" role="menuitem" disabled={busy} onClick={() => void openModelServices()}>
              模型服务
            </button>
          </div>
        </details>
      </header>
      <div className="work-body">
        <ChapterSidebar />
        <main className="work-main">{panel === 'info' ? <WorkInfoPanel /> : panel === 'trash' ? <TrashPanel /> : panel === 'history' ? <HistoryPanel /> : panel === 'backups' ? <BackupsPanel /> : panel === 'settings' ? <SettingsPanel /> : panel === 'facts' ? <FactsPanel /> : panel === 'sources' ? <SourcesPanel /> : panel === 'search' ? <SearchPanel /> : panel === 'usage' ? <UsagePanel /> : <ChapterPanel />}</main>
      </div>
    </div>
  );
}

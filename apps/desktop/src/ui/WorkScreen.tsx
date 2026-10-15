import { useEffect } from 'react';
import { ChapterSidebar } from './ChapterSidebar';
import { BackupsPanel } from './BackupsPanel';
import { FactsPanel } from './FactsPanel';
import { HistoryPanel } from './HistoryPanel';
import { SearchPanel } from './SearchPanel';
import { SettingsPanel } from './SettingsPanel';
import { SkillsPanel } from './SkillsPanel';
import { PlanningPanel } from './PlanningPanel';
import { QuickBookPanel } from './QuickBookPanel';
import { SimulationPanel } from './SimulationPanel';
import { SourcesPanel } from './SourcesPanel';
import { TasksPanel } from './TasksPanel';
import { UsagePanel } from './UsagePanel';
import { Icon, type IconName } from './Icon';
import { ThemeButton } from './ThemeButton';
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
  const openTasks = useApp((s) => s.openTasks);
  const openSkills = useApp((s) => s.openSkills);
  const openPlanning = useApp((s) => s.openPlanning);
  const openSimulation = useApp((s) => s.openSimulation);
  const openQuickBook = useApp((s) => s.openQuickBook);
  const running = useApp((s) => s.tasks.filter((t) => t.status === 'running').length);
  const pendingReview = useApp((s) => s.facts.filter((f) => f.status === 'needs_review').length);
  const busy = useApp((s) => s.busy);
  const assistantOpen = useApp((s) => s.assistantOpen);
  const toggleAssistant = useApp((s) => s.toggleAssistant);

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

  const navItem = (key: string, icon: IconName, label: string, active: boolean, onClick: () => void, extra?: string, title?: string) => (
    <button key={key} type="button" className="nav-item" aria-pressed={active} title={title} onClick={onClick}>
      <Icon name={icon} />
      <span>
        {label}
        {extra === undefined ? null : <span className="nav-badge">{extra}</span>}
      </span>
    </button>
  );

  return (
    <div className="work">
      <header className="work-bar">
        <button type="button" className="ghost" onClick={() => void closeWork()}>
          <Icon name="back" />
          作品列表
        </button>
        <span className="bar-divider" aria-hidden="true" />
        <button type="button" className="work-title" title="作品信息" aria-pressed={panel === 'info'} onClick={() => void showPanel('info')}>
          {title}
        </button>
        <span className="spacer" />
        <button type="button" className="ghost" aria-pressed={panel === 'tasks'} onClick={() => void openTasks()}>
          <Icon name="tasks" />
          任务{running > 0 ? `（${running} 进行中）` : ''}
        </button>
        <ThemeButton />
        <details className="menu">
          <summary>
            <Icon name="more" />
            更多
          </summary>
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
            <button type="button" role="menuitem" disabled={busy} onClick={() => void openSkills()}>
              写作技能
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
        {assistantOpen ? null : (
          <button type="button" className="primary" onClick={toggleAssistant}>
            <Icon name="sparkle" />
            AI 助手
          </button>
        )}
      </header>
      <div className="work-body">
        <aside className="sidebar">
          {/* 一页走完成书流程放在最前；推演、事实与查找等进阶功能在下面。 */}
          <nav className="nav" aria-label="作品导航">
            {navItem('book', 'book', '成书', panel === 'book', () => void openQuickBook(), undefined, '快速成书：想法、大纲、章节计划、写完、导出')}
            {navItem('planning', 'plan', '计划', panel === 'planning', () => void openPlanning())}
            {navItem('settings', 'people', '设定', panel === 'settings', () => void openSettings())}
            {navItem('facts', 'facts', '事实', panel === 'facts', () => void openFacts(), pendingReview > 0 ? `（待复核 ${pendingReview}）` : undefined)}
            {navItem('simulation', 'stage', '推演', panel === 'simulation', () => void openSimulation(), undefined, '角色推演：设置场景，让角色各自依据所知行动')}
            {navItem('search', 'search', '查找', panel === 'search', () => void openSearch(), undefined, '全文查找（Ctrl+F）')}
          </nav>
          <ChapterSidebar />
        </aside>
        <main className="work-main"><div className="work-main-inner">{panel === 'info' ? <WorkInfoPanel /> : panel === 'trash' ? <TrashPanel /> : panel === 'history' ? <HistoryPanel /> : panel === 'backups' ? <BackupsPanel /> : panel === 'settings' ? <SettingsPanel /> : panel === 'facts' ? <FactsPanel /> : panel === 'sources' ? <SourcesPanel /> : panel === 'search' ? <SearchPanel /> : panel === 'usage' ? <UsagePanel /> : panel === 'tasks' ? <TasksPanel /> : panel === 'skills' ? <SkillsPanel /> : panel === 'planning' ? <PlanningPanel /> : panel === 'simulation' ? <SimulationPanel /> : panel === 'book' ? <QuickBookPanel /> : <ChapterPanel />}</div></main>
      </div>
    </div>
  );
}

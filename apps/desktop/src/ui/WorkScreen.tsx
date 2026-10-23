import { useEffect } from 'react';
import { DropdownMenu } from 'radix-ui';
import { DEFAULT_LAYOUT, LAYOUT_LIMITS } from '../app/library';
import { ChapterSidebar } from './ChapterSidebar';
import { BackupsPanel } from './BackupsPanel';
import { FactsPanel } from './FactsPanel';
import { RelationsPanel } from './RelationsPanel';
import { HistoryPanel } from './HistoryPanel';
import { SearchPanel } from './SearchPanel';
import { SettingsPanel } from './SettingsPanel';
import { SkillsPanel } from './SkillsPanel';
import { PlanningPanel } from './PlanningPanel';
import { WorkflowPanel } from './WorkflowPanel';
import { SimulationPanel } from './SimulationPanel';
import { SourcesPanel } from './SourcesPanel';
import { TasksPanel } from './TasksPanel';
import { UsagePanel } from './UsagePanel';
import { Icon, type IconName } from './Icon';
import { ThemeButton } from './ThemeButton';
import { IconButton } from './IconButton';
import { Splitter } from './Splitter';
import { ChapterPanel, TrashPanel, WorkInfoPanel } from './panels';
import { useApp } from './store-context';

export function WorkScreen() {
  const title = useApp((s) => s.work?.project.title ?? '');
  const panel = useApp((s) => s.panel);
  const requestCloseWork = useApp((s) => s.requestCloseWork);
  const canOpenWindows = useApp((s) => s.canOpenWindows);
  const openNewWindow = useApp((s) => s.openNewWindow);
  const showPanel = useApp((s) => s.showPanel);
  const startTextImport = useApp((s) => s.startTextImport);
  const exportBook = useApp((s) => s.exportBook);
  const exportProject = useApp((s) => s.exportProject);
  const openBackups = useApp((s) => s.openBackups);
  const openSettings = useApp((s) => s.openSettings);
  const openFacts = useApp((s) => s.openFacts);
  const openRelations = useApp((s) => s.openRelations);
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
  const relationPending = useApp((s) => s.relationPending);
  const busy = useApp((s) => s.busy);
  const assistantOpen = useApp((s) => s.assistantOpen);
  const toggleAssistant = useApp((s) => s.toggleAssistant);
  const layout = useApp((s) => s.library?.preferences.layout ?? DEFAULT_LAYOUT);
  const setLayout = useApp((s) => s.setLayout);

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

  const menuItem = (icon: IconName, label: string, onSelect: () => void) => (
    <DropdownMenu.Item className="menu-item" disabled={busy} onSelect={onSelect}>
      <Icon name={icon} />
      {label}
    </DropdownMenu.Item>
  );

  return (
    <div className="work">
      <header className="work-bar">
        <IconButton
          icon={layout.sidebarHidden ? 'sidebarOpen' : 'sidebarClose'}
          label={layout.sidebarHidden ? '显示左栏' : '收起左栏'}
          onClick={() => void setLayout({ sidebarHidden: !layout.sidebarHidden })}
        />
        <button type="button" className="ghost" onClick={() => void requestCloseWork()}>
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
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="ghost">
              <Icon name="more" />
              更多
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu-content" align="end" sideOffset={6} collisionPadding={8}>
              <DropdownMenu.Label className="menu-label">导入与导出</DropdownMenu.Label>
              {menuItem('upload', '导入章节（TXT/Markdown）', () => void startTextImport('current'))}
              {menuItem('download', '导出整本 TXT', () => void exportBook('txt'))}
              {menuItem('download', '导出整本 Markdown', () => void exportBook('md'))}
              {menuItem('download', '导出作品包', () => void exportProject())}
              {menuItem('history', '备份与恢复', () => void openBackups())}
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Label className="menu-label">写作与模型</DropdownMenu.Label>
              {menuItem('pen', '写作技能', () => void openSkills())}
              {menuItem('layers', '段落来源', () => void openSourceStats())}
              {menuItem('tasks', '用量与费用', () => void openUsage())}
              {menuItem('settings', '模型服务', () => void openModelServices())}
              {canOpenWindows ? (
                <>
                  <DropdownMenu.Separator className="menu-separator" />
                  {/* 一本书由一个写手在这个窗口里写着，另一本书在新窗口里开（作者决定 2026-10-23）。 */}
                  {menuItem('window', '在新窗口打开另一本书', () => void openNewWindow(null))}
                </>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        {assistantOpen ? null : (
          <button type="button" className="primary" onClick={toggleAssistant}>
            <Icon name="sparkle" />
            AI 助手
          </button>
        )}
      </header>
      <div className={layout.sidebarHidden ? 'work-body sidebar-hidden' : 'work-body'}>
        {layout.sidebarHidden ? null : (
          <>
            <aside className="sidebar">
              {/* 一页走完成书流程放在最前；推演、事实与查找等进阶功能在下面。 */}
              <nav className="nav" aria-label="作品导航">
                {navItem('book', 'book', '成书', panel === 'book', () => void openQuickBook(), undefined, '写作工作流：一键成书等，按固定的步骤依次做，每步可以看、改、采用')}
                {navItem('planning', 'plan', '计划', panel === 'planning', () => void openPlanning())}
                {navItem('settings', 'people', '设定', panel === 'settings', () => void openSettings())}
                {navItem('relations', 'relations', '人物关系', panel === 'relations', () => void openRelations(), relationPending > 0 ? `（待确认 ${relationPending}）` : undefined, '人物关系网：谁和谁是什么关系，随章节变化')}
            {navItem('facts', 'facts', '事实', panel === 'facts', () => void openFacts(), pendingReview > 0 ? `（待复核 ${pendingReview}）` : undefined)}
                {navItem('simulation', 'stage', '推演', panel === 'simulation', () => void openSimulation(), undefined, '角色推演：设置场景，让角色各自依据所知行动')}
                {navItem('search', 'search', '查找', panel === 'search', () => void openSearch(), undefined, '全文查找（Ctrl+F）')}
              </nav>
              <ChapterSidebar />
            </aside>
            <Splitter
              label="调整左栏的宽度"
              side="left"
              cssVar="--sidebar-width"
              value={layout.sidebar}
              min={LAYOUT_LIMITS.sidebar.min}
              max={LAYOUT_LIMITS.sidebar.max}
              defaultValue={DEFAULT_LAYOUT.sidebar}
              onCommit={(sidebar) => void setLayout({ sidebar })}
            />
          </>
        )}
        <main className="work-main"><div className="work-main-inner">{panel === 'info' ? <WorkInfoPanel /> : panel === 'trash' ? <TrashPanel /> : panel === 'history' ? <HistoryPanel /> : panel === 'backups' ? <BackupsPanel /> : panel === 'settings' ? <SettingsPanel /> : panel === 'facts' ? <FactsPanel /> : panel === 'relations' ? <RelationsPanel /> : panel === 'sources' ? <SourcesPanel /> : panel === 'search' ? <SearchPanel /> : panel === 'usage' ? <UsagePanel /> : panel === 'tasks' ? <TasksPanel /> : panel === 'skills' ? <SkillsPanel /> : panel === 'planning' ? <PlanningPanel /> : panel === 'simulation' ? <SimulationPanel /> : panel === 'book' ? <WorkflowPanel /> : <ChapterPanel />}</div></main>
      </div>
    </div>
  );
}

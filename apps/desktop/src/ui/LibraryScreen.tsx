import { useState } from 'react';
import type { LibraryWork } from '../app/service';
import { BookCover } from './BookCover';
import { Icon } from './Icon';
import { ThemeButton } from './ThemeButton';
import { useApp } from './store-context';
import { TextForm } from './TextForm';

const when = (iso: string | null) => (iso === null ? '从未打开' : `上次打开：${new Date(iso).toLocaleString('zh-CN')}`);

/**
 * 一部作品的卡片。点卡片上任何地方（封面、书名、日期）都打开作品，书名是给键盘与读屏软件用的按钮；
 * 更换封面不常用，放在下面的按钮里：打开作品并进入作品信息。
 */
function WorkItem({ work }: { readonly work: LibraryWork }) {
  const openWork = useApp((s) => s.openWork);
  const openWorkCover = useApp((s) => s.openWorkCover);
  const setArchived = useApp((s) => s.setArchived);
  const removeMissing = useApp((s) => s.removeMissingWork);
  const canOpenWindows = useApp((s) => s.canOpenWindows);
  const openNewWindow = useApp((s) => s.openNewWindow);
  const busy = useApp((s) => s.busy);
  const openable = !busy && !work.missing;
  return (
    <li
      className={work.missing ? 'work-card missing' : 'work-card'}
      onClick={(e) => {
        // 卡片上的按钮各管各的；其余地方点了打开作品。
        if (openable && (e.target as HTMLElement).closest('button') === null) void openWork(work.id);
      }}
    >
      <BookCover title={work.title} image={work.cover} seed={work.id} size="small" decorative />
      <span className="work-meta">
        <button type="button" className="work-open" disabled={busy || work.missing} onClick={() => void openWork(work.id)}>
          {work.title}
        </button>
        <span className="muted">{work.missing ? '找不到作品文件夹' : when(work.lastOpenedAt)}</span>
        <span className="muted path" title={work.path}>
          {work.path}
        </span>
      </span>
      <span className="actions">
        {work.missing && (
          <button type="button" className="ghost" disabled={busy} onClick={() => void removeMissing(work.id)}>
            从列表移除
          </button>
        )}
        {work.missing ? null : (
          <button type="button" className="ghost" disabled={busy} aria-label={`更换 ${work.title} 的封面`} onClick={() => void openWorkCover(work.id)}>
            更换封面
          </button>
        )}
        {work.missing || !canOpenWindows ? null : (
          <button type="button" className="ghost" disabled={busy} aria-label={`在新窗口打开 ${work.title}`} title="这个窗口里的书照常写，另一本书在新窗口里开" onClick={() => void openNewWindow(work.id)}>
            新窗口
          </button>
        )}
        <button type="button" className="ghost" disabled={busy} aria-label={`${work.archived ? '取消归档' : '归档'} ${work.title}`} onClick={() => void setArchived(work.id, !work.archived)}>
          {work.archived ? '取消归档' : '归档'}
        </button>
      </span>
    </li>
  );
}

export function LibraryScreen() {
  const library = useApp((s) => s.library);
  const createWork = useApp((s) => s.createWork);
  const addWorkFromFolder = useApp((s) => s.addWorkFromFolder);
  const chooseLibraryDir = useApp((s) => s.chooseLibraryDir);
  const startTextImport = useApp((s) => s.startTextImport);
  const importProject = useApp((s) => s.importProject);
  const openModelServices = useApp((s) => s.openModelServices);
  const assistantOpen = useApp((s) => s.assistantOpen);
  const toggleAssistant = useApp((s) => s.toggleAssistant);
  const busy = useApp((s) => s.busy);
  const [creating, setCreating] = useState(false);

  const works = library?.works ?? [];
  const active = works.filter((w) => !w.archived);
  const archived = works.filter((w) => w.archived);

  return (
    <main className="library">
      <header className="library-hero">
        <div>
          <h1>复调</h1>
          <p className="tagline">中文长篇小说的写作台：人物各凭所知行动，你决定哪一段写进书里。</p>
        </div>
        <div className="hero-actions">
          <button type="button" className="primary large" disabled={busy} onClick={() => setCreating(true)}>
            <Icon name="plus" />
            新建作品
          </button>
          {assistantOpen ? null : (
            <button type="button" className="large" onClick={toggleAssistant}>
              <Icon name="sparkle" />
              让 AI 帮我开书
            </button>
          )}
        </div>
      </header>
      {creating && <TextForm label="作品名" submitText="创建" onSubmit={createWork} onCancel={() => setCreating(false)} />}
      <div className="toolbar">
        <button type="button" className="ghost" disabled={busy} onClick={() => void addWorkFromFolder()}>
          <Icon name="folder" />
          打开作品文件夹
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => void startTextImport('new')}>
          <Icon name="upload" />
          导入 TXT/Markdown
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => void importProject()}>
          <Icon name="upload" />
          导入作品包
        </button>
        <span className="spacer" />
        <ThemeButton />
        <button type="button" className="ghost" disabled={busy} onClick={() => void openModelServices()}>
          <Icon name="settings" />
          模型服务
        </button>
      </div>
      <section aria-label="作品" className="library-works">
        {active.length === 0 ? (
          <div className="library-empty">
            <p>还没有作品。新建一部，或打开已有的作品文件夹。</p>
            <p className="muted">也可以在右侧告诉 AI 助手你想写什么，它会帮你建好作品、大纲与人物。</p>
          </div>
        ) : (
          <ul className="work-grid">
            {active.map((w) => (
              <WorkItem key={w.id} work={w} />
            ))}
          </ul>
        )}
      </section>
      {archived.length > 0 && (
        <details className="archived">
          <summary>已归档（{archived.length}）</summary>
          <ul className="work-grid">
            {archived.map((w) => (
              <WorkItem key={w.id} work={w} />
            ))}
          </ul>
        </details>
      )}
      <footer className="library-foot muted">
        作品库：{library?.libraryDir ?? '……'}
        <button type="button" className="link" disabled={busy} onClick={() => void chooseLibraryDir()}>
          更改位置
        </button>
      </footer>
    </main>
  );
}

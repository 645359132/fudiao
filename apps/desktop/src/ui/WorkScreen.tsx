import { ChapterSidebar } from './ChapterSidebar';
import { ChapterPanel, TrashPanel, WorkInfoPanel } from './panels';
import { useApp } from './store-context';

export function WorkScreen() {
  const title = useApp((s) => s.work?.project.title ?? '');
  const panel = useApp((s) => s.panel);
  const closeWork = useApp((s) => s.closeWork);
  const showPanel = useApp((s) => s.showPanel);
  return (
    <div className="work">
      <header className="work-bar">
        <button type="button" onClick={() => void closeWork()}>
          作品列表
        </button>
        <button type="button" className="work-title" aria-pressed={panel === 'info'} onClick={() => void showPanel('info')}>
          {title}
        </button>
      </header>
      <div className="work-body">
        <ChapterSidebar />
        <main className="work-main">{panel === 'info' ? <WorkInfoPanel /> : panel === 'trash' ? <TrashPanel /> : <ChapterPanel />}</main>
      </div>
    </div>
  );
}

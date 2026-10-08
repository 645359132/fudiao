import { useState } from 'react';
import type { LibraryWork } from '../app/service';
import { useApp } from './store-context';
import { TextForm } from './TextForm';

const when = (iso: string | null) => (iso === null ? '从未打开' : `上次打开：${new Date(iso).toLocaleString('zh-CN')}`);

function WorkItem({ work }: { readonly work: LibraryWork }) {
  const openWork = useApp((s) => s.openWork);
  const setArchived = useApp((s) => s.setArchived);
  const removeMissing = useApp((s) => s.removeMissingWork);
  const busy = useApp((s) => s.busy);
  return (
    <li className={work.missing ? 'work-item missing' : 'work-item'}>
      <button type="button" className="work-open" disabled={busy || work.missing} onClick={() => void openWork(work.id)}>
        {work.title}
      </button>
      <span className="muted">{work.missing ? '找不到作品文件夹' : when(work.lastOpenedAt)}</span>
      <span className="muted path">{work.path}</span>
      <span className="actions">
        {work.missing && (
          <button type="button" disabled={busy} onClick={() => void removeMissing(work.id)}>
            从列表移除
          </button>
        )}
        <button type="button" disabled={busy} aria-label={`${work.archived ? '取消归档' : '归档'} ${work.title}`} onClick={() => void setArchived(work.id, !work.archived)}>
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
  const busy = useApp((s) => s.busy);
  const [creating, setCreating] = useState(false);

  const works = library?.works ?? [];
  const active = works.filter((w) => !w.archived);
  const archived = works.filter((w) => w.archived);

  return (
    <main className="library">
      <header className="library-head">
        <h1>复调</h1>
        <p className="muted">
          作品库：{library?.libraryDir ?? '……'}
          <button type="button" className="link" disabled={busy} onClick={() => void chooseLibraryDir()}>
            更改位置
          </button>
        </p>
      </header>
      <div className="toolbar">
        <button type="button" disabled={busy} onClick={() => setCreating(true)}>
          新建作品
        </button>
        <button type="button" disabled={busy} onClick={() => void addWorkFromFolder()}>
          打开作品文件夹
        </button>
        <button type="button" disabled={busy} onClick={() => void startTextImport('new')}>
          导入 TXT/Markdown
        </button>
        <button type="button" disabled={busy} onClick={() => void importProject()}>
          导入作品包
        </button>
      </div>
      {creating && <TextForm label="作品名" submitText="创建" onSubmit={createWork} onCancel={() => setCreating(false)} />}
      <section aria-label="作品">
        {active.length === 0 ? (
          <p className="muted">还没有作品。新建一部，或打开已有的作品文件夹。</p>
        ) : (
          <ul className="work-list">
            {active.map((w) => (
              <WorkItem key={w.id} work={w} />
            ))}
          </ul>
        )}
      </section>
      {archived.length > 0 && (
        <details className="archived">
          <summary>已归档（{archived.length}）</summary>
          <ul className="work-list">
            {archived.map((w) => (
              <WorkItem key={w.id} work={w} />
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}

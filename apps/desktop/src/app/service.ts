// 应用服务层（DESIGN_PATTERNS 第六章）：每个作者操作对应一个用例，协调作品列表、作品库与仓储。
// 界面组件只调用这里的用例、订阅状态，不直接访问仓储或端口。
import { err, ok, type Result } from '@fudiao/shared';
import {
  createChapter,
  createProject,
  getProject,
  listChapters,
  listParagraphs,
  saveChapterParagraphs,
  createSnapshot,
  getSnapshot,
  listSnapshots,
  restoreSnapshot,
  moveChapter,
  renameChapter,
  restoreChapter,
  trashChapter,
  updateChapterNotes,
  updateProject,
  type Chapter,
  type Project,
  type ProjectPatch,
  type RepoError,
  type CurrentParagraph,
  type SavedParagraph,
  type SqlPort,
  type Snapshot,
  type SnapshotSummary,
  type StructuralEdits,
} from '@fudiao/store';
import { draftDiffers, draftJson, parseDraft, type DraftFile } from './draft';
import { EMPTY_LIBRARY, folderName, joinPath, LibraryFile, samePath, sortWorks, type WorkEntry } from './library';
import { describeError, type AppError } from './errors';
import type { AppDeps } from './ports';

export type { AppError } from './errors';

export type LibraryWork = WorkEntry & { readonly missing: boolean };
export type LibraryView = { readonly libraryDir: string; readonly works: readonly LibraryWork[] };

/** 打开的章节：库中的段落，以及与之不同的未保存草稿（若有）。 */
export type ChapterContent = {
  readonly chapterId: string;
  readonly saved: readonly SavedParagraph[];
  readonly draft: DraftFile | null;
};

export type WorkView = {
  readonly entry: WorkEntry;
  readonly project: Project;
  readonly chapters: readonly Chapter[];
  readonly trashed: readonly Chapter[];
};

const repo = (error: RepoError): AppError => ({ code: 'repo', error });

export function createAppService(deps: AppDeps) {
  let file: LibraryFile = EMPTY_LIBRARY;
  let session: { entry: WorkEntry; port: SqlPort } | null = null;
  const ctx = () => ({ now: deps.clock.now() });

  async function load(): Promise<Result<LibraryFile, AppError>> {
    const text = await deps.library.read();
    if (!text.ok) return err({ code: 'library', detail: text.error });
    if (text.value === null) return ok(EMPTY_LIBRARY);
    try {
      const parsed = LibraryFile.safeParse(JSON.parse(text.value));
      if (parsed.success) return ok(parsed.data);
    } catch {
      // 落到下面的错误
    }
    return err({ code: 'library', detail: '作品列表文件已损坏' });
  }

  async function save(next: LibraryFile): Promise<Result<void, AppError>> {
    const written = await deps.library.write(`${JSON.stringify(next, null, 2)}\n`);
    if (!written.ok) return err({ code: 'library', detail: written.error });
    file = next;
    return ok(undefined);
  }

  async function libraryDir(): Promise<Result<string, AppError>> {
    if (file.libraryDir !== null) return ok(file.libraryDir);
    const dir = await deps.library.defaultDir();
    return dir.ok ? ok(dir.value) : err({ code: 'library', detail: dir.error });
  }

  async function upsert(entry: WorkEntry): Promise<Result<void, AppError>> {
    const others = file.works.filter((w) => w.id !== entry.id && !samePath(w.path, entry.path));
    return save({ ...file, works: [...others, entry] });
  }

  async function view(): Promise<Result<WorkView, AppError>> {
    if (session === null) return err({ code: 'no_work' });
    const project = await getProject(session.port);
    if (!project.ok) return err(repo(project.error));
    if (project.value === null) return err({ code: 'not_a_work', path: session.entry.path });
    const chapters = await listChapters(session.port, 'normal');
    if (!chapters.ok) return err(repo(chapters.error));
    const trashed = await listChapters(session.port, 'trashed');
    if (!trashed.ok) return err(repo(trashed.error));
    return ok({ entry: session.entry, project: project.value, chapters: chapters.value, trashed: trashed.value });
  }

  /** 打开作品库并读取作品信息；成功后成为当前作品。 */
  async function openAt(path: string, entryOf: (project: Project) => WorkEntry, create?: string): Promise<Result<WorkView, AppError>> {
    await close();
    const opened = await deps.opener.open(path, deps.clock.now());
    if (!opened.ok) return err({ code: 'open_failed', error: opened.error });
    const port = opened.value.port;
    if (create !== undefined) {
      const created = await createProject(port, { id: deps.ids.next(), title: create }, ctx());
      if (!created.ok) {
        await deps.opener.close();
        return err(repo(created.error));
      }
    }
    const project = await getProject(port);
    if (!project.ok || project.value === null) {
      await deps.opener.close();
      return project.ok ? err({ code: 'not_a_work', path }) : err(repo(project.error));
    }
    const entry = entryOf(project.value);
    const saved = await upsert(entry);
    if (!saved.ok) {
      await deps.opener.close();
      return saved;
    }
    session = { entry, port };
    return view();
  }

  async function close(): Promise<void> {
    if (session === null) return;
    session = null;
    await deps.opener.close();
  }

  /** 章节操作的共同结尾：失败时仍重新读取目录，版本冲突后界面拿到最新状态。 */
  async function afterChange(result: Result<unknown, RepoError>): Promise<Result<WorkView, AppError>> {
    if (!result.ok) return err(repo(result.error));
    return view();
  }

  function withPort<T>(f: (port: SqlPort) => Promise<Result<T, RepoError>>): Promise<Result<WorkView, AppError>> {
    if (session === null) return Promise.resolve(err({ code: 'no_work' }));
    return f(session.port).then(afterChange);
  }

  async function loadLibrary(): Promise<Result<LibraryView, AppError>> {
    const loaded = await load();
    if (!loaded.ok) return loaded;
    file = loaded.value;
    const dir = await libraryDir();
    if (!dir.ok) return dir;
    const works = await Promise.all(
      sortWorks(file.works).map(async (w) => ({ ...w, missing: !(await deps.library.probe(w.path)).hasProject })),
    );
    return ok({ libraryDir: dir.value, works });
  }

  return {
    loadLibrary,

    /** 在作品库下新建作品文件夹；文件夹名取自标题，重名时加序号。 */
    async createWork(title: string): Promise<Result<WorkView, AppError>> {
      const name = title.trim();
      if (name === '') return err({ code: 'repo', error: { code: 'invalid', detail: '作品名不能为空' } });
      const dir = await libraryDir();
      if (!dir.ok) return dir;
      const base = folderName(name);
      let path = joinPath(dir.value, base);
      for (let i = 2; (await deps.library.probe(path)).exists; i++) path = joinPath(dir.value, `${base}（${i}）`);
      const now = deps.clock.now();
      return openAt(path, (p) => ({ id: p.id, path, title: p.title, archived: false, lastOpenedAt: now }), name);
    },

    async openWork(id: string): Promise<Result<WorkView, AppError>> {
      const entry = file.works.find((w) => w.id === id);
      if (entry === undefined) return err({ code: 'not_found' });
      if (!(await deps.library.probe(entry.path)).hasProject) return err({ code: 'missing', path: entry.path });
      const now = deps.clock.now();
      return openAt(entry.path, (p) => ({ ...entry, id: p.id, title: p.title, lastOpenedAt: now }));
    },

    /** 打开其他位置的已有作品，加入作品列表。取消选择时返回 null。 */
    async addWorkFromFolder(): Promise<Result<WorkView | null, AppError>> {
      const path = await deps.library.pickFolder('打开作品文件夹');
      if (path === null) return ok(null);
      if (!(await deps.library.probe(path)).hasProject) return err({ code: 'not_a_work', path });
      const now = deps.clock.now();
      return openAt(path, (p) => {
        const known = file.works.find((w) => w.id === p.id || samePath(w.path, path));
        return { id: p.id, path, title: p.title, archived: known?.archived ?? false, lastOpenedAt: now };
      });
    },

    closeWork: close,

    async setArchived(id: string, archived: boolean): Promise<Result<LibraryView, AppError>> {
      if (!file.works.some((w) => w.id === id)) return err({ code: 'not_found' });
      const saved = await save({ ...file, works: file.works.map((w) => (w.id === id ? { ...w, archived } : w)) });
      return saved.ok ? loadLibrary() : saved;
    },

    /** 文件夹已不存在的作品从列表移除；不动任何文件。 */
    async removeMissingWork(id: string): Promise<Result<LibraryView, AppError>> {
      const entry = file.works.find((w) => w.id === id);
      if (entry === undefined) return err({ code: 'not_found' });
      if ((await deps.library.probe(entry.path)).hasProject) return err({ code: 'library', detail: '作品文件夹仍然存在，只能归档' });
      const saved = await save({ ...file, works: file.works.filter((w) => w.id !== id) });
      return saved.ok ? loadLibrary() : saved;
    },

    /** 更改新建作品的位置；已有作品不移动。取消选择时返回 null。 */
    async chooseLibraryDir(): Promise<Result<LibraryView | null, AppError>> {
      const dir = await deps.library.pickFolder('选择作品库位置');
      if (dir === null) return ok(null);
      const saved = await save({ ...file, libraryDir: dir });
      return saved.ok ? loadLibrary() : saved;
    },

    async updateWorkInfo(patch: ProjectPatch): Promise<Result<WorkView, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const current = await getProject(session.port);
      if (!current.ok) return err(repo(current.error));
      if (current.value === null) return err({ code: 'not_a_work', path: session.entry.path });
      const updated = await updateProject(session.port, current.value.id, current.value.version, patch, ctx());
      if (!updated.ok) return err(repo(updated.error));
      if (updated.value.title !== session.entry.title) {
        session = { ...session, entry: { ...session.entry, title: updated.value.title } };
        const saved = await upsert(session.entry);
        if (!saved.ok) return saved;
      }
      return view();
    },

    reloadWork: view,

    /** 载入一章正文；草稿与库中不同时一并返回，由作者决定恢复或丢弃。 */
    async openChapter(chapterId: string): Promise<Result<ChapterContent, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const saved = await listParagraphs(session.port, chapterId);
      if (!saved.ok) return err(repo(saved.error));
      const text = await deps.drafts.read(session.entry.path, chapterId);
      const draft = text.ok && text.value !== null ? parseDraft(text.value, chapterId) : null;
      return ok({ chapterId, saved: saved.value, draft: draft !== null && draftDiffers(draft, saved.value) ? draft : null });
    },

    /** 保存一章正文；成功后删除草稿。失败时返回给作者看的说明。 */
    async saveChapter(
      chapterId: string,
      saved: readonly SavedParagraph[],
      current: readonly CurrentParagraph[],
      edits: StructuralEdits,
    ): Promise<Result<SavedParagraph[], string>> {
      if (session === null) return err(describeError({ code: 'no_work' }));
      const result = await saveChapterParagraphs(session.port, chapterId, saved, current, edits, ctx());
      if (!result.ok) {
        return err(result.error.code === 'conflict' ? '正文已在别处修改，请复制或导出当前内容后重新打开章节' : describeError(repo(result.error)));
      }
      await deps.drafts.remove(session.entry.path, chapterId);
      return result;
    },

    /** 写草稿；失败不打扰作者（草稿只是意外退出时的退路）。 */
    async writeDraft(chapterId: string, paragraphs: readonly CurrentParagraph[]): Promise<void> {
      if (session === null) return;
      await deps.drafts.write(session.entry.path, chapterId, draftJson(chapterId, deps.clock.now(), paragraphs));
    },

    async discardDraft(chapterId: string): Promise<void> {
      if (session === null) return;
      await deps.drafts.remove(session.entry.path, chapterId);
    },

    /** 一章的快照，最近的在前（B06）。 */
    async listSnapshots(chapterId: string): Promise<Result<SnapshotSummary[], AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const list = await listSnapshots(session.port, chapterId);
      return list.ok ? list : err(repo(list.error));
    },

    async getSnapshot(snapshotId: string): Promise<Result<Snapshot, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const snapshot = await getSnapshot(session.port, snapshotId);
      return snapshot.ok ? snapshot : err(repo(snapshot.error));
    },

    /** 为当前已保存的正文建立快照；调用前界面已先保存编辑器中的内容。 */
    async createSnapshot(chapterId: string): Promise<Result<SnapshotSummary, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const created = await createSnapshot(session.port, { id: deps.ids.next(), chapterId, reason: 'manual' }, ctx());
      return created.ok ? created : err(repo(created.error));
    },

    /** 恢复到快照；现稿先存为“恢复前”快照。恢复后草稿已无意义，一并删除。 */
    async restoreSnapshot(snapshotId: string): Promise<Result<ChapterContent, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const restored = await restoreSnapshot(session.port, { snapshotId, backupId: deps.ids.next() }, ctx());
      if (!restored.ok) return err(repo(restored.error));
      const chapterId = restored.value.backup.chapterId;
      await deps.drafts.remove(session.entry.path, chapterId);
      return ok({ chapterId, saved: restored.value.paragraphs, draft: null });
    },

    exportText: (suggestedName: string, content: string) => deps.exporter.exportText(suggestedName, content),
    copyText: (content: string) => deps.exporter.copyText(content),

    createChapter: (title: string, after?: string) =>
      withPort((port) => createChapter(port, { id: deps.ids.next(), title, ...(after !== undefined && { after }) }, ctx())),
    renameChapter: (chapter: Chapter, title: string) => withPort((port) => renameChapter(port, chapter.id, chapter.version, title, ctx())),
    updateChapterNotes: (chapter: Chapter, notes: { summary: string; notes: string }) =>
      withPort((port) => updateChapterNotes(port, chapter.id, chapter.version, notes, ctx())),
    /** 把章节移到 after 之后；after 为 null 时移到最前。 */
    moveChapter: (chapter: Chapter, after: string | null) => withPort((port) => moveChapter(port, chapter.id, chapter.version, after, ctx())),
    trashChapter: (chapter: Chapter) => withPort((port) => trashChapter(port, chapter.id, chapter.version, ctx())),
    restoreChapter: (chapter: Chapter) => withPort((port) => restoreChapter(port, chapter.id, chapter.version, ctx())),
  };
}

export type AppService = ReturnType<typeof createAppService>;

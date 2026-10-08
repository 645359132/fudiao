// 界面状态（Zustand）。动作只调用应用服务层的用例，把结果放进状态；组件订阅状态、调用动作。
import type { Result } from '@fudiao/shared';
import type { Chapter, CurrentParagraph, ProjectPatch, SavedParagraph, Snapshot, SnapshotSummary, StructuralEdits } from '@fudiao/store';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SaveStatus } from '../app/autosave';
import { describeError } from '../app/errors';
import type { BackupInfo, DecodedText } from '../app/ports';
import type { AppError, AppService, ChapterContent, LibraryView, WorkView } from '../app/service';
import { splitText, type SplitRule } from '../app/text-import';

/** 导入预览：选中的文件、拆分方式与导入到哪里。 */
export type ImportDraft = { readonly decoded: DecodedText; readonly rule: SplitRule; readonly target: 'new' | 'current' };

/** 文件名去掉扩展名，作为新作品名或不拆分时的章节名。 */
export const baseName = (fileName: string) => fileName.replace(/\.(txt|md|markdown)$/i, '') || '导入的作品';

/** 正文编辑器向状态登记的句柄：离开章节前先保存。 */
export type EditorHandle = {
  readonly chapterId: string;
  readonly flush: () => Promise<boolean>;
};

export type AppState = {
  readonly library: LibraryView | null;
  readonly work: WorkView | null;
  readonly selectedChapterId: string | null;
  readonly panel: 'chapter' | 'info' | 'trash' | 'history' | 'backups';
  readonly busy: boolean;
  /** 最近一次失败的说明，作者关闭后清除。 */
  readonly message: string | null;
  /** 当前章节的正文（载入后）。 */
  readonly chapterContent: ChapterContent | null;
  readonly saveStatus: SaveStatus;
  /** 正文内容的版次：恢复快照后加一，编辑器据此换成新内容。 */
  readonly contentRevision: number;
  /** 当前章节的快照列表与正在预览的快照。 */
  readonly snapshots: readonly SnapshotSummary[] | null;
  readonly previewSnapshot: Snapshot | null;
  readonly importDraft: ImportDraft | null;
  readonly backups: readonly BackupInfo[] | null;
  readonly wordCount: number;

  readonly init: () => Promise<void>;
  readonly createWork: (title: string) => Promise<boolean>;
  readonly openWork: (id: string) => Promise<void>;
  readonly addWorkFromFolder: () => Promise<void>;
  readonly closeWork: () => Promise<void>;
  readonly setArchived: (id: string, archived: boolean) => Promise<void>;
  readonly removeMissingWork: (id: string) => Promise<void>;
  readonly chooseLibraryDir: () => Promise<void>;
  readonly updateWorkInfo: (patch: ProjectPatch) => Promise<boolean>;
  readonly createChapter: (title: string) => Promise<boolean>;
  readonly renameChapter: (id: string, title: string) => Promise<boolean>;
  readonly updateChapterNotes: (id: string, notes: { summary: string; notes: string }) => Promise<boolean>;
  /** 把章节移到 after 之后；after 为 null 时移到最前。 */
  readonly moveChapter: (id: string, after: string | null) => Promise<void>;
  readonly moveUp: (id: string) => Promise<void>;
  readonly moveDown: (id: string) => Promise<void>;
  /** 拖到某一章上：放到该章所在的位置。 */
  readonly dropChapter: (id: string, targetId: string) => Promise<void>;
  readonly trashChapter: (id: string) => Promise<void>;
  readonly restoreChapter: (id: string) => Promise<void>;
  readonly selectChapter: (id: string) => Promise<void>;
  readonly showPanel: (panel: AppState['panel']) => Promise<void>;
  readonly dismissMessage: () => void;

  /** 离开当前章节前保存正文；保存失败时留在本章并说明原因，返回能否离开。 */
  readonly leaveChapter: () => Promise<boolean>;
  readonly registerEditor: (handle: EditorHandle | null) => void;
  readonly loadChapter: (chapterId: string) => Promise<void>;
  readonly saveChapter: (
    chapterId: string,
    saved: readonly SavedParagraph[],
    current: readonly CurrentParagraph[],
    edits: StructuralEdits,
  ) => Promise<Result<SavedParagraph[], string>>;
  readonly writeDraft: (chapterId: string, paragraphs: readonly CurrentParagraph[]) => void;
  /** 作者选择恢复或丢弃草稿后，收起恢复提示；丢弃时删除草稿文件。 */
  readonly settleDraft: (discard: boolean) => Promise<void>;
  readonly setSaveStatus: (status: SaveStatus) => void;
  readonly setWordCount: (count: number) => void;
  readonly copyText: (text: string) => Promise<void>;
  readonly exportText: (title: string, text: string) => Promise<void>;
  /** 保存正文后为当前章节建立快照。 */
  readonly createSnapshot: () => Promise<void>;
  /** 保存正文后打开当前章节的快照列表。 */
  readonly openHistory: () => Promise<void>;
  readonly previewSnapshotById: (id: string) => Promise<void>;
  /** 恢复到快照（现稿先存为快照），回到正文。 */
  readonly restoreSnapshot: (id: string) => Promise<void>;

  /** 选择 TXT 或 Markdown 文件，进入导入预览。 */
  readonly startTextImport: (target: 'new' | 'current') => Promise<void>;
  readonly setImportRule: (rule: SplitRule) => void;
  readonly setImportEncoding: (encoding: string) => Promise<void>;
  readonly cancelImport: () => Promise<void>;
  readonly confirmImport: () => Promise<void>;
  readonly importProject: () => Promise<void>;
  readonly exportBook: (kind: 'txt' | 'md') => Promise<void>;
  readonly exportChapter: (id: string, kind: 'txt' | 'md') => Promise<void>;
  readonly exportProject: () => Promise<void>;
  readonly openBackups: () => Promise<void>;
  readonly createBackup: () => Promise<void>;
  readonly restoreBackup: (name: string) => Promise<void>;
};

export type AppStore = StoreApi<AppState>;

export function createAppStore(service: AppService): AppStore {
  return createStore<AppState>()((set, get) => {
    let editor: EditorHandle | null = null;

    /** 执行一个用例：失败时显示说明；内容在别处被修改时重新读取作品。返回是否成功。 */
    async function run<T>(task: Promise<Result<T, AppError>>, apply: (value: T) => Partial<AppState>): Promise<boolean> {
      set({ busy: true });
      const result = await task;
      if (result.ok) {
        set({ ...apply(result.value), busy: false, message: null });
        return true;
      }
      set({ busy: false, message: describeError(result.error) });
      if (result.error.code === 'repo' && result.error.error.code === 'conflict') {
        const reloaded = await service.reloadWork();
        if (reloaded.ok) set({ work: reloaded.value });
      }
      return false;
    }

    const chapter = (id: string): Chapter | undefined => {
      const work = get().work;
      return work?.chapters.find((c) => c.id === id) ?? work?.trashed.find((c) => c.id === id);
    };
    const withChapter = (id: string, f: (c: Chapter) => Promise<Result<WorkView, AppError>>, after?: Partial<AppState>) => {
      const c = chapter(id);
      return c === undefined ? Promise.resolve(false) : run(f(c), (work) => ({ work, ...after }));
    };
    /** 打开已有作品后的自动备份；失败只提示，不妨碍写作。 */
    async function autoBackup() {
      const result = await service.autoBackupIfDue();
      if (!result.ok) set({ message: `自动备份失败：${describeError(result.error)}` });
    }

    const opened = (work: WorkView): Partial<AppState> => ({
      work,
      selectedChapterId: work.chapters[0]?.id ?? null,
      panel: 'chapter',
      chapterContent: null,
    });

    return {
      library: null,
      work: null,
      selectedChapterId: null,
      panel: 'chapter',
      busy: false,
      message: null,
      chapterContent: null,
      saveStatus: { kind: 'saved' },
      wordCount: 0,
      contentRevision: 0,
      snapshots: null,
      previewSnapshot: null,
      importDraft: null,
      backups: null,

      async init() {
        await run(service.loadLibrary(), (library) => ({ library }));
      },
      createWork: (title) => run(service.createWork(title), opened),
      async openWork(id) {
        if (await run(service.openWork(id), opened)) await autoBackup();
      },
      async addWorkFromFolder() {
        const before = get().work;
        await run(service.addWorkFromFolder(), (work) => (work === null ? {} : opened(work)));
        if (get().work !== before) await autoBackup();
      },
      async closeWork() {
        if (!(await get().leaveChapter())) return;
        await service.closeWork();
        set({ work: null, selectedChapterId: null, chapterContent: null });
        await get().init();
      },
      async setArchived(id, archived) {
        await run(service.setArchived(id, archived), (library) => ({ library }));
      },
      async removeMissingWork(id) {
        await run(service.removeMissingWork(id), (library) => ({ library }));
      },
      async chooseLibraryDir() {
        await run(service.chooseLibraryDir(), (library) => (library === null ? {} : { library }));
      },
      updateWorkInfo: (patch) => run(service.updateWorkInfo(patch), (work) => ({ work })),

      async createChapter(title) {
        if (!(await get().leaveChapter())) return false;
        const selected = get().selectedChapterId;
        const ok = await run(service.createChapter(title, selected ?? undefined), (work) => ({ work }));
        if (ok) {
          // 新章节插在所选章节之后（没有所选时在末尾），并成为所选。
          const work = get().work;
          const index = selected === null ? (work?.chapters.length ?? 0) - 1 : (work?.chapters.findIndex((c) => c.id === selected) ?? -1) + 1;
          set({ selectedChapterId: work?.chapters[index]?.id ?? null, panel: 'chapter' });
        }
        return ok;
      },
      renameChapter: (id, title) => withChapter(id, (c) => service.renameChapter(c, title)),
      updateChapterNotes: (id, notes) => withChapter(id, (c) => service.updateChapterNotes(c, notes)),
      async moveChapter(id, after) {
        await withChapter(id, (c) => service.moveChapter(c, after));
      },
      async moveUp(id) {
        const list = get().work?.chapters ?? [];
        const i = list.findIndex((c) => c.id === id);
        if (i > 0) await get().moveChapter(id, list[i - 2]?.id ?? null);
      },
      async moveDown(id) {
        const list = get().work?.chapters ?? [];
        const i = list.findIndex((c) => c.id === id);
        const next = list[i + 1];
        if (i >= 0 && next !== undefined) await get().moveChapter(id, next.id);
      },
      async dropChapter(id, targetId) {
        if (id === targetId) return;
        const list = get().work?.chapters ?? [];
        const from = list.findIndex((c) => c.id === id);
        const to = list.findIndex((c) => c.id === targetId);
        if (from < 0 || to < 0) return;
        // 向下拖放到目标之后，向上拖放到目标之前。
        const after = from < to ? targetId : (list[to - 1]?.id ?? null);
        await get().moveChapter(id, after);
      },
      async trashChapter(id) {
        const selected = get().selectedChapterId === id;
        if (selected && !(await get().leaveChapter())) return;
        await withChapter(id, (c) => service.trashChapter(c), selected ? { selectedChapterId: null, chapterContent: null } : {});
      },
      async restoreChapter(id) {
        if (!(await get().leaveChapter())) return;
        await withChapter(id, (c) => service.restoreChapter(c), { selectedChapterId: id, panel: 'chapter' });
      },
      async selectChapter(id) {
        if (get().selectedChapterId === id && get().panel === 'chapter') return;
        if (!(await get().leaveChapter())) return;
        set({ selectedChapterId: id, panel: 'chapter', snapshots: null, previewSnapshot: null });
      },
      async showPanel(panel) {
        if (panel === 'chapter') {
          set({ panel });
          return;
        }
        if (!(await get().leaveChapter())) return;
        // 离开正文后丢掉缓存的内容，回来时从库中重新读取。
        set({ panel, chapterContent: null });
      },
      dismissMessage: () => set({ message: null }),

      async leaveChapter() {
        if (editor === null) return true;
        const saved = await editor.flush();
        if (!saved) set({ message: '本章正文没有保存成功，已留在本章。可以复制全文或导出本章后再离开。' });
        return saved;
      },
      registerEditor(handle) {
        editor = handle;
      },
      async loadChapter(chapterId) {
        await run(service.openChapter(chapterId), (content) =>
          get().selectedChapterId === chapterId ? { chapterContent: content, saveStatus: { kind: 'saved' } } : {},
        );
      },
      async saveChapter(chapterId, saved, current, edits) {
        const result = await service.saveChapter(chapterId, saved, current, edits);
        // 缓存的内容跟着保存结果更新：编辑器重新挂载时以最新保存的内容为准。
        const content = get().chapterContent;
        if (result.ok && content !== null && content.chapterId === chapterId) set({ chapterContent: { ...content, saved: result.value } });
        return result;
      },
      writeDraft(chapterId, paragraphs) {
        void service.writeDraft(chapterId, paragraphs);
      },
      async settleDraft(discard) {
        const content = get().chapterContent;
        if (content === null) return;
        if (discard) await service.discardDraft(content.chapterId);
        set({ chapterContent: { ...content, draft: null } });
      },
      setSaveStatus: (saveStatus) => set({ saveStatus }),
      setWordCount: (wordCount) => set({ wordCount }),
      async copyText(text) {
        const result = await service.copyText(text);
        set({ message: result.ok ? null : `复制失败：${result.error}` });
      },
      async createSnapshot() {
        const chapterId = get().selectedChapterId;
        if (chapterId === null || !(await get().leaveChapter())) return;
        await run(service.createSnapshot(chapterId), (summary) => ({
          snapshots: [summary, ...(get().snapshots ?? [])],
          message: null,
        }));
      },
      async openHistory() {
        const chapterId = get().selectedChapterId;
        if (chapterId === null || !(await get().leaveChapter())) return;
        await run(service.listSnapshots(chapterId), (snapshots) => ({ snapshots, previewSnapshot: null, panel: 'history', chapterContent: null }));
      },
      async previewSnapshotById(id) {
        await run(service.getSnapshot(id), (previewSnapshot) => ({ previewSnapshot }));
      },
      async restoreSnapshot(id) {
        if (!(await get().leaveChapter())) return;
        const ok = await run(service.restoreSnapshot(id), (content) => ({
          chapterContent: content,
          contentRevision: get().contentRevision + 1,
          previewSnapshot: null,
          panel: 'chapter',
          saveStatus: { kind: 'saved' },
        }));
        const chapterId = get().selectedChapterId;
        if (ok && chapterId !== null) await run(service.listSnapshots(chapterId), (snapshots) => ({ snapshots }));
      },
      async startTextImport(target) {
        if (target === 'current' && !(await get().leaveChapter())) return;
        const picked = await service.pickText();
        if (!picked.ok) set({ message: `读取文件失败：${picked.error}` });
        else if (picked.value !== null) {
          const md = /\.(md|markdown)$/i.test(picked.value.fileName);
          set({ importDraft: { decoded: picked.value, rule: { kind: md ? 'markdown' : 'auto' }, target }, message: null });
        }
      },
      setImportRule(rule) {
        const draft = get().importDraft;
        if (draft !== null) set({ importDraft: { ...draft, rule } });
      },
      async setImportEncoding(encoding) {
        const draft = get().importDraft;
        if (draft === null) return;
        const decoded = await service.redecode(draft.decoded.token, encoding);
        if (decoded.ok) set({ importDraft: { ...draft, decoded: decoded.value } });
        else set({ message: decoded.error });
      },
      async cancelImport() {
        const draft = get().importDraft;
        set({ importDraft: null });
        if (draft !== null) await service.releaseImport(draft.decoded.token);
      },
      async confirmImport() {
        const draft = get().importDraft;
        if (draft === null) return;
        const title = baseName(draft.decoded.fileName);
        const chapters = splitText(draft.decoded.text, draft.rule, title);
        if (!chapters.ok) {
          set({ message: chapters.error });
          return;
        }
        const done =
          draft.target === 'new'
            ? await run(service.importTextAsWork(title, chapters.value), opened)
            : await run(service.importChaptersIntoWork(chapters.value), (work) => ({ work }));
        if (done) {
          set({ importDraft: null });
          await service.releaseImport(draft.decoded.token);
        }
      },
      async importProject() {
        await run(service.importProject(), (work) => (work === null ? {} : opened(work)));
      },
      async exportBook(kind) {
        if (!(await get().leaveChapter())) return;
        await run(service.exportText(kind), () => ({}));
      },
      async exportChapter(id, kind) {
        if (!(await get().leaveChapter())) return;
        await run(service.exportText(kind, id), () => ({}));
      },
      async exportProject() {
        if (!(await get().leaveChapter())) return;
        await run(service.exportProject(), () => ({}));
      },
      async openBackups() {
        if (!(await get().leaveChapter())) return;
        await run(service.listBackups(), (backups) => ({ backups, panel: 'backups', chapterContent: null }));
      },
      async createBackup() {
        if (!(await get().leaveChapter())) return;
        if (await run(service.createBackup(), () => ({}))) await run(service.listBackups(), (backups) => ({ backups }));
      },
      async restoreBackup(name) {
        if (!(await get().leaveChapter())) return;
        const ok = await run(service.restoreBackup(name), (work) => ({
          work,
          chapterContent: null,
          contentRevision: get().contentRevision + 1,
          selectedChapterId: work.chapters.some((c) => c.id === get().selectedChapterId) ? get().selectedChapterId : (work.chapters[0]?.id ?? null),
        }));
        if (ok) await run(service.listBackups(), (backups) => ({ backups }));
      },
      async exportText(title, text) {
        const result = await service.exportPlainText(`${title}.txt`, text);
        if (!result.ok) set({ message: `导出失败：${result.error}` });
      },
    };
  });
}

// 界面状态（Zustand）。动作只调用应用服务层的用例，把结果放进状态；组件订阅状态、调用动作。
import type { Result } from '@fudiao/shared';
import type { Chapter, CurrentParagraph, Entity, EntityKind, EntityPatch, Fact, FactInput, FactStatus, LlmCallRow, ModelPatch, ProjectPatch, SavedParagraph, SearchHit, SearchResult, Snapshot, SnapshotSummary, SourceStats, StructuralEdits, UsageSummary, Candidate } from '@fudiao/store';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SaveStatus } from '../app/autosave';
import { describeError } from '../app/errors';
import type { BackupInfo, DecodedText } from '../app/ports';
import { NO_OVERRIDES, type ContextManifest, type ContextOverrides } from '@fudiao/context';
import type { ConnectionReport, ListedModel } from '@fudiao/llm';
import type { SelectionOperation } from '@fudiao/prompts';
import type { ModelServicesView, ProviderForm, ProviderView } from '../app/model-services';
import type { AppError, AppService, ChapterContent, LibraryView, WorkView } from '../app/service';
import { splitText, type SplitRule } from '../app/text-import';
import type { EditorSelection } from '../app/writing-context';
import { OPERATION_LABELS } from '../app/selection-ops';
import { reduceTasks, type TaskEvent, type TaskRecord } from '../app/tasks';

/** 导入预览：选中的文件、拆分方式与导入到哪里。 */
export type ImportDraft = { readonly decoded: DecodedText; readonly rule: SplitRule; readonly target: 'new' | 'current' };

/** 文件名去掉扩展名，作为新作品名或不拆分时的章节名。 */
export const baseName = (fileName: string) => fileName.replace(/\.(txt|md|markdown)$/i, '') || '导入的作品';

/** 打开章节后要选中并滚动到的位置（查找结果）。 */
export type Reveal = { readonly chapterId: string; readonly paragraphId: string; readonly start: number; readonly end: number };

/** 正文编辑器向状态登记的句柄：离开章节前先保存。 */
export type EditorHandle = {
  readonly chapterId: string;
  readonly flush: () => Promise<boolean>;
  /** 当前的选区或光标；选在段落之外时为 null。 */
  readonly selection: () => EditorSelection | null;
  /** 选中的文字（段落之间以换行连接）。 */
  readonly selectedText: () => string;
};

/** 一次选区操作：流式生成的文字与状态（B16）。 */
export type AiWriteJob = {
  readonly operation: SelectionOperation;
  readonly instruction: string;
  readonly status: 'running' | 'done' | 'cancelled' | 'failed';
  readonly text: string;
  readonly error: string | null;
  /** 完整生成后存成的候选稿。 */
  readonly candidateId: string | null;
};

export type AppState = {
  readonly library: LibraryView | null;
  readonly work: WorkView | null;
  readonly selectedChapterId: string | null;
  readonly panel: 'chapter' | 'info' | 'trash' | 'history' | 'backups' | 'settings' | 'facts' | 'sources' | 'search' | 'usage' | 'tasks';
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
  /** 当前作品的设定条目（打开作品时载入，正文高亮也用它）。 */
  readonly entities: readonly Entity[];
  readonly selectedEntityId: string | null;
  /** 正文旁的设定卡片（Ctrl + 点击高亮的名字时打开）。 */
  readonly drawerEntityId: string | null;
  /** 当前作品的事实（打开作品与设定变化后重新读取，其中的待复核标记是最新的）。 */
  readonly facts: readonly Fact[];
  /** 事实页中选中的事实；“new” 表示正在新建。 */
  readonly selectedFactId: string | null;
  readonly wordCount: number;
  /** 段落来源统计（打开“段落来源”时读取）。 */
  readonly sourceStats: SourceStats | null;
  /** AI 上下文清单（B18）：抽屉是否打开、最近一次的清单、计算时的选区，以及作者的增减（按章节，本次打开作品期间有效）。 */
  readonly contextDrawerOpen: boolean;
  readonly writingContext: ContextManifest | null;
  readonly contextSelection: EditorSelection | null;
  readonly contextOverrides: Readonly<Record<string, ContextOverrides>>;
  /** AI 写作抽屉：打开时记下的选区与选中的文字，以及最近一次选区操作。 */
  readonly writeDrawerOpen: boolean;
  readonly writeSelection: EditorSelection | null;
  readonly writeSelectedText: string;
  readonly aiWrite: AiWriteJob | null;
  /** 任务中心（B16、B19）：本次运行中的模型任务，新的在前。 */
  readonly tasks: readonly TaskRecord[];
  /** 当前章节待处理的候选稿（B17），新的在前。 */
  readonly candidates: readonly Candidate[];
  /** 用量与费用（打开“用量与费用”时读取）。 */
  readonly usage: { readonly summary: UsageSummary; readonly recent: readonly LlmCallRow[] } | null;
  /** 模型服务页（应用级，盖在作品列表或作品界面之上）。 */
  readonly modelServicesOpen: boolean;
  readonly modelServices: ModelServicesView | null;
  /** 各模型最近一次连接测试：进行中或结果。 */
  readonly connectionTests: Readonly<Record<string, ConnectionReport | 'testing'>>;
  /** 各服务获取到的模型列表（获取中为 loading）。 */
  readonly listedModels: Readonly<Record<string, readonly ListedModel[] | 'loading'>>;
  /** 正在自检的模型。 */
  readonly selfTesting: readonly string[];
  /** 查找页的查询与结果；回到正文后保留，再打开查找页时接着看。 */
  readonly searchQuery: string;
  readonly searchResult: SearchResult | null;
  readonly reveal: Reveal | null;

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

  readonly openSettings: (entityId?: string) => Promise<void>;
  readonly selectEntity: (id: string | null) => void;
  readonly createEntity: (kind: EntityKind, name: string) => Promise<boolean>;
  readonly saveEntity: (id: string, patch: EntityPatch) => Promise<boolean>;
  readonly setEntityLocked: (id: string, locked: boolean) => Promise<void>;
  readonly deleteEntity: (id: string) => Promise<boolean>;
  readonly openEntityDrawer: (id: string | null) => void;

  readonly openFacts: (factId?: string) => Promise<void>;
  readonly selectFact: (id: string | null) => void;
  readonly saveFact: (id: string | null, input: FactInput) => Promise<boolean>;
  readonly setFactStatus: (id: string, status: FactStatus) => Promise<void>;
  readonly deleteFact: (id: string) => Promise<boolean>;

  /** 保存正文后打开段落来源统计。 */
  readonly openSourceStats: () => Promise<void>;
  readonly setShowParagraphSource: (show: boolean) => Promise<void>;

  /** 保存正文后按当前光标计算上下文清单并打开抽屉。 */
  readonly openContext: () => Promise<void>;
  readonly closeContext: () => void;
  /** 作者加入（include 为真）或移除一个上下文条目，随即重算。 */
  readonly toggleContextItem: (id: string, include: boolean) => Promise<void>;
  /** 保存正文后记下当前选区，打开 AI 写作抽屉。 */
  readonly openAiWrite: () => Promise<void>;
  readonly closeAiWrite: () => void;
  readonly runSelectionOp: (operation: SelectionOperation, instruction: string) => Promise<void>;
  readonly cancelSelectionOp: () => void;
  /** 保存正文后打开任务中心。 */
  readonly openTasks: () => Promise<void>;
  readonly cancelTask: (id: string) => void;
  readonly clearFinishedTasks: () => void;
  readonly editCandidate: (id: string, content: string) => Promise<boolean>;
  readonly discardCandidate: (id: string) => Promise<void>;
  /** 保存正文后接受候选稿，写入后重新载入本章。 */
  readonly acceptCandidate: (id: string) => Promise<void>;
  /** 保存正文后打开用量与费用。 */
  readonly openUsage: () => Promise<void>;
  /** 保存正文后打开查找页；给出查询时（例如正文中选中的文字）立即查找。 */
  readonly openSearch: (query?: string) => Promise<void>;
  readonly runSearch: (query: string) => Promise<void>;
  /** 打开结果所在的章节，选中这一处。 */
  readonly revealHit: (hit: SearchHit) => Promise<void>;
  readonly clearReveal: () => void;

  /** 保存正文后打开模型服务页。 */
  readonly openModelServices: () => Promise<void>;
  readonly closeModelServices: () => void;
  readonly saveProvider: (provider: ProviderView | null, form: ProviderForm) => Promise<boolean>;
  readonly deleteProvider: (provider: ProviderView) => Promise<void>;
  readonly addModel: (providerId: string, modelId: string) => Promise<boolean>;
  readonly deleteModel: (modelId: string) => Promise<void>;
  readonly setDefaultModel: (modelId: string) => Promise<void>;
  readonly testConnection: (modelId: string) => Promise<void>;
  readonly fetchModelList: (providerId: string) => Promise<void>;
  readonly addListedModel: (providerId: string, listed: ListedModel) => Promise<void>;
  readonly updateModel: (modelId: string, patch: ModelPatch) => Promise<boolean>;
  readonly runSelfTest: (modelId: string) => Promise<void>;
};

export type AppStore = StoreApi<AppState>;

export function createAppStore(service: AppService): AppStore {
  return createStore<AppState>()((set, get) => {
    let editor: EditorHandle | null = null;
    /** 正在进行的选区操作；取消时中止。 */
    let writeAbort: AbortController | null = null;
    /** 各个进行中的任务，任务中心据此取消。 */
    const taskAborts = new Map<string, AbortController>();
    let taskSeq = 0;
    const task = (event: TaskEvent) => set({ tasks: reduceTasks(get().tasks, event) });

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
    async function loadEntities() {
      await run(service.listEntities(), (entities) => ({ entities }));
      await run(service.listFacts(), (facts) => ({ facts }));
    }

    const reloadFacts = () => run(service.listFacts(), (facts) => ({ facts }));

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
      entities: [],
      selectedEntityId: null,
      drawerEntityId: null,
      facts: [],
      selectedFactId: null,
      sourceStats: null,
      usage: null,
      contextDrawerOpen: false,
      writingContext: null,
      contextSelection: null,
      contextOverrides: {},
      writeDrawerOpen: false,
      writeSelection: null,
      writeSelectedText: '',
      aiWrite: null,
      candidates: [],
      tasks: [],
      searchQuery: '',
      searchResult: null,
      reveal: null,
      modelServicesOpen: false,
      modelServices: null,
      connectionTests: {},
      listedModels: {},
      selfTesting: [],

      async init() {
        await run(service.loadLibrary(), (library) => ({ library }));
      },
      async createWork(title) {
        const done = await run(service.createWork(title), opened);
        if (done) await loadEntities();
        return done;
      },
      async openWork(id) {
        if (await run(service.openWork(id), opened)) {
          await loadEntities();
          await autoBackup();
        }
      },
      async addWorkFromFolder() {
        const before = get().work;
        await run(service.addWorkFromFolder(), (work) => (work === null ? {} : opened(work)));
        if (get().work !== before) {
          await loadEntities();
          await autoBackup();
        }
      },
      async closeWork() {
        if (!(await get().leaveChapter())) return;
        await service.closeWork();
        set({ work: null, selectedChapterId: null, chapterContent: null, entities: [], selectedEntityId: null, drawerEntityId: null, facts: [], selectedFactId: null, sourceStats: null, usage: null, searchQuery: '', searchResult: null, reveal: null, contextDrawerOpen: false, writingContext: null, contextSelection: null, contextOverrides: {}, writeDrawerOpen: false, aiWrite: null, candidates: [] });
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
        const before = get().work;
        await run(service.importProject(), (work) => (work === null ? {} : opened(work)));
        if (get().work !== before) await loadEntities();
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
      async openSettings(entityId) {
        if (!(await get().leaveChapter())) return;
        set({ panel: 'settings', chapterContent: null, selectedEntityId: entityId ?? get().selectedEntityId, drawerEntityId: null });
      },
      selectEntity: (id) => set({ selectedEntityId: id }),
      async createEntity(kind, name) {
        let createdId: string | null = null;
        const done = await run(service.createEntity(kind, name), (r) => {
          createdId = r.created.id;
          return { entities: r.entities };
        });
        if (done) set({ selectedEntityId: createdId });
        return done;
      },
      async saveEntity(id, patch) {
        const entity = get().entities.find((e) => e.id === id);
        if (entity === undefined) return false;
        const done = await run(service.updateEntity(entity, patch), (entities) => ({ entities }));
        if (!done) await loadEntities();
        else await reloadFacts();
        return done;
      },
      async setEntityLocked(id, locked) {
        const entity = get().entities.find((e) => e.id === id);
        if (entity !== undefined) await run(service.setEntityLocked(entity, locked), (entities) => ({ entities }));
      },
      async deleteEntity(id) {
        const entity = get().entities.find((e) => e.id === id);
        if (entity === undefined) return false;
        const done = await run(service.deleteEntity(entity), (entities) => ({ entities, selectedEntityId: null }));
        if (done) await reloadFacts();
        return done;
      },
      // 设定卡片与上下文清单共用正文旁的位置，打开一个就收起另一个。
      openEntityDrawer: (id) => set(id === null ? { drawerEntityId: null } : { drawerEntityId: id, contextDrawerOpen: false, writeDrawerOpen: false }),
      async openFacts(factId) {
        if (!(await get().leaveChapter())) return;
        set({ panel: 'facts', chapterContent: null, selectedFactId: factId ?? get().selectedFactId, drawerEntityId: null });
        await reloadFacts();
      },
      selectFact: (id) => set({ selectedFactId: id }),
      async openSourceStats() {
        if (!(await get().leaveChapter())) return;
        await run(service.sourceStats(), (sourceStats) => ({ sourceStats, panel: 'sources', chapterContent: null, drawerEntityId: null }));
      },
      async openContext() {
        const chapterId = get().selectedChapterId;
        if (chapterId === null) return;
        const selection = editor?.chapterId === chapterId ? editor.selection() : null;
        if (editor !== null && !(await editor.flush())) return;
        const overrides = get().contextOverrides[chapterId] ?? NO_OVERRIDES;
        await run(service.writingContext(chapterId, selection, overrides), (writingContext) => ({
          writingContext,
          contextSelection: selection,
          contextDrawerOpen: true,
          writeDrawerOpen: false,
          drawerEntityId: null,
        }));
      },
      closeContext: () => set({ contextDrawerOpen: false }),
      async toggleContextItem(id, include) {
        const chapterId = get().selectedChapterId;
        if (chapterId === null) return;
        const current = get().contextOverrides[chapterId] ?? NO_OVERRIDES;
        const next: ContextOverrides = {
          include: include ? [...current.include.filter((x) => x !== id), id] : current.include.filter((x) => x !== id),
          exclude: include ? current.exclude.filter((x) => x !== id) : [...current.exclude.filter((x) => x !== id), id],
        };
        set({ contextOverrides: { ...get().contextOverrides, [chapterId]: next } });
        await run(service.writingContext(chapterId, get().contextSelection, next), (writingContext) => ({ writingContext }));
      },
      async openAiWrite() {
        const chapterId = get().selectedChapterId;
        if (chapterId === null) return;
        const handle = editor?.chapterId === chapterId ? editor : null;
        const selection = handle?.selection() ?? null;
        const selectedText = handle?.selectedText() ?? '';
        if (handle !== null && !(await handle.flush())) return;
        set({ writeDrawerOpen: true, writeSelection: selection, writeSelectedText: selectedText, contextSelection: selection, drawerEntityId: null, contextDrawerOpen: false });
        await run(service.listCandidates(chapterId), (candidates) => ({ candidates }));
      },
      closeAiWrite: () => {
        writeAbort?.abort();
        set({ writeDrawerOpen: false });
      },
      async runSelectionOp(operation, instruction) {
        const chapterId = get().selectedChapterId;
        if (chapterId === null || get().aiWrite?.status === 'running') return;
        const abort = new AbortController();
        writeAbort = abort;
        set({ aiWrite: { operation, instruction, status: 'running', text: '', error: null, candidateId: null } });
        const taskId = `task-${++taskSeq}`;
        taskAborts.set(taskId, abort);
        const chapterTitle = get().work?.chapters.find((c) => c.id === chapterId)?.title ?? '';
        task({ type: 'started', task: { id: taskId, kind: 'selection_edit', title: `${OPERATION_LABELS[operation]} · ${chapterTitle}`, chapterId, startedAt: new Date().toISOString() } });
        const update = (patch: Partial<AiWriteJob>) => {
          const job = get().aiWrite;
          if (job !== null && writeAbort === abort) set({ aiWrite: { ...job, ...patch } });
        };
        const result = await service.runSelectionOperation(
          { chapterId, selection: get().writeSelection, operation, instruction, overrides: get().contextOverrides[chapterId] ?? NO_OVERRIDES },
          {
            signal: abort.signal,
            onEvent: (e) => {
              if (e.type === 'text') {
                update({ text: (get().aiWrite?.text ?? '') + e.delta });
                task({ type: 'text', id: taskId, delta: e.delta });
              } else task({ type: 'usage', id: taskId, usage: e.usage });
            },
          },
        );
        if (result.ok) {
          const { outcome, text, refusal } = result.value.result;
          const candidate = result.value.candidate;
          if (candidate !== null) set({ candidates: [candidate, ...get().candidates] });
          update({
            candidateId: candidate?.id ?? null,
            text,
            status: outcome === 'cancelled' ? 'cancelled' : outcome === 'refused' ? 'failed' : 'done',
            error: outcome === 'refused' ? `模型拒绝了这个请求${refusal?.explanation ? `：${refusal.explanation}` : ''}` : outcome === 'truncated' ? '输出达到上限，结果可能不完整' : null,
          });
          task({
            type: 'finished',
            id: taskId,
            status: outcome === 'cancelled' ? 'cancelled' : outcome === 'refused' ? 'failed' : 'done',
            finishedAt: new Date().toISOString(),
            text,
            cost: result.value.cost,
            error: outcome === 'refused' ? '模型拒绝了这个请求' : null,
          });
        } else {
          const status = abort.signal.aborted ? 'cancelled' : 'failed';
          update({ status, error: describeError(result.error) });
          task({ type: 'finished', id: taskId, status, finishedAt: new Date().toISOString(), error: describeError(result.error) });
        }
        taskAborts.delete(taskId);
        if (writeAbort === abort) writeAbort = null;
      },
      cancelSelectionOp: () => writeAbort?.abort(),
      async openTasks() {
        if (!(await get().leaveChapter())) return;
        set({ panel: 'tasks', chapterContent: null, drawerEntityId: null });
      },
      cancelTask: (id) => taskAborts.get(id)?.abort(),
      clearFinishedTasks: () => task({ type: 'clearFinished' }),
      async editCandidate(id, content) {
        const candidate = get().candidates.find((c) => c.id === id);
        if (candidate === undefined) return false;
        return run(service.editCandidate(candidate, content), (updated) => ({ candidates: get().candidates.map((c) => (c.id === id ? updated : c)) }));
      },
      async discardCandidate(id) {
        const candidate = get().candidates.find((c) => c.id === id);
        if (candidate !== undefined) await run(service.discardCandidate(candidate), () => ({ candidates: get().candidates.filter((c) => c.id !== id) }));
      },
      async acceptCandidate(id) {
        const chapterId = get().selectedChapterId;
        if (chapterId === null || !(await get().leaveChapter())) return;
        const accepted = await run(service.acceptCandidate(id), ({ paragraphs }) => ({
          chapterContent: { chapterId, saved: paragraphs, draft: null },
          contentRevision: get().contentRevision + 1,
          saveStatus: { kind: 'saved' },
          candidates: get().candidates.filter((c) => c.id !== id),
        }));
        // 过期的候选稿同样不再列出；直接读取列表，不清掉刚显示的原因。
        if (!accepted) {
          const list = await service.listCandidates(chapterId);
          if (list.ok) set({ candidates: list.value });
        }
      },
      async openUsage() {
        if (!(await get().leaveChapter())) return;
        await run(service.usage(), (usage) => ({ usage, panel: 'usage', chapterContent: null, drawerEntityId: null }));
      },
      async openSearch(query) {
        if (!(await get().leaveChapter())) return;
        set({ panel: 'search', chapterContent: null, drawerEntityId: null });
        if (query !== undefined && query.trim() !== '') await get().runSearch(query);
      },
      async runSearch(query) {
        set({ searchQuery: query });
        if (query.trim() === '') {
          set({ searchResult: null });
          return;
        }
        await run(service.search(query), (searchResult) => ({ searchResult }));
      },
      async revealHit(hit) {
        if (!(await get().leaveChapter())) return;
        set({ reveal: { chapterId: hit.chapterId, paragraphId: hit.paragraphId, start: hit.start, end: hit.end } });
        await get().selectChapter(hit.chapterId);
      },
      clearReveal: () => set({ reveal: null }),
      async openModelServices() {
        if (!(await get().leaveChapter())) return;
        // 作品界面回来时从库中重新读取正文。
        set({ modelServicesOpen: true, chapterContent: null, drawerEntityId: null });
        await run(service.loadModelServices(), (modelServices) => ({ modelServices }));
      },
      closeModelServices: () => set({ modelServicesOpen: false }),
      saveProvider: (provider, form) => run(service.saveProvider(provider, form), (modelServices) => ({ modelServices })),
      async deleteProvider(provider) {
        await run(service.deleteProvider(provider), (modelServices) => ({ modelServices }));
      },
      addModel: (providerId, modelId) => run(service.addModel(providerId, modelId), (modelServices) => ({ modelServices })),
      async deleteModel(modelId) {
        const model = get().modelServices?.models.find((m) => m.id === modelId);
        if (model !== undefined) await run(service.deleteModel(model), (modelServices) => ({ modelServices }));
      },
      async setDefaultModel(modelId) {
        await run(service.setDefaultModel(modelId), (modelServices) => ({ modelServices }));
      },
      async fetchModelList(providerId) {
        set({ listedModels: { ...get().listedModels, [providerId]: 'loading' } });
        const result = await service.fetchModelList(providerId);
        if (result.ok) set({ listedModels: { ...get().listedModels, [providerId]: result.value } });
        else {
          const { [providerId]: _dropped, ...rest } = get().listedModels;
          set({ listedModels: rest, message: describeError(result.error) });
        }
      },
      async addListedModel(providerId, listed) {
        await run(service.addModel(providerId, listed.id, listed), (modelServices) => ({ modelServices }));
      },
      async updateModel(modelId, patch) {
        const model = get().modelServices?.models.find((m) => m.id === modelId);
        return model === undefined ? false : run(service.updateModel(model, patch), (modelServices) => ({ modelServices }));
      },
      async runSelfTest(modelId) {
        set({ selfTesting: [...get().selfTesting, modelId] });
        const result = await service.runSelfTest(modelId);
        const selfTesting = get().selfTesting.filter((id) => id !== modelId);
        if (result.ok) set({ selfTesting, modelServices: result.value.view });
        else set({ selfTesting, message: describeError(result.error) });
      },
      async testConnection(modelId) {
        set({ connectionTests: { ...get().connectionTests, [modelId]: 'testing' } });
        const result = await service.testConnection(modelId);
        if (result.ok) set({ connectionTests: { ...get().connectionTests, [modelId]: result.value } });
        else {
          const { [modelId]: _dropped, ...rest } = get().connectionTests;
          set({ connectionTests: rest, message: describeError(result.error) });
        }
      },
      async setShowParagraphSource(show) {
        await run(service.setPreferences({ showParagraphSource: show }), (library) => ({ library }));
      },
      async saveFact(id, input) {
        if (id === null) {
          let created: string | null = null;
          const done = await run(service.createFact(input, 'candidate'), (r) => {
            created = r.created;
            return { facts: r.facts };
          });
          if (done) set({ selectedFactId: created });
          return done;
        }
        const fact = get().facts.find((x) => x.id === id);
        if (fact === undefined) return false;
        const done = await run(service.updateFact(fact, input), (facts) => ({ facts }));
        if (!done) await reloadFacts();
        return done;
      },
      async setFactStatus(id, status) {
        const fact = get().facts.find((x) => x.id === id);
        if (fact !== undefined && !(await run(service.setFactStatus(fact, status), (facts) => ({ facts })))) await reloadFacts();
      },
      async deleteFact(id) {
        const fact = get().facts.find((x) => x.id === id);
        if (fact === undefined) return false;
        return run(service.deleteFact(fact), (facts) => ({ facts, selectedFactId: null }));
      },
      async exportText(title, text) {
        const result = await service.exportPlainText(`${title}.txt`, text);
        if (!result.ok) set({ message: `导出失败：${result.error}` });
      },
    };
  });
}

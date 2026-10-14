// 界面状态（Zustand）。动作只调用应用服务层的用例，把结果放进状态；组件订阅状态、调用动作。
import type { Result } from '@fudiao/shared';
import type { Chapter, CurrentParagraph, Entity, EntityKind, EntityPatch, Fact, FactInput, FactStatus, LlmCallRow, ModelPatch, ProjectPatch, SavedParagraph, SearchHit, SearchResult, Snapshot, SnapshotSummary, SourceStats, StructuralEdits, UsageSummary, Candidate } from '@fudiao/store';
import type { SkillsView } from '../app/writing-skills';
import type { PlanDraft, PlanningView } from '../app/planning';
import type { ReviewIssueView } from '../app/review';
import type { SceneSpecInput } from '@fudiao/domain';
import type { ForeshadowFields, PlanFields, SimRun, SimScene, SimSceneFields } from '@fudiao/store';
import type { SimIntervention, SimRunDetail, SimRunOptions, SimVerification } from '../app/simulation';
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
/** 成书流程正在处理的章节：写作（已写 done / total 段）、整理长篇记忆或审核；queued 是排在后面的章节。 */
export type WriterJob = {
  readonly chapterId: string;
  readonly stage: 'writing' | 'memory' | 'review';
  readonly done: number;
  readonly total: number;
  readonly queued: readonly string[];
};

/** 还没有保存的场景配置草稿：由描述生成，或从空白开始。serial 每次换草稿加一，编辑表单据此重建。 */
export type SceneDraftState = { readonly serial: number; readonly title: string; readonly config: SceneSpecInput; readonly problems: readonly string[] };

/** 推演停下来等人的阶段：等待作者、已暂停、已结束。 */
const SIM_STOPPED: ReadonlySet<string> = new Set(['AwaitingAuthor', 'Paused', 'Ended']);

/** 审核抽屉的状态：note 是最近一次审核或修订的说明。 */
export type ReviewState = {
  readonly chapterId: string;
  readonly issues: readonly ReviewIssueView[];
  readonly running: boolean;
  readonly revisingId: string | null;
  readonly note: string | null;
};

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
  readonly panel: 'chapter' | 'info' | 'trash' | 'history' | 'backups' | 'settings' | 'facts' | 'sources' | 'search' | 'usage' | 'tasks' | 'skills' | 'planning' | 'simulation';
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
  /** 写作技能与规避词表（打开“写作技能”时读取，B61、B37）。 */
  readonly skills: SkillsView | null;
  /** 成书计划（B63、B65）：章节计划、伏笔账本，以及尚未采用的计划草稿与草稿中没对上的人物。 */
  readonly planning: PlanningView | null;
  readonly planDraft: PlanDraft | null;
  readonly planUnmatched: readonly string[];
  readonly planDrafting: boolean;
  /** 写手正在进行的工作（B59）：正在写的章节与段数进度、排在后面的章节；没有时为 null。 */
  readonly writerJob: WriterJob | null;
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

  readonly openPlanning: () => Promise<void>;
  readonly draftPlans: (chapterCount: number, wordsPerChapter: number) => Promise<void>;
  readonly applyPlanDraft: () => Promise<boolean>;
  readonly discardPlanDraft: () => void;
  readonly savePlan: (chapterId: string, fields: PlanFields) => Promise<boolean>;
  readonly addForeshadow: (fields: ForeshadowFields) => Promise<boolean>;
  readonly updateForeshadow: (id: string, fields: ForeshadowFields) => Promise<boolean>;
  readonly deleteForeshadow: (id: string) => Promise<boolean>;

  /** 让写手依次写这些章节；一章没有写完（取消、失败、被修改）就停下，后面的不再写。 */
  /** 依次写这些章节；每章写完后整理长篇记忆，review 为真时再审核。一章没有做完就停下。 */
  readonly writeChapters: (chapterIds: readonly string[], options?: { readonly review?: boolean }) => Promise<void>;
  /** 在计划页审核一章（不打开抽屉）；reviewingChapterId 是正在审核的章节。 */
  readonly reviewingChapterId: string | null;
  readonly reviewFromBoard: (chapterId: string) => Promise<void>;
  /** 打开一章并显示它的审核抽屉。 */
  readonly openChapterReview: (chapterId: string) => Promise<void>;
  readonly cancelWriting: () => void;
  readonly rollbackWriter: (chapterId: string) => Promise<boolean>;
  /** 角色推演（B22 起）：场景列表、选中的场景（'new' 为新建）与还没有保存的场景配置草稿（B39）。 */
  readonly simScenes: readonly SimScene[] | null;
  readonly simSceneId: string | null;
  readonly sceneDraft: SceneDraftState | null;
  readonly sceneDrafting: boolean;
  readonly openSimulation: () => Promise<void>;
  readonly selectSimScene: (id: string | null) => Promise<void>;
  /** 推演工作区（B28）：选中场景的“配置”或“推演”，这个场景的运行、选中的运行与它的时间线；simAdvancing 为正在推进。 */
  readonly simTab: 'config' | 'runs';
  readonly simRuns: readonly SimRun[];
  readonly simRunId: string | null;
  readonly simRun: SimRunDetail | null;
  readonly simAdvancing: boolean;
  readonly showSimTab: (tab: 'config' | 'runs') => void;
  readonly startSimRun: (options: SimRunOptions) => Promise<void>;
  readonly selectSimRun: (id: string) => Promise<void>;
  readonly stepSimRun: () => Promise<void>;
  readonly continueSimRun: () => Promise<void>;
  readonly pauseSimRun: () => Promise<void>;
  readonly stopSimRun: () => Promise<void>;
  /** 确认待核实的裁决（edited 为作者改过的内容）、决定导演提议、作者介入、从快照处分支（B26、B30）。返回是否成功。 */
  readonly confirmSimRuling: (requestId: string, edited?: string) => Promise<boolean>;
  readonly decideSimDirector: (accept: boolean) => Promise<boolean>;
  readonly interveneSimRun: (input: SimIntervention) => Promise<boolean>;
  readonly forkSimRun: (seq: number) => Promise<boolean>;
  /** 校验回放（B30）：只读事件重算各快照处的状态，与当时记下的哈希比较。结果属于选中的这次运行。 */
  readonly simVerification: (SimVerification & { readonly runId: string }) | null;
  readonly verifySimRun: () => Promise<void>;
  readonly draftSimScene: (description: string) => Promise<void>;
  readonly blankSimScene: (config: SceneSpecInput) => void;
  readonly discardSceneDraft: () => void;
  /** 保存场景；成功后选中它。返回是否成功。 */
  readonly saveSimScene: (id: string | null, fields: SimSceneFields) => Promise<boolean>;
  /** 审核（B64）：正文旁的审核抽屉。running 为正在审核，revisingId 为正交给写手修订的问题。 */
  readonly reviewDrawerOpen: boolean;
  readonly review: ReviewState | null;
  readonly openReview: () => Promise<void>;
  readonly closeReview: () => void;
  readonly runReview: () => Promise<void>;
  readonly cancelReview: () => void;
  /** 正文保存后重新读取待处理的问题（段落改过的问题已过期）。 */
  readonly refreshReview: () => Promise<void>;
  readonly resolveIssue: (id: string, status: 'ignored' | 'fixed') => Promise<void>;
  readonly reviseIssue: (id: string) => Promise<void>;
  /** 在正文中选中问题所在的文字。 */
  readonly revealIssue: (issue: ReviewIssueView) => void;
  /** 生成或重建一章的长篇记忆（B66）；memoryBuilding 是正在生成的章节。 */
  readonly memoryBuilding: string | null;
  readonly buildMemory: (chapterId: string) => Promise<boolean>;

  readonly openSkills: () => Promise<void>;
  readonly updateWritingSkill: (id: string, patch: { readonly enabled?: boolean; readonly instruction?: string; readonly name?: string }) => Promise<boolean>;
  readonly addCustomSkill: (name: string, instruction: string) => Promise<boolean>;
  readonly deleteCustomSkill: (id: string) => Promise<boolean>;
  readonly setAvoidPhrases: (phrases: readonly string[] | null) => Promise<boolean>;

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
    let writerAbort: AbortController | null = null;
    let sceneSerial = 0;
    let simAbort: AbortController | null = null;
    /** 正在进行的连续推进；暂停、停止与关闭作品时先等它停下。 */
    let simLoop: Promise<void> | null = null;

    /** 读出一次运行的状态与时间线；选中的运行已经换了时不覆盖。 */
    async function refreshRun(runId: string): Promise<void> {
      const detail = await service.simRunDetail(runId);
      if (get().simRunId !== runId) return;
      if (!detail.ok) {
        set({ message: describeError(detail.error) });
        return;
      }
      set({ simRun: detail.value, simRuns: get().simRuns.map((r) => (r.id === runId ? detail.value.view.run : r)) });
    }

    /** 作者对选中的运行做一次操作（确认裁决、决定导演提议、介入）：正在推进时不做；之后刷新时间线。 */
    async function authorAction(action: (runId: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: AppError }>): Promise<boolean> {
      const id = get().simRunId;
      if (id === null || get().simAdvancing) return false;
      const done = await action(id);
      set({ message: done.ok ? null : describeError(done.error) });
      await refreshRun(id);
      return done.ok;
    }

    /** 读出一个场景的运行；select 给出时选中它，否则选中最近的一次。 */
    async function loadRuns(sceneId: string, select: string | null): Promise<void> {
      const runs = await service.listSimRuns(sceneId);
      if (get().simSceneId !== sceneId) return;
      if (!runs.ok) {
        set({ message: describeError(runs.error) });
        return;
      }
      const runId = select ?? runs.value[0]?.id ?? null;
      set({ simRuns: runs.value, simRunId: runId, simRun: null, ...(select !== null && { simTab: 'runs' as const }) });
      if (runId !== null) await refreshRun(runId);
    }
    let reviewAbort: AbortController | null = null;
    const task = (event: TaskEvent) => set({ tasks: reduceTasks(get().tasks, event) });

    /** 审核一章，登记为任务。模型审核没有完成时结果中带原因（程序检查的问题已保存）。 */
    async function reviewTask(chapterId: string, abort: AbortController) {
      const taskId = `task-${++taskSeq}`;
      taskAborts.set(taskId, abort);
      const title = get().work?.chapters.find((c) => c.id === chapterId)?.title ?? '';
      task({ type: 'started', task: { id: taskId, kind: 'review', title: `审核 · ${title}`, chapterId, startedAt: new Date().toISOString() } });
      const result = await service.reviewChapter(chapterId, {
        signal: abort.signal,
        onEvent: (e) => (e.type === 'text' ? task({ type: 'text', id: taskId, delta: e.delta }) : task({ type: 'usage', id: taskId, usage: e.usage })),
      });
      taskAborts.delete(taskId);
      const finishedAt = new Date().toISOString();
      if (!result.ok) task({ type: 'finished', id: taskId, status: 'failed', finishedAt, error: describeError(result.error) });
      else if (result.value.modelReviewed) task({ type: 'finished', id: taskId, status: 'done', finishedAt });
      else task({ type: 'finished', id: taskId, status: abort.signal.aborted ? 'cancelled' : 'failed', finishedAt, error: result.value.reason });
      return result;
    }

    /** 生成一章的长篇记忆，登记为任务；失败时显示原因。返回是否成功。 */
    async function memoryTask(chapterId: string, abort: AbortController): Promise<boolean> {
      const taskId = `task-${++taskSeq}`;
      taskAborts.set(taskId, abort);
      const title = get().work?.chapters.find((c) => c.id === chapterId)?.title ?? '';
      task({ type: 'started', task: { id: taskId, kind: 'memory', title: `长篇记忆 · ${title}`, chapterId, startedAt: new Date().toISOString() } });
      set({ memoryBuilding: chapterId });
      const result = await service.buildMemory(chapterId, {
        signal: abort.signal,
        onEvent: (e) => (e.type === 'text' ? task({ type: 'text', id: taskId, delta: e.delta }) : task({ type: 'usage', id: taskId, usage: e.usage })),
      });
      taskAborts.delete(taskId);
      const finishedAt = new Date().toISOString();
      if (result.ok) task({ type: 'finished', id: taskId, status: 'done', finishedAt });
      else task({ type: 'finished', id: taskId, status: abort.signal.aborted ? 'cancelled' : 'failed', finishedAt, error: describeError(result.error) });
      const planning = get().planning === null ? null : await service.planningView();
      set({ memoryBuilding: null, ...(planning?.ok === true && { planning: planning.value }), ...(!result.ok && { message: describeError(result.error) }) });
      return result.ok;
    }

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
      skills: null,
      planning: null,
      planDraft: null,
      planUnmatched: [],
      planDrafting: false,
      writerJob: null,
      memoryBuilding: null,
      reviewDrawerOpen: false,
      review: null,
      reviewingChapterId: null,
      simScenes: null,
      simSceneId: null,
      sceneDraft: null,
      sceneDrafting: false,
      simTab: 'config',
      simRuns: [],
      simRunId: null,
      simRun: null,
      simAdvancing: false,
      simVerification: null,
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
        // 关闭作品时停下写手；已写入的段保留在作品里，下次打开可以接着写。
        writerAbort?.abort();
        // 推演同样停在当前这一步之后；事件都在作品库里，下次打开可以继续。
        simAbort?.abort();
        await simLoop;
        await service.closeWork();
        set({ writerJob: null, memoryBuilding: null, reviewDrawerOpen: false, review: null, reviewingChapterId: null, simScenes: null, simSceneId: null, sceneDraft: null, sceneDrafting: false, simTab: 'config', simRuns: [], simRunId: null, simRun: null, simAdvancing: false, simVerification: null, work: null, selectedChapterId: null, chapterContent: null, entities: [], selectedEntityId: null, drawerEntityId: null, facts: [], selectedFactId: null, sourceStats: null, skills: null, planning: null, planDraft: null, planUnmatched: [], usage: null, searchQuery: '', searchResult: null, reveal: null, contextDrawerOpen: false, writingContext: null, contextSelection: null, contextOverrides: {}, writeDrawerOpen: false, aiWrite: null, candidates: [] });
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
      openEntityDrawer: (id) => set(id === null ? { drawerEntityId: null } : { drawerEntityId: id, contextDrawerOpen: false, writeDrawerOpen: false, reviewDrawerOpen: false }),
      async openPlanning() {
        if (!(await get().leaveChapter())) return;
        await run(service.planningView(), (planning) => ({ planning, panel: 'planning', chapterContent: null, drawerEntityId: null }));
      },
      async draftPlans(chapterCount, wordsPerChapter) {
        const taskId = `task-${++taskSeq}`;
        const abort = new AbortController();
        taskAborts.set(taskId, abort);
        task({ type: 'started', task: { id: taskId, kind: 'plan_draft', title: '生成章节计划草稿', chapterId: null, startedAt: new Date().toISOString() } });
        set({ planDrafting: true, planUnmatched: [] });
        const result = await service.draftPlans({ chapterCount, wordsPerChapter }, { signal: abort.signal, onEvent: (e) => (e.type === 'text' ? task({ type: 'text', id: taskId, delta: e.delta }) : task({ type: 'usage', id: taskId, usage: e.usage })) });
        taskAborts.delete(taskId);
        if (result.ok) {
          set({ planDraft: result.value, planDrafting: false, message: null });
          task({ type: 'finished', id: taskId, status: 'done', finishedAt: new Date().toISOString() });
        } else {
          const status = abort.signal.aborted ? 'cancelled' : 'failed';
          set({ planDrafting: false, message: describeError(result.error) });
          task({ type: 'finished', id: taskId, status, finishedAt: new Date().toISOString(), error: describeError(result.error) });
        }
      },
      async applyPlanDraft() {
        const draft = get().planDraft;
        if (draft === null) return false;
        const done = await run(service.applyPlanDraft(draft), (r) => ({ planning: r.view, planDraft: null, planUnmatched: r.unmatchedCast }));
        if (done) {
          const work = await service.reloadWork();
          if (work.ok) set({ work: work.value });
        }
        return done;
      },
      discardPlanDraft: () => set({ planDraft: null }),
      async openSimulation() {
        if (!(await get().leaveChapter())) return;
        await run(service.listSimScenes(), (simScenes) => ({ simScenes, panel: 'simulation', chapterContent: null, drawerEntityId: null }));
      },
      async selectSimScene(id) {
        if (get().simAdvancing) return;
        set({ simSceneId: id, simTab: 'config', simRuns: [], simRunId: null, simRun: null });
        if (id !== null && id !== 'new') await loadRuns(id, null);
      },
      showSimTab: (simTab) => set({ simTab }),
      async startSimRun(options) {
        const sceneId = get().simSceneId;
        if (sceneId === null || sceneId === 'new' || get().simAdvancing) return;
        const started = await service.startSimRun(sceneId, options);
        if (!started.ok) {
          set({ message: describeError(started.error) });
          return;
        }
        set({ message: null });
        await loadRuns(sceneId, started.value.run.id);
      },
      async selectSimRun(id) {
        if (get().simAdvancing) return;
        set({ simRunId: id, simRun: null });
        await refreshRun(id);
      },
      async stepSimRun() {
        const id = get().simRunId;
        if (id === null || get().simAdvancing) return;
        set({ simAdvancing: true, message: null });
        const view = await service.stepSimRun(id);
        if (!view.ok) set({ message: describeError(view.error) });
        await refreshRun(id);
        set({ simAdvancing: false });
      },
      async continueSimRun() {
        const id = get().simRunId;
        if (id === null || get().simAdvancing) return;
        const abort = new AbortController();
        simAbort = abort;
        set({ simAdvancing: true, message: null });
        // 一步一步推进，每一步之后刷新时间线；停在等待作者、暂停、结束，或作者叫停。
        simLoop = (async () => {
          let view = await service.simRunStatus(id);
          if (view.ok && view.value.phase === 'Paused') view = await service.resumeSimRun(id);
          while (view.ok && !SIM_STOPPED.has(view.value.phase) && !abort.signal.aborted) {
            view = await service.stepSimRun(id, { signal: abort.signal });
            await refreshRun(id);
          }
          if (!view.ok) set({ message: describeError(view.error) });
          await refreshRun(id);
        })();
        await simLoop;
        simLoop = null;
        if (simAbort === abort) simAbort = null;
        set({ simAdvancing: false });
      },
      async pauseSimRun() {
        const id = get().simRunId;
        if (id === null) return;
        // 先让正在进行的推进停在当前这一步之后，再记下暂停：两边不会同时写这次运行。
        simAbort?.abort();
        await simLoop;
        const view = await service.pauseSimRun(id);
        if (!view.ok) set({ message: describeError(view.error) });
        await refreshRun(id);
      },
      confirmSimRuling: (requestId, edited) => authorAction((id) => service.confirmSimRuling(id, requestId, edited)),
      decideSimDirector: (accept) => authorAction((id) => service.decideSimDirector(id, accept)),
      interveneSimRun: (input) => authorAction((id) => service.interveneSimRun(id, input)),
      async forkSimRun(seq) {
        const id = get().simRunId;
        const sceneId = get().simSceneId;
        if (id === null || sceneId === null || get().simAdvancing) return false;
        const fork = await service.forkSimRun(id, seq);
        if (!fork.ok) {
          set({ message: describeError(fork.error) });
          return false;
        }
        set({ message: null });
        await loadRuns(sceneId, fork.value.run.id);
        return true;
      },
      async verifySimRun() {
        const id = get().simRunId;
        if (id === null || get().simAdvancing) return;
        const result = await service.verifySimRun(id);
        if (!result.ok) set({ message: describeError(result.error) });
        else if (get().simRunId === id) set({ simVerification: { ...result.value, runId: id }, message: null });
      },
      async stopSimRun() {
        const id = get().simRunId;
        if (id === null) return;
        simAbort?.abort();
        await simLoop;
        const view = await service.stopSimRun(id);
        if (!view.ok) set({ message: describeError(view.error) });
        await refreshRun(id);
      },
      async draftSimScene(description) {
        if (get().sceneDrafting) return;
        const taskId = `task-${++taskSeq}`;
        const abort = new AbortController();
        taskAborts.set(taskId, abort);
        task({ type: 'started', task: { id: taskId, kind: 'scene_draft', title: '生成场景配置草稿', chapterId: null, startedAt: new Date().toISOString() } });
        set({ sceneDrafting: true, message: null });
        const result = await service.draftSimScene(description, {
          signal: abort.signal,
          onEvent: (e) => (e.type === 'text' ? task({ type: 'text', id: taskId, delta: e.delta }) : task({ type: 'usage', id: taskId, usage: e.usage })),
        });
        taskAborts.delete(taskId);
        const finishedAt = new Date().toISOString();
        if (result.ok) {
          const title = result.value.config.meta?.title?.trim() ?? '';
          set({ sceneDrafting: false, sceneDraft: { serial: ++sceneSerial, title: title === '' ? '新场景' : title, config: result.value.config, problems: result.value.problems } });
          task({ type: 'finished', id: taskId, status: 'done', finishedAt });
        } else {
          set({ sceneDrafting: false, message: describeError(result.error) });
          task({ type: 'finished', id: taskId, status: abort.signal.aborted ? 'cancelled' : 'failed', finishedAt, error: describeError(result.error) });
        }
      },
      blankSimScene: (config) => set({ sceneDraft: { serial: ++sceneSerial, title: '新场景', config, problems: [] } }),
      discardSceneDraft: () => set({ sceneDraft: null }),
      async saveSimScene(id, fields) {
        const saved = await service.saveSimScene(id, fields);
        if (!saved.ok) {
          set({ message: describeError(saved.error) });
          return false;
        }
        const scenes = await service.listSimScenes();
        set({ simSceneId: saved.value.id, sceneDraft: id === null ? null : get().sceneDraft, message: null, ...(scenes.ok && { simScenes: scenes.value }) });
        return true;
      },
      async writeChapters(chapterIds, options = {}) {
        if (get().writerJob !== null || chapterIds.length === 0) return;
        // 先保存编辑器里的内容：写手不会覆盖未保存的修改。
        if (!(await get().leaveChapter())) return;
        const abort = new AbortController();
        writerAbort = abort;
        const refresh = async (chapterId: string) => {
          const planning = get().planning === null ? null : await service.planningView();
          if (planning?.ok === true) set({ planning: planning.value });
          if (get().selectedChapterId === chapterId) {
            const content = await service.openChapter(chapterId);
            if (content.ok) set({ chapterContent: content.value, contentRevision: get().contentRevision + 1, saveStatus: { kind: 'saved' } });
          }
        };
        for (const [i, chapterId] of chapterIds.entries()) {
          const taskId = `task-${++taskSeq}`;
          taskAborts.set(taskId, abort);
          const title = chapter(chapterId)?.title ?? '';
          task({ type: 'started', task: { id: taskId, kind: 'writer', title: `写手 · ${title}`, chapterId, startedAt: new Date().toISOString() } });
          const queued = chapterIds.slice(i + 1);
          set({ writerJob: { chapterId, stage: 'writing', done: 0, total: 0, queued }, message: null });
          const result = await service.writeChapter(chapterId, {
            signal: abort.signal,
            onEvent: (e) => (e.type === 'text' ? task({ type: 'text', id: taskId, delta: e.delta }) : task({ type: 'usage', id: taskId, usage: e.usage })),
            onSegment: (done, total) => {
              set({ writerJob: { chapterId, stage: 'writing', done, total, queued } });
              void refresh(chapterId);
            },
          });
          taskAborts.delete(taskId);
          await refresh(chapterId);
          const finishedAt = new Date().toISOString();
          if (!result.ok) {
            set({ message: describeError(result.error) });
            task({ type: 'finished', id: taskId, status: 'failed', finishedAt, error: describeError(result.error) });
            break;
          }
          const { status, reason, segmentsDone, segmentsTotal } = result.value;
          if (status === 'written') {
            task({ type: 'finished', id: taskId, status: 'done', finishedAt });
            const rest = queued.length > 0 ? `；后面的 ${queued.length} 章没有接着写` : '';
            // 写完一章就整理它的长篇记忆，后面的章节靠它接上前文；没整理成时不接着写。
            set({ writerJob: { chapterId, stage: 'memory', done: segmentsTotal, total: segmentsTotal, queued } });
            if (!(await memoryTask(chapterId, abort))) {
              set({ message: `“${title}”已写完，但长篇记忆没有生成：${get().message ?? ''}${rest}` });
              break;
            }
            if (options.review !== true) continue;
            // 审核提出的问题留给作者处理，不挡住后面的章节；模型审核没有完成时停下。
            set({ writerJob: { chapterId, stage: 'review', done: segmentsTotal, total: segmentsTotal, queued } });
            const reviewed = await reviewTask(chapterId, abort);
            await refresh(chapterId);
            if (reviewed.ok && reviewed.value.modelReviewed) continue;
            set({ message: `“${title}”已写完，但审核没有完成：${reviewed.ok ? (reviewed.value.reason ?? '') : describeError(reviewed.error)}${rest}` });
            break;
          }
          const note = status === 'cancelled' ? `已取消：“${title}”写了 ${segmentsDone} / ${segmentsTotal} 段，可以接着写` : (reason ?? `“${title}”没有写完`);
          set({ message: note });
          task({ type: 'finished', id: taskId, status: status === 'cancelled' ? 'cancelled' : 'failed', finishedAt, error: note });
          break;
        }
        if (writerAbort === abort) writerAbort = null;
        set({ writerJob: null });
      },
      cancelWriting: () => writerAbort?.abort(),
      async openReview() {
        const chapterId = get().selectedChapterId;
        if (chapterId === null) return;
        const handle = editor?.chapterId === chapterId ? editor : null;
        if (handle !== null && !(await handle.flush())) return;
        const issues = await service.reviewIssues(chapterId);
        if (!issues.ok) {
          set({ message: describeError(issues.error) });
          return;
        }
        // 换了章节才重置；同一章再次打开时保留正在进行的审核。
        const current = get().review;
        const review: ReviewState =
          current !== null && current.chapterId === chapterId ? { ...current, issues: issues.value } : { chapterId, issues: issues.value, running: false, revisingId: null, note: null };
        set({ reviewDrawerOpen: true, review, drawerEntityId: null, contextDrawerOpen: false, writeDrawerOpen: false });
      },
      closeReview: () => set({ reviewDrawerOpen: false }),
      cancelReview: () => reviewAbort?.abort(),
      async refreshReview() {
        const current = get().review;
        if (current === null || current.running || current.revisingId !== null) return;
        const issues = await service.reviewIssues(current.chapterId);
        const now = get().review;
        if (issues.ok && now !== null && now.chapterId === current.chapterId && !now.running && now.revisingId === null) set({ review: { ...now, issues: issues.value } });
      },
      async runReview() {
        const current = get().review;
        if (current === null || current.running || current.revisingId !== null) return;
        const chapterId = current.chapterId;
        const handle = editor?.chapterId === chapterId ? editor : null;
        if (handle !== null && !(await handle.flush())) return;
        const abort = new AbortController();
        reviewAbort = abort;
        set({ review: { ...current, running: true, note: null } });
        const result = await reviewTask(chapterId, abort);
        if (reviewAbort === abort) reviewAbort = null;
        const patch = (issues: readonly ReviewIssueView[], note: string | null) => {
          const now = get().review;
          if (now !== null && now.chapterId === chapterId) set({ review: { ...now, issues, running: false, note } });
        };
        if (!result.ok) {
          patch(current.issues, describeError(result.error));
          return;
        }
        const { issues, modelReviewed, reason, dropped } = result.value;
        const note = !modelReviewed
          ? `只做了程序检查，模型审核没有完成：${reason ?? ''}`
          : dropped > 0
            ? `模型提出的 ${dropped} 条问题定位不到原文或依据，没有列出`
            : issues.length === 0
              ? '审核完成，没有发现问题'
              : null;
        patch(issues, note);
        const planning = get().planning === null ? null : await service.planningView();
        if (planning?.ok === true) set({ planning: planning.value });
      },
      async reviewFromBoard(chapterId) {
        if (get().writerJob !== null || get().reviewingChapterId !== null || get().review?.running === true) return;
        if (!(await get().leaveChapter())) return;
        const abort = new AbortController();
        reviewAbort = abort;
        set({ reviewingChapterId: chapterId, message: null });
        const result = await reviewTask(chapterId, abort);
        if (reviewAbort === abort) reviewAbort = null;
        const planning = get().planning === null ? null : await service.planningView();
        const message = !result.ok ? describeError(result.error) : result.value.modelReviewed ? null : `只做了程序检查，模型审核没有完成：${result.value.reason ?? ''}`;
        set({ reviewingChapterId: null, ...(planning?.ok === true && { planning: planning.value }), ...(message !== null && { message }) });
      },
      async openChapterReview(chapterId) {
        await get().selectChapter(chapterId);
        if (get().selectedChapterId === chapterId) await get().openReview();
      },
      async resolveIssue(id, status) {
        const current = get().review;
        if (current === null) return;
        const issues = await service.resolveIssue(id, status);
        const now = get().review;
        if (!issues.ok) set({ message: describeError(issues.error) });
        else if (now !== null && now.chapterId === current.chapterId) set({ review: { ...now, issues: issues.value } });
      },
      async reviseIssue(id) {
        const current = get().review;
        if (current === null || current.running || current.revisingId !== null || get().writerJob !== null) return;
        const chapterId = current.chapterId;
        // 先保存；修订期间正文只读，写手写入后重新载入。
        if (!(await get().leaveChapter())) return;
        const abort = new AbortController();
        reviewAbort = abort;
        const taskId = `task-${++taskSeq}`;
        taskAborts.set(taskId, abort);
        task({ type: 'started', task: { id: taskId, kind: 'writer', title: `写手修订 · ${chapter(chapterId)?.title ?? ''}`, chapterId, startedAt: new Date().toISOString() } });
        set({ review: { ...current, revisingId: id, note: null }, message: null });
        const result = await service.reviseIssue(id, {
          signal: abort.signal,
          onEvent: (e) => (e.type === 'text' ? task({ type: 'text', id: taskId, delta: e.delta }) : task({ type: 'usage', id: taskId, usage: e.usage })),
        });
        taskAborts.delete(taskId);
        if (reviewAbort === abort) reviewAbort = null;
        const finishedAt = new Date().toISOString();
        const now = get().review;
        const same = now !== null && now.chapterId === chapterId;
        if (!result.ok) {
          task({ type: 'finished', id: taskId, status: abort.signal.aborted ? 'cancelled' : 'failed', finishedAt, error: describeError(result.error) });
          if (same) set({ review: { ...now, revisingId: null, note: describeError(result.error) } });
          return;
        }
        task({ type: 'finished', id: taskId, status: 'done', finishedAt });
        if (same) set({ review: { ...now, issues: result.value.issues, revisingId: null, note: '写手已修订这一段；写入前的正文在“版本快照”中' } });
        if (get().selectedChapterId === chapterId) {
          set({ chapterContent: { chapterId, saved: [...result.value.paragraphs], draft: null }, contentRevision: get().contentRevision + 1, saveStatus: { kind: 'saved' } });
        }
      },
      revealIssue: (issue) => set({ reveal: { chapterId: issue.chapterId, paragraphId: issue.anchor.paragraphId, start: issue.anchor.start, end: issue.anchor.end } }),
      async buildMemory(chapterId) {
        if (get().writerJob !== null || get().memoryBuilding !== null) return false;
        if (!(await get().leaveChapter())) return false;
        return memoryTask(chapterId, new AbortController());
      },
      async rollbackWriter(chapterId) {
        if (get().writerJob !== null || !(await get().leaveChapter())) return false;
        const done = await run(service.rollbackWriter(chapterId), () => ({}));
        if (!done) return false;
        const planning = await service.planningView();
        if (planning.ok) set({ planning: planning.value });
        if (get().selectedChapterId === chapterId) {
          const content = await service.openChapter(chapterId);
          if (content.ok) set({ chapterContent: content.value, contentRevision: get().contentRevision + 1, saveStatus: { kind: 'saved' } });
        }
        return true;
      },
      savePlan: (chapterId, fields) => run(service.savePlan(chapterId, fields), (planning) => ({ planning })),
      addForeshadow: (fields) => run(service.addForeshadow(fields), (planning) => ({ planning })),
      async updateForeshadow(id, fields) {
        const f = get().planning?.foreshadows.find((x) => x.id === id);
        return f === undefined ? false : run(service.updateForeshadow(f, fields), (planning) => ({ planning }));
      },
      async deleteForeshadow(id) {
        const f = get().planning?.foreshadows.find((x) => x.id === id);
        return f === undefined ? false : run(service.deleteForeshadow(f), (planning) => ({ planning }));
      },
      async openSkills() {
        if (!(await get().leaveChapter())) return;
        await run(service.listWritingSkills(), (skills) => ({ skills, panel: 'skills', chapterContent: null, drawerEntityId: null }));
      },
      async updateWritingSkill(id, patch) {
        const skill = get().skills?.skills.find((s) => s.skill.id === id)?.skill;
        return skill === undefined ? false : run(service.updateWritingSkill(skill, patch), (skills) => ({ skills }));
      },
      addCustomSkill: (name, instruction) => run(service.addCustomSkill(name, instruction), (skills) => ({ skills })),
      async deleteCustomSkill(id) {
        const skill = get().skills?.skills.find((s) => s.skill.id === id)?.skill;
        return skill === undefined ? false : run(service.deleteCustomSkill(skill), (skills) => ({ skills }));
      },
      setAvoidPhrases: (phrases) => run(service.setAvoidPhrases(phrases), (skills) => ({ skills })),
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
          reviewDrawerOpen: false,
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
        set({ writeDrawerOpen: true, writeSelection: selection, writeSelectedText: selectedText, contextSelection: selection, drawerEntityId: null, contextDrawerOpen: false, reviewDrawerOpen: false });
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

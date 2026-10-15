// 界面状态（Zustand）。动作只调用应用服务层的用例，把结果放进状态；组件订阅状态、调用动作。
import type { Result, SkillStage } from '@fudiao/shared';
import type { CallOptions } from '@fudiao/llm';
import type { Chapter, ChapterTarget, CurrentParagraph, Entity, EntityKind, EntityPatch, Fact, FactInput, FactStatus, LlmCallRow, ModelPatch, ProjectPatch, SavedParagraph, SearchHit, SearchResult, Snapshot, SnapshotSummary, SourceStats, StructuralEdits, UsageSummary, Candidate } from '@fudiao/store';
import type { SkillsView } from '../app/writing-skills';
import type { PlanDraft, PlanningView } from '../app/planning';
import type { ReviewIssueView } from '../app/review';
import type { SceneSpecInput } from '@fudiao/domain';
import type { ForeshadowFields, PlanFields, RelationshipFields, SimRun, SimScene, SimSceneFields } from '@fudiao/store';
import type { SimIntervention, SimRunDetail, SimRunOptions, SimVerification } from '../app/simulation';
import type { AdoptionDraft, AdoptionRequest, BeatSheetRequest, BeatSheetView } from '../app/narration';
import type { AssistantEffect, AssistantEvents, AssistantItem, AssistantOutcome, AssistantSelection } from '../app/assistant';
import type { BookSeed, BookSeedRequest, QuickBookStatus } from '../app/quick-book';
import type { SimEvaluationInput, SimEvaluationView } from '../app/sim-evaluation';
import type { Beat, Cover } from '@fudiao/store';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SaveStatus } from '../app/autosave';
import type { Layout, Preferences, Theme } from '../app/library';
import type { RelationsView } from '../app/relations';
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
import { reduceTasks, type TaskEvent, type TaskRecord, type TaskStatus } from '../app/tasks';

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

/** 任务中心里进行中的一项：交给用例的调用选项（text 为 false 时只记用量；onText 另外处理同一份流式文字）与结束。 */
type TaskHandle = {
  readonly signal: AbortSignal;
  readonly options: (choices?: { readonly text?: boolean; readonly onText?: (delta: string) => void }) => CallOptions;
  readonly finish: (status: Exclude<TaskStatus, 'running'>, details?: { readonly text?: string; readonly cost?: number | null; readonly error?: string | null }) => void;
  /** 没有完成：作者取消时记为已取消，否则为失败。 */
  readonly fail: (error: string) => void;
};

/** 正文旁的抽屉（共用一个位置，打开一个就换掉另一个）。 */
export type ChapterDrawer = { readonly kind: 'entity'; readonly entityId: string } | { readonly kind: 'context' } | { readonly kind: 'write' } | { readonly kind: 'review' };

/** 正文里选中的文字：key 标识这一次选区（章节与位置），length 是字数，preview 是开头的一小段。 */
export type EditorSelectionInfo = { readonly key: string; readonly chapterId: string; readonly length: number; readonly preview: string };

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
  /** 作品封面（B76）：undefined 为还没读取，null 为没有封面（显示按书名排出的文字封面）。 */
  readonly cover: Cover | null | undefined;
  readonly selectedChapterId: string | null;
  readonly panel: 'chapter' | 'info' | 'trash' | 'history' | 'backups' | 'settings' | 'facts' | 'relations' | 'sources' | 'search' | 'usage' | 'tasks' | 'skills' | 'planning' | 'simulation' | 'book';
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
  /** 正文旁的抽屉，同一时间只开一个：设定卡片（Ctrl + 点击高亮的名字）、AI 上下文、AI 写作或审核。 */
  readonly drawer: ChapterDrawer | null;
  /** 当前作品的事实（打开作品与设定变化后重新读取，其中的待复核标记是最新的）。 */
  readonly facts: readonly Fact[];
  /** 人物关系网（B73）：关系、可以作为一端的设定与作者拖定的位置（打开关系页时读取）。 */
  readonly relations: RelationsView | null;
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
  /** 快速成书（B67）：各步状态（打开成书页时读取）、正在编辑的作品骨架与是否正在生成。 */
  readonly quickBook: QuickBookStatus | null;
  /** AI 助手（B69）：右侧对话框是否打开、当前作品（或作品列表页）的对话、是否正在处理。 */
  readonly assistantOpen: boolean;
  readonly assistantItems: readonly AssistantItem[];
  readonly assistantRunning: boolean;
  /** 对话属于哪部作品（作品标识；作品列表页为空字符串），切换作品时据此重新读取。 */
  readonly assistantFor: string | null;
  /** 模型正在输出的这一步里给作者的话（逐字显示）；没有时为 null。 */
  readonly assistantDraft: string | null;
  /** 助手正在执行的耗时动作的进展（写手写到第几段、正在审核等）。 */
  readonly assistantProgress: string | null;
  /** 正文里当前选中的文字（助手对话框上方显示，发话时一并交给助手）；没有选中时为 null。 */
  readonly editorSelection: EditorSelectionInfo | null;
  /** 作者在对话框里点了“不带上”的那次选区（key）；选区变了就失效。 */
  readonly selectionDismissed: string | null;
  readonly bookSeed: BookSeed | null;
  readonly seedDrafting: boolean;
  readonly planUnmatched: readonly string[];
  readonly planDrafting: boolean;
  /** 写手正在进行的工作（B59）：正在写的章节与段数进度、排在后面的章节；没有时为 null。 */
  readonly writerJob: WriterJob | null;
  /** AI 上下文清单（B18）：最近一次的清单、计算时的选区，以及作者的增减（按章节，本次打开作品期间有效）。 */
  readonly writingContext: ContextManifest | null;
  readonly contextSelection: EditorSelection | null;
  readonly contextOverrides: Readonly<Record<string, ContextOverrides>>;
  /** AI 写作抽屉：打开时记下的选区与选中的文字，以及最近一次选区操作。 */
  readonly writeSelection: EditorSelection | null;
  readonly writeSelectedText: string;
  readonly aiWrite: AiWriteJob | null;
  /** 任务中心（B16、B19）：本次运行中的模型任务，新的在前。 */
  readonly tasks: readonly TaskRecord[];
  /** 当前章节待处理的候选稿（B17），新的在前。 */
  readonly candidates: readonly Candidate[];
  /** 正在采纳的推演候选稿（B29、B55）：可以带进作品的事件、见闻与须复核的裁决。 */
  readonly adoption: AdoptionDraft | null;
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
  /** 打开作品并进入作品信息，在那里更换封面（作品列表卡片上的“更换封面”）。 */
  readonly openWorkCover: (id: string) => Promise<void>;
  readonly addWorkFromFolder: () => Promise<void>;
  readonly closeWork: () => Promise<void>;
  readonly setArchived: (id: string, archived: boolean) => Promise<void>;
  readonly removeMissingWork: (id: string) => Promise<void>;
  readonly chooseLibraryDir: () => Promise<void>;
  readonly updateWorkInfo: (patch: ProjectPatch) => Promise<boolean>;
  readonly createChapter: (title: string) => Promise<boolean>;
  /** 在某一卷（null 为未分卷）末尾新建章节。 */
  readonly createChapterIn: (volumeId: string | null, title: string) => Promise<boolean>;
  /** 分卷（B68）：新建、改名与简介、调整顺序、删除（卷里还有章节时不删）。 */
  readonly createVolume: (title: string) => Promise<boolean>;
  readonly updateVolume: (id: string, fields: { readonly title: string; readonly summary: string }) => Promise<boolean>;
  readonly moveVolumeUp: (id: string) => Promise<void>;
  readonly moveVolumeDown: (id: string) => Promise<void>;
  readonly deleteVolume: (id: string) => Promise<void>;
  /** 把章节拖到某一卷的标题上：移到这一卷的卷首。 */
  readonly dropChapterOnVolume: (id: string, volumeId: string | null) => Promise<void>;
  readonly renameChapter: (id: string, title: string) => Promise<boolean>;
  readonly updateChapterNotes: (id: string, notes: { summary: string; notes: string }) => Promise<boolean>;
  /** 把章节移到 after 之后；after 为 null 时移到最前。 */
  /** 把章节移到某一卷（null 为未分卷）里某章之后（null 为卷首）。 */
  readonly moveChapter: (id: string, target: ChapterTarget) => Promise<void>;
  readonly moveUp: (id: string) => Promise<void>;
  readonly moveDown: (id: string) => Promise<void>;
  /** 拖到某一章上：放到该章所在的位置。 */
  readonly dropChapter: (id: string, targetId: string) => Promise<void>;
  readonly trashChapter: (id: string) => Promise<void>;
  readonly restoreChapter: (id: string) => Promise<void>;
  readonly selectChapter: (id: string) => Promise<void>;
  readonly showPanel: (panel: AppState['panel']) => Promise<void>;
  /** 作品封面（B76）：读取、用作者选的图片设定或更换、去掉。 */
  readonly loadCover: () => Promise<void>;
  readonly setCover: (image: Blob) => Promise<boolean>;
  readonly removeCover: () => Promise<void>;
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
  /** 保存正文后打开成书页，并读取各步状态与计划。 */
  readonly openQuickBook: () => Promise<void>;
  readonly toggleAssistant: () => void;
  /** 读取当前作品（或作品列表页）的对话。 */
  readonly loadAssistant: () => Promise<void>;
  /** 对助手说一句话；助手工作期间正文只读，结束后重新载入。 */
  readonly sendAssistant: (text: string) => Promise<boolean>;
  /** 确认或拒绝助手等待确认的动作。 */
  readonly resolveAssistant: (approve: boolean) => Promise<void>;
  readonly stopAssistant: () => void;
  readonly clearAssistant: () => Promise<void>;
  /** 正文编辑器报告选区的变化。 */
  readonly setEditorSelection: (info: EditorSelectionInfo | null) => void;
  /** 这次的选区不交给助手。 */
  readonly dismissSelection: () => void;
  readonly refreshQuickBook: () => Promise<void>;
  readonly draftBookSeed: (request: BookSeedRequest) => Promise<void>;
  readonly editBookSeed: (seed: BookSeed) => void;
  readonly discardBookSeed: () => void;
  /** 采用骨架：写入作品信息与人物；成功后读取作品、设定与计划。 */
  readonly applyBookSeed: () => Promise<boolean>;
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
  /** 推演写成正文（B29、B45）：选中运行的节拍表；narrationNote 是最近一次写成的候选稿所在的章节。 */
  readonly beatSheets: readonly BeatSheetView[];
  readonly narrationBusy: boolean;
  readonly narrationNote: { readonly chapterId: string; readonly text: string } | null;
  /** 生成节拍表，返回新节拍表的标识（失败时为 null）。 */
  readonly draftBeatSheet: (request: BeatSheetRequest) => Promise<string | null>;
  readonly saveBeatSheet: (id: string, fields: { readonly beats: readonly Beat[]; readonly style: string }) => Promise<boolean>;
  readonly narrateBeatSheet: (id: string, chapterId: string) => Promise<void>;
  /** 打开写成候选稿的那一章，并打开“AI 写作”看候选稿。 */
  readonly openNarratedChapter: (chapterId: string) => Promise<void>;
  /** 推演评价（B46）：选中运行（属于批量推演时是整组）的评价，打开评价时读取。 */
  readonly simEvaluation: (SimEvaluationView & { readonly runId: string }) | null;
  readonly loadSimEvaluation: () => Promise<void>;
  readonly saveSimEvaluation: (input: SimEvaluationInput) => Promise<boolean>;
  readonly draftSimScene: (description: string) => Promise<void>;
  readonly blankSimScene: (config: SceneSpecInput) => void;
  readonly discardSceneDraft: () => void;
  /** 保存场景；成功后选中它。返回是否成功。 */
  readonly saveSimScene: (id: string | null, fields: SimSceneFields) => Promise<boolean>;
  /** 审核（B64）：running 为正在审核，revisingId 为正交给写手修订的问题。 */
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
  readonly updateWritingSkill: (
    id: string,
    patch: { readonly enabled?: boolean; readonly instruction?: string; readonly name?: string; readonly description?: string; readonly stages?: readonly SkillStage[] },
  ) => Promise<boolean>;
  readonly addCustomSkill: (name: string, instruction: string, description?: string, key?: string, stages?: readonly SkillStage[]) => Promise<boolean>;
  /** 选一个 SKILL.md 文件导入为技能（同一标识的自定义技能更新，内置技能成为改写）。 */
  readonly importSkillMd: () => Promise<void>;
  /** 导入粘贴进来的 SKILL.md 内容；返回是否导入成功。 */
  readonly importSkillText: (text: string) => Promise<boolean>;
  /** 把一项技能另存为 SKILL.md。 */
  readonly exportSkillMd: (id: string) => Promise<void>;
  readonly deleteCustomSkill: (id: string) => Promise<boolean>;
  readonly setAvoidPhrases: (phrases: readonly string[] | null) => Promise<boolean>;

  readonly openFacts: (factId?: string) => Promise<void>;
  /** 保存正文后打开人物关系页。 */
  readonly openRelations: () => Promise<void>;
  /** 新建（id 为 null）或修改一条关系。返回是否成功。 */
  readonly saveRelationship: (id: string | null, fields: RelationshipFields) => Promise<boolean>;
  readonly deleteRelationship: (id: string) => Promise<boolean>;
  /** 记下（at 为 null 时取消）一项设定在关系图上的位置。 */
  readonly placeRelationNode: (entityId: string, at: { readonly x: number; readonly y: number } | null) => Promise<void>;
  readonly resetRelationLayout: () => Promise<void>;
  readonly selectFact: (id: string | null) => void;
  readonly saveFact: (id: string | null, input: FactInput) => Promise<boolean>;
  readonly setFactStatus: (id: string, status: FactStatus) => Promise<void>;
  readonly deleteFact: (id: string) => Promise<boolean>;

  /** 保存正文后打开段落来源统计。 */
  readonly openSourceStats: () => Promise<void>;
  readonly setShowParagraphSource: (show: boolean) => Promise<void>;
  /** 外观：跟随系统、浅色或深色（对所有作品生效）。 */
  readonly setTheme: (theme: Theme) => Promise<void>;
  /** 调整左栏、助手的宽度或收起左栏（对所有作品生效）。 */
  readonly setLayout: (patch: Partial<Layout>) => Promise<void>;

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
  /** 推演写成的候选稿：读取采纳要选的事件、见闻与须复核的裁决。 */
  readonly openAdoption: (candidateId: string) => Promise<void>;
  readonly closeAdoption: () => void;
  /** 保存正文后采纳，写入后重新载入本章与事实。 */
  readonly adoptCandidate: (request: AdoptionRequest) => Promise<void>;
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
  /** 采用内置表中这个模型的能力与价格。 */
  readonly applyBuiltinModel: (modelId: string) => Promise<void>;
};

export type AppStore = StoreApi<AppState>;

/**
 * 这一章为什么只读：写手在写（writer）、写手在修订一段（revise）、AI 助手在操作作品（assistant）；可以编辑时为 null。
 * 正文只读的规则只在这里判断，界面据此显示说明与只读的正文。
 */
export type ChapterLock = 'writer' | 'revise' | 'assistant';
export function chapterLock(state: AppState, chapterId: string | null): ChapterLock | null {
  if (chapterId === null) return null;
  if (state.writerJob?.chapterId === chapterId) return 'writer';
  if (state.review !== null && state.review.revisingId !== null && state.review.chapterId === chapterId) return 'revise';
  if (state.assistantRunning) return 'assistant';
  return null;
}

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

    /**
     * 任务中心（设计模式第六章）：登记一项耗时任务，交给用例取消信号与流式回调（文字与用量记入任务），结束时写明结果。
     * 任务只结束一次；时间取自应用的时钟。
     */
    function startTask(kind: TaskRecord['kind'], title: string, chapterId: string | null, abort = new AbortController()): TaskHandle {
      const id = `task-${++taskSeq}`;
      taskAborts.set(id, abort);
      task({ type: 'started', task: { id, kind, title, chapterId, startedAt: service.now() } });
      const finish: TaskHandle['finish'] = (status, details = {}) => {
        if (!taskAborts.delete(id)) return;
        task({ type: 'finished', id, status, finishedAt: service.now(), ...details });
      };
      return {
        signal: abort.signal,
        options: ({ text = true, onText } = {}) => ({
          signal: abort.signal,
          onEvent: (e) => {
            if (e.type === 'usage') task({ type: 'usage', id, usage: e.usage });
            else {
              if (text) task({ type: 'text', id, delta: e.delta });
              onText?.(e.delta);
            }
          },
        }),
        finish,
        fail: (error) => finish(abort.signal.aborted ? 'cancelled' : 'failed', { error }),
      };
    }

    /** 一次模型任务登记在任务中心：开始、流式文字、用量与结束；失败时显示原因。 */
    async function modelTask<T>(
      kind: TaskRecord['kind'],
      title: string,
      chapterId: string | null,
      call: (options: CallOptions) => Promise<Result<T, AppError>>,
    ): Promise<Result<T, AppError>> {
      const t = startTask(kind, title, chapterId);
      const result = await call(t.options());
      if (result.ok) t.finish('done');
      else {
        t.fail(describeError(result.error));
        set({ message: describeError(result.error) });
      }
      return result;
    }

    async function loadBeatSheets(runId: string): Promise<void> {
      const sheets = await service.listBeatSheets(runId);
      if (get().simRunId !== runId) return;
      if (!sheets.ok) set({ message: describeError(sheets.error) });
      else set({ beatSheets: sheets.value });
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
      set({ simRuns: runs.value, simRunId: runId, simRun: null, beatSheets: [], narrationNote: null, simEvaluation: null, ...(select !== null && { simTab: 'runs' as const }) });
      if (runId !== null) {
        await refreshRun(runId);
        await loadBeatSheets(runId);
      }
    }
    let reviewAbort: AbortController | null = null;
    const task = (event: TaskEvent) => set({ tasks: reduceTasks(get().tasks, event) });

    /** 审核一章，登记为任务。模型审核没有完成时结果中带原因（程序检查的问题已保存）。 */
    async function reviewTask(chapterId: string, abort: AbortController) {
      const title = get().work?.chapters.find((c) => c.id === chapterId)?.title ?? '';
      const t = startTask('review', `审核 · ${title}`, chapterId, abort);
      const result = await service.reviewChapter(chapterId, t.options());
      if (!result.ok) t.fail(describeError(result.error));
      else if (result.value.modelReviewed) t.finish('done');
      else t.fail(result.value.reason ?? '模型审核没有完成');
      return result;
    }

    /** 生成一章的长篇记忆，登记为任务；失败时显示原因。返回是否成功。 */
    async function memoryTask(chapterId: string, abort: AbortController): Promise<boolean> {
      const title = get().work?.chapters.find((c) => c.id === chapterId)?.title ?? '';
      const t = startTask('memory', `长篇记忆 · ${title}`, chapterId, abort);
      set({ memoryBuilding: chapterId });
      const result = await service.buildMemory(chapterId, t.options());
      if (result.ok) t.finish('done');
      else t.fail(describeError(result.error));
      const planning = get().planning === null ? null : await service.planningView();
      set({ memoryBuilding: null, ...(planning?.ok === true && { planning: planning.value }), ...(!result.ok && { message: describeError(result.error) }) });
      return result.ok;
    }

    /** 执行一个用例：失败时显示说明；内容在别处被修改时重新读取作品。返回是否成功。 */
    /** 收起某一种抽屉；开着的是别的抽屉时不动。 */
    const closeDrawer = (kind: ChapterDrawer['kind']): Partial<AppState> => (get().drawer?.kind === kind ? { drawer: null } : {});

    /** 外观与布局：界面先变，再在后台写入作品列表文件（不进入忙碌状态，界面不闪）；写入失败时说明。 */
    async function savePreferences(patch: Partial<Preferences>) {
      const library = get().library;
      if (library === null) return;
      set({ library: { ...library, preferences: { ...library.preferences, ...patch } } });
      const saved = await service.setPreferences(patch);
      if (!saved.ok) set({ message: `偏好没有保存：${describeError(saved.error)}` });
    }

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

    // —— AI 助手（B69）——
    let assistantAbort: AbortController | null = null;
    const PAGE_LABEL: Readonly<Record<string, string>> = {
      book: '成书页',
      planning: '计划页',
      settings: '设定页',
      facts: '事实页',
      relations: '人物关系页',
      simulation: '推演页',
      search: '查找页',
      skills: '写作技能页',
      usage: '用量与费用页',
      tasks: '任务页',
      info: '作品信息',
      trash: '回收站',
      history: '版本快照',
    };
    /** 作者此刻在看什么，写进给助手的现状。 */
    const currentView = (): string => {
      const state = get();
      if (state.work === null) return '作品列表';
      if (state.panel === 'chapter') {
        const chapter = state.work.chapters.find((c) => c.id === state.selectedChapterId);
        return chapter === undefined ? '' : `《${chapter.title}》的正文 [${chapter.id}]`;
      }
      return PAGE_LABEL[state.panel] ?? '';
    };
    /** 作品内容变了：重新读取目录、设定、事实与计划。 */
    async function refreshWork() {
      const work = await service.reloadWork();
      if (!work.ok) return;
      set({ work: work.value });
      await loadEntities();
      await reloadFacts();
      if (get().panel === 'planning' || get().panel === 'book') {
        const planning = await service.planningView();
        if (planning.ok) set({ planning: planning.value });
      }
      if (get().panel === 'relations') {
        const relations = await service.relationsView();
        if (relations.ok) set({ relations: relations.value });
      }
    }
    /** 打开一章（不在这一章时重新载入正文）。助手工作期间正文只读，不需要先保存。 */
    const showChapter = (chapterId: string): Partial<AppState> =>
      get().selectedChapterId === chapterId && get().panel === 'chapter'
        ? {}
        : { selectedChapterId: chapterId, panel: 'chapter', chapterContent: null, drawer: null, snapshots: null, previewSnapshot: null };
    async function applyEffect(effect: AssistantEffect) {
      switch (effect.kind) {
        case 'open_chapter':
          set(showChapter(effect.chapterId));
          return;
        case 'chapter_changed':
          if (get().selectedChapterId === effect.chapterId && get().panel === 'chapter') set({ chapterContent: null, contentRevision: get().contentRevision + 1 });
          return;
        case 'show_candidates': {
          // 候选稿放在章节旁的“AI 写作”里：打开它，作者对照差异后接受或放弃。
          set({ ...showChapter(effect.chapterId), drawer: { kind: 'write' }, writeSelection: null, writeSelectedText: '' });
          await run(service.listCandidates(effect.chapterId), (candidates) => ({ candidates }));
          return;
        }
        case 'show_review': {
          set(showChapter(effect.chapterId));
          const issues = await service.reviewIssues(effect.chapterId);
          if (!issues.ok) return;
          set({ drawer: { kind: 'review' }, review: { chapterId: effect.chapterId, issues: issues.value, running: false, revisingId: null, note: null } });
          return;
        }
        case 'open_page': {
          const page = effect.page;
          const actions = {
            book: get().openQuickBook,
            planning: get().openPlanning,
            settings: get().openSettings,
            facts: get().openFacts,
            relations: get().openRelations,
            simulation: get().openSimulation,
            search: get().openSearch,
            skills: get().openSkills,
            usage: get().openUsage,
            tasks: get().openTasks,
          } as const;
          await actions[page]();
          return;
        }
        case 'work_opened': {
          const work = await service.reloadWork();
          if (!work.ok) return;
          set({ ...opened(work.value), entities: [], facts: [], planning: null, candidates: [], assistantFor: work.value.project.id });
          await loadEntities();
          await reloadFacts();
          const library = await service.loadLibrary();
          if (library.ok) set({ library: library.value });
          return;
        }
        case 'changed':
          await refreshWork();
          return;
      }
    }
    /** 助手的一轮：逐步显示进展，界面跟着助手打开章节与页面；结束后重新载入正文。 */
    /** 作者选中、且没有点“不带上”的文字（发话前先取，保存正文不会改变选区）。 */
    const chosenSelection = (): AssistantSelection | null => {
      const state = get();
      const info = state.editorSelection;
      if (info === null || info.key === state.selectionDismissed || state.panel !== 'chapter' || editor === null || editor.chapterId !== info.chapterId) return null;
      const range = editor.selection();
      const text = editor.selectedText();
      return range === null || text.trim() === '' ? null : { chapterId: info.chapterId, range, text };
    };
    async function assistantTurn(
      title: string,
      selection: AssistantSelection | null,
      start: (events: AssistantEvents) => Promise<Result<AssistantOutcome, AppError>>,
    ): Promise<boolean> {
      const abort = new AbortController();
      assistantAbort = abort;
      set({ assistantRunning: true, assistantDraft: null, assistantProgress: null, message: null });
      // 这一轮登记在任务中心：可以在任务页看到与取消。模型的输出是结构化的动作，只记用量，给作者的话在对话里。
      const t = startTask('assistant', `AI 助手 · ${title}`, null, abort);
      // 效果按到达的顺序依次执行（打开章节之后才打开它旁边的候选稿）。
      let effects: Promise<void> = Promise.resolve();
      const result = await start({
        ...t.options({ text: false }),
        current: currentView,
        selection,
        onUpdate: (items) => set({ assistantItems: items }),
        onDraft: (draft) => set({ assistantDraft: draft }),
        onProgress: (note) => set({ assistantProgress: note }),
        onEffect: (effect) => {
          effects = effects.then(() => applyEffect(effect));
        },
      });
      await effects;
      if (assistantAbort === abort) assistantAbort = null;
      if (!result.ok) t.fail(describeError(result.error));
      else if (abort.signal.aborted) t.finish('cancelled');
      else {
        const said = result.value.items.flatMap((i) => (i.role === 'assistant' && i.output.message.trim() !== '' ? [i.output.message] : [])).at(-1);
        t.finish('done', { text: result.value.pending ? '等待作者确认' : (said ?? '') });
      }
      set({
        assistantRunning: false,
        assistantDraft: null,
        assistantProgress: null,
        ...(result.ok && { assistantItems: result.value.items }),
        ...(!result.ok && !abort.signal.aborted && { message: describeError(result.error) }),
      });
      // 正文可能被写手、续写或章节操作改过：重新载入正在看的这一章。
      if (get().panel === 'chapter' && get().selectedChapterId !== null) set({ chapterContent: null, contentRevision: get().contentRevision + 1 });
      return result.ok;
    }

    async function autoBackup() {
      const result = await service.autoBackupIfDue();
      if (!result.ok) set({ message: `自动备份失败：${describeError(result.error)}` });
    }

    const opened = (work: WorkView): Partial<AppState> => ({
      work,
      cover: undefined,
      selectedChapterId: work.chapters[0]?.id ?? null,
      // 还没有章节的作品从成书页开始（B67）；已有章节的作品打开第一章。
      panel: work.chapters.length === 0 ? 'book' : 'chapter',
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
      relations: null,
      drawer: null,
      facts: [],
      selectedFactId: null,
      sourceStats: null,
      skills: null,
      cover: undefined,
      planning: null,
      quickBook: null,
      assistantOpen: true,
      assistantItems: [],
      assistantRunning: false,
      assistantFor: null,
      assistantDraft: null,
      assistantProgress: null,
      editorSelection: null,
      selectionDismissed: null,
      bookSeed: null,
      seedDrafting: false,
      planDraft: null,
      planUnmatched: [],
      planDrafting: false,
      writerJob: null,
      memoryBuilding: null,
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
      beatSheets: [],
      simEvaluation: null,
      narrationBusy: false,
      narrationNote: null,
      usage: null,
      writingContext: null,
      contextSelection: null,
      contextOverrides: {},
      writeSelection: null,
      writeSelectedText: '',
      aiWrite: null,
      candidates: [],
      adoption: null,
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
      async openWorkCover(id) {
        await get().openWork(id);
        if (get().work?.entry.id === id) await get().showPanel('info');
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
        set({ writerJob: null, memoryBuilding: null, review: null, reviewingChapterId: null, simScenes: null, simSceneId: null, sceneDraft: null, sceneDrafting: false, simTab: 'config', simRuns: [], simRunId: null, simRun: null, simAdvancing: false, simVerification: null, beatSheets: [], narrationBusy: false, narrationNote: null, simEvaluation: null, work: null, cover: undefined, selectedChapterId: null, chapterContent: null, entities: [], selectedEntityId: null, drawer: null, facts: [], relations: null, selectedFactId: null, sourceStats: null, skills: null, planning: null, quickBook: null, bookSeed: null, seedDrafting: false, planDraft: null, planUnmatched: [], usage: null, searchQuery: '', searchResult: null, reveal: null, writingContext: null, contextSelection: null, contextOverrides: {}, aiWrite: null, candidates: [], adoption: null });
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
      async moveChapter(id, target) {
        await withChapter(id, (c) => service.moveChapter(c, target));
      },
      // 目录按书中的顺序排列（未分卷、各卷依次）；上移、下移越过卷的边界时移到相邻的卷里。
      async moveUp(id) {
        const list = get().work?.chapters ?? [];
        const i = list.findIndex((c) => c.id === id);
        const self = list[i];
        const prev = list[i - 1];
        if (self === undefined || prev === undefined) return;
        if (prev.volumeId !== self.volumeId) {
          await get().moveChapter(id, { volumeId: prev.volumeId, after: prev.id });
          return;
        }
        const before = list[i - 2];
        await get().moveChapter(id, { volumeId: self.volumeId, after: before !== undefined && before.volumeId === self.volumeId ? before.id : null });
      },
      async moveDown(id) {
        const list = get().work?.chapters ?? [];
        const i = list.findIndex((c) => c.id === id);
        const self = list[i];
        const next = list[i + 1];
        if (self === undefined || next === undefined) return;
        await get().moveChapter(id, next.volumeId === self.volumeId ? { volumeId: self.volumeId, after: next.id } : { volumeId: next.volumeId, after: null });
      },
      async dropChapter(id, targetId) {
        if (id === targetId) return;
        const list = get().work?.chapters ?? [];
        const from = list.findIndex((c) => c.id === id);
        const to = list.findIndex((c) => c.id === targetId);
        const target = list[to];
        if (from < 0 || target === undefined) return;
        // 向下拖放到目标之后，向上拖放到目标之前；落在目标所在的卷里。
        if (from < to) {
          await get().moveChapter(id, { volumeId: target.volumeId, after: target.id });
          return;
        }
        const before = list[to - 1];
        await get().moveChapter(id, { volumeId: target.volumeId, after: before !== undefined && before.volumeId === target.volumeId ? before.id : null });
      },
      async dropChapterOnVolume(id, volumeId) {
        await get().moveChapter(id, { volumeId, after: null });
      },
      async createChapterIn(volumeId, title) {
        if (!(await get().leaveChapter())) return false;
        const before = new Set((get().work?.chapters ?? []).map((c) => c.id));
        const ok = await run(service.createChapter(title, undefined, volumeId), (work) => ({ work }));
        if (ok) {
          const created = get().work?.chapters.find((c) => !before.has(c.id));
          if (created !== undefined) set({ selectedChapterId: created.id, panel: 'chapter' });
        }
        return ok;
      },
      createVolume: (title) => run(service.createVolume(title), (work) => ({ work })),
      async updateVolume(id, fields) {
        const volume = get().work?.volumes.find((v) => v.id === id);
        return volume === undefined ? false : run(service.updateVolume(volume, fields), (work) => ({ work }));
      },
      async moveVolumeUp(id) {
        const list = get().work?.volumes ?? [];
        const i = list.findIndex((v) => v.id === id);
        const volume = list[i];
        if (volume !== undefined && i > 0) await run(service.moveVolume(volume, list[i - 2]?.id ?? null), (work) => ({ work }));
      },
      async moveVolumeDown(id) {
        const list = get().work?.volumes ?? [];
        const i = list.findIndex((v) => v.id === id);
        const volume = list[i];
        const next = list[i + 1];
        if (volume !== undefined && next !== undefined) await run(service.moveVolume(volume, next.id), (work) => ({ work }));
      },
      async deleteVolume(id) {
        const volume = get().work?.volumes.find((v) => v.id === id);
        if (volume !== undefined) await run(service.deleteVolume(volume), (work) => ({ work }));
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
        if (panel === 'info') await get().loadCover();
      },
      async loadCover() {
        const cover = await service.workCover();
        if (cover.ok) set({ cover: cover.value });
        else set({ message: describeError(cover.error) });
      },
      setCover: (image) => run(service.setWorkCover(image), (cover) => ({ cover })),
      async removeCover() {
        await run(service.removeWorkCover(), () => ({ cover: null }));
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
        set({ panel: 'settings', chapterContent: null, selectedEntityId: entityId ?? get().selectedEntityId, drawer: null });
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
      openEntityDrawer: (id) => set(id === null ? closeDrawer('entity') : { drawer: { kind: 'entity', entityId: id } }),
      async openPlanning() {
        if (!(await get().leaveChapter())) return;
        await run(service.planningView(), (planning) => ({ planning, panel: 'planning', chapterContent: null, drawer: null }));
      },
      toggleAssistant: () => set({ assistantOpen: !get().assistantOpen }),
      async loadAssistant() {
        const owner = get().work?.project.id ?? '';
        const items = await service.assistantItems();
        if (items.ok) set({ assistantItems: items.value, assistantFor: owner });
      },
      async sendAssistant(text) {
        if (get().assistantRunning || text.trim() === '') return false;
        const selection = chosenSelection();
        // 助手会改动作品：先保存正在编辑的正文，工作期间正文只读。
        if (!(await get().leaveChapter())) return false;
        return assistantTurn(text.trim().slice(0, 24), selection, (events) => service.sendToAssistant(text, events));
      },
      async resolveAssistant(approve) {
        if (get().assistantRunning) return;
        const selection = chosenSelection();
        if (!(await get().leaveChapter())) return;
        await assistantTurn(approve ? '确认执行' : '不执行', selection, (events) => service.resolveAssistantPending(approve, events));
      },
      setEditorSelection(info) {
        const now = get().editorSelection;
        if (now?.key === info?.key) return;
        // 选区变了：之前点过的“不带上”不再算数。
        set({ editorSelection: info, selectionDismissed: null });
      },
      dismissSelection: () => set({ selectionDismissed: get().editorSelection?.key ?? null }),
      stopAssistant: () => assistantAbort?.abort(),
      async clearAssistant() {
        if (get().assistantRunning) return;
        await run(service.clearAssistant(), () => ({ assistantItems: [] }));
      },
      async openQuickBook() {
        if (!(await get().leaveChapter())) return;
        set({ panel: 'book', chapterContent: null, drawer: null });
        await get().refreshQuickBook();
      },
      async refreshQuickBook() {
        const [status, planning] = await Promise.all([service.quickBookStatus(), service.planningView()]);
        if (status.ok && planning.ok) set({ quickBook: status.value, planning: planning.value });
        else set({ message: describeError(!status.ok ? status.error : !planning.ok ? planning.error : { code: 'no_work' }) });
      },
      async draftBookSeed(request) {
        if (get().seedDrafting) return;
        const t = startTask('plan_draft', '生成大纲与人物', null);
        set({ seedDrafting: true, message: null });
        const result = await service.draftBookSeed(request, t.options());
        if (result.ok) {
          set({ bookSeed: result.value, seedDrafting: false });
          t.finish('done');
        } else {
          set({ seedDrafting: false, message: describeError(result.error) });
          t.fail(describeError(result.error));
        }
      },
      editBookSeed: (seed) => set({ bookSeed: seed }),
      discardBookSeed: () => set({ bookSeed: null }),
      async applyBookSeed() {
        const seed = get().bookSeed;
        if (seed === null) return false;
        const done = await run(service.applyBookSeed(seed), () => ({ bookSeed: null }));
        if (!done) return false;
        const work = await service.reloadWork();
        if (work.ok) set({ work: work.value });
        await loadEntities();
        await get().refreshQuickBook();
        return true;
      },
      async draftPlans(chapterCount, wordsPerChapter) {
        const t = startTask('plan_draft', '生成章节计划草稿', null);
        set({ planDrafting: true, planUnmatched: [] });
        const result = await service.draftPlans({ chapterCount, wordsPerChapter }, t.options());
        if (result.ok) {
          set({ planDraft: result.value, planDrafting: false, message: null });
          t.finish('done');
        } else {
          set({ planDrafting: false, message: describeError(result.error) });
          t.fail(describeError(result.error));
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
        await run(service.listSimScenes(), (simScenes) => ({ simScenes, panel: 'simulation', chapterContent: null, drawer: null }));
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
        set({ simRunId: id, simRun: null, beatSheets: [], narrationNote: null, simEvaluation: null });
        await refreshRun(id);
        await loadBeatSheets(id);
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
      async draftBeatSheet(request) {
        const id = get().simRunId;
        if (id === null || get().narrationBusy) return null;
        set({ narrationBusy: true, message: null });
        const result = await modelTask('beat_sheet', `节拍表 · 第 ${request.fromRound}–${request.toRound} 回合`, null, (options) => service.draftBeatSheet(id, request, options));
        set({ narrationBusy: false });
        if (!result.ok) return null;
        await loadBeatSheets(id);
        return result.value.sheet.id;
      },
      async saveBeatSheet(sheetId, fields) {
        const id = get().simRunId;
        if (id === null) return false;
        const saved = await service.saveBeatSheet(sheetId, fields);
        if (!saved.ok) {
          set({ message: describeError(saved.error) });
          return false;
        }
        await loadBeatSheets(id);
        return true;
      },
      async narrateBeatSheet(sheetId, chapterId) {
        if (get().narrationBusy) return;
        // 写到正在编辑的这一章时先保存：未保存的修改会让写作被拒绝。
        if (!(await get().leaveChapter())) return;
        set({ narrationBusy: true, message: null, narrationNote: null });
        const title = get().work?.chapters.find((c) => c.id === chapterId)?.title ?? '';
        const result = await modelTask('narrate', `推演写成正文 · ${title}`, chapterId, (options) => service.narrateBeatSheet(sheetId, chapterId, options));
        set({ narrationBusy: false, ...(result.ok && { narrationNote: { chapterId, text: `已在“${title}”末尾生成候选稿，采纳后才写入正文。` } }) });
      },
      async loadSimEvaluation() {
        const runId = get().simRunId;
        if (runId === null) return;
        await run(service.simEvaluation(runId), (view) => ({ simEvaluation: get().simRunId === runId ? { ...view, runId } : get().simEvaluation }));
      },
      async saveSimEvaluation(input) {
        const current = get().simEvaluation;
        if (current === null) return false;
        const { runId } = current;
        return run(service.saveSimEvaluation(runId, input, current.evaluation?.version ?? null), (view) => ({
          simEvaluation: get().simRunId === runId ? { ...view, runId } : get().simEvaluation,
        }));
      },
      async openNarratedChapter(chapterId) {
        await get().selectChapter(chapterId);
        if (get().selectedChapterId === chapterId) await get().openAiWrite();
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
        const t = startTask('scene_draft', '生成场景配置草稿', null);
        set({ sceneDrafting: true, message: null });
        const result = await service.draftSimScene(description, t.options());
        if (result.ok) {
          const title = result.value.config.meta?.title?.trim() ?? '';
          set({ sceneDrafting: false, sceneDraft: { serial: ++sceneSerial, title: title === '' ? '新场景' : title, config: result.value.config, problems: result.value.problems } });
          t.finish('done');
        } else {
          set({ sceneDrafting: false, message: describeError(result.error) });
          t.fail(describeError(result.error));
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
          const title = chapter(chapterId)?.title ?? '';
          const t = startTask('writer', `写手 · ${title}`, chapterId, abort);
          const queued = chapterIds.slice(i + 1);
          set({ writerJob: { chapterId, stage: 'writing', done: 0, total: 0, queued }, message: null });
          const result = await service.writeChapter(chapterId, {
            ...t.options(),
            onSegment: (done, total) => {
              set({ writerJob: { chapterId, stage: 'writing', done, total, queued } });
              void refresh(chapterId);
            },
          });
          await refresh(chapterId);
          if (!result.ok) {
            set({ message: describeError(result.error) });
            t.fail(describeError(result.error));
            break;
          }
          const { status, reason, segmentsDone, segmentsTotal } = result.value;
          if (status === 'written') {
            t.finish('done');
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
          t.finish(status === 'cancelled' ? 'cancelled' : 'failed', { error: note });
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
        set({ drawer: { kind: 'review' }, review });
      },
      closeReview: () => set(closeDrawer('review')),
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
        const t = startTask('writer', `写手修订 · ${chapter(chapterId)?.title ?? ''}`, chapterId, abort);
        set({ review: { ...current, revisingId: id, note: null }, message: null });
        const result = await service.reviseIssue(id, t.options());
        if (reviewAbort === abort) reviewAbort = null;
        const now = get().review;
        const same = now !== null && now.chapterId === chapterId;
        if (!result.ok) {
          t.fail(describeError(result.error));
          if (same) set({ review: { ...now, revisingId: null, note: describeError(result.error) } });
          return;
        }
        t.finish('done');
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
        await run(service.listWritingSkills(), (skills) => ({ skills, panel: 'skills', chapterContent: null, drawer: null }));
      },
      async updateWritingSkill(id, patch) {
        const skill = get().skills?.skills.find((s) => s.skill.id === id)?.skill;
        return skill === undefined ? false : run(service.updateWritingSkill(skill, patch), (skills) => ({ skills }));
      },
      addCustomSkill: (name, instruction, description, key, stages) => run(service.addCustomSkill(name, instruction, description, key, stages), (skills) => ({ skills })),
      async importSkillMd() {
        const picked = await service.pickText();
        if (!picked.ok) {
          set({ message: picked.error });
          return;
        }
        if (picked.value === null) return;
        await service.releaseImport(picked.value.token);
        await get().importSkillText(picked.value.text);
      },
      async importSkillText(text) {
        const imported = await service.importSkillMd(text);
        set(
          imported.ok
            ? { skills: imported.value.view, message: `${imported.value.replaced ? '已更新' : '已导入'}技能“${imported.value.name}”` }
            : { message: describeError(imported.error) },
        );
        return imported.ok;
      },
      async exportSkillMd(id) {
        const view = get().skills?.skills.find((s) => s.skill.id === id);
        if (view === undefined) return;
        const file = service.skillMdOf(view);
        const saved = await service.exportPlainText(file.fileName, file.content, 'md');
        if (!saved.ok) set({ message: `导出失败：${saved.error}` });
      },
      async deleteCustomSkill(id) {
        const skill = get().skills?.skills.find((s) => s.skill.id === id)?.skill;
        return skill === undefined ? false : run(service.deleteCustomSkill(skill), (skills) => ({ skills }));
      },
      setAvoidPhrases: (phrases) => run(service.setAvoidPhrases(phrases), (skills) => ({ skills })),
      async openRelations() {
        if (!(await get().leaveChapter())) return;
        await run(service.relationsView(), (relations) => ({ relations, panel: 'relations', chapterContent: null, drawer: null }));
      },
      async saveRelationship(id, fields) {
        const current = id === null ? null : (get().relations?.relationships.find((r) => r.id === id) ?? null);
        if (id !== null && current === null) return false;
        return run(current === null ? service.addRelationship(fields) : service.updateRelationship(current, fields), (relations) => ({ relations }));
      },
      async deleteRelationship(id) {
        const current = get().relations?.relationships.find((r) => r.id === id);
        if (current === undefined) return false;
        return run(service.deleteRelationship(current), (relations) => ({ relations }));
      },
      async placeRelationNode(entityId, at) {
        // 拖动只影响显示：不进入忙碌状态，失败时说明。
        const result = await service.setRelationPosition(entityId, at);
        if (result.ok) set({ relations: result.value });
        else set({ message: describeError(result.error) });
      },
      async resetRelationLayout() {
        await run(service.resetRelationLayout(), (relations) => ({ relations }));
      },
      async openFacts(factId) {
        if (!(await get().leaveChapter())) return;
        set({ panel: 'facts', chapterContent: null, selectedFactId: factId ?? get().selectedFactId, drawer: null });
        await reloadFacts();
      },
      selectFact: (id) => set({ selectedFactId: id }),
      async openSourceStats() {
        if (!(await get().leaveChapter())) return;
        await run(service.sourceStats(), (sourceStats) => ({ sourceStats, panel: 'sources', chapterContent: null, drawer: null }));
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
          drawer: { kind: 'context' },
        }));
      },
      closeContext: () => set(closeDrawer('context')),
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
        set({ drawer: { kind: 'write' }, writeSelection: selection, writeSelectedText: selectedText, contextSelection: selection });
        await run(service.listCandidates(chapterId), (candidates) => ({ candidates }));
      },
      closeAiWrite: () => {
        writeAbort?.abort();
        set(closeDrawer('write'));
      },
      async runSelectionOp(operation, instruction) {
        const chapterId = get().selectedChapterId;
        if (chapterId === null || get().aiWrite?.status === 'running') return;
        const abort = new AbortController();
        writeAbort = abort;
        set({ aiWrite: { operation, instruction, status: 'running', text: '', error: null, candidateId: null } });
        const chapterTitle = get().work?.chapters.find((c) => c.id === chapterId)?.title ?? '';
        const t = startTask('selection_edit', `${OPERATION_LABELS[operation]} · ${chapterTitle}`, chapterId, abort);
        const update = (patch: Partial<AiWriteJob>) => {
          const job = get().aiWrite;
          if (job !== null && writeAbort === abort) set({ aiWrite: { ...job, ...patch } });
        };
        const result = await service.runSelectionOperation(
          { chapterId, selection: get().writeSelection, operation, instruction, overrides: get().contextOverrides[chapterId] ?? NO_OVERRIDES },
          t.options({ onText: (delta) => update({ text: (get().aiWrite?.text ?? '') + delta }) }),
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
          t.finish(outcome === 'cancelled' ? 'cancelled' : outcome === 'refused' ? 'failed' : 'done', { text, cost: result.value.cost, error: outcome === 'refused' ? '模型拒绝了这个请求' : null });
        } else {
          update({ status: abort.signal.aborted ? 'cancelled' : 'failed', error: describeError(result.error) });
          t.fail(describeError(result.error));
        }
        if (writeAbort === abort) writeAbort = null;
      },
      cancelSelectionOp: () => writeAbort?.abort(),
      async openTasks() {
        if (!(await get().leaveChapter())) return;
        set({ panel: 'tasks', chapterContent: null, drawer: null });
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
      async openAdoption(candidateId) {
        await run(service.adoptionDraft(candidateId), (adoption) => ({ adoption }));
      },
      closeAdoption: () => set({ adoption: null }),
      async adoptCandidate(request) {
        const chapterId = get().selectedChapterId;
        if (chapterId === null || !(await get().leaveChapter())) return;
        const adopted = await run(service.adoptCandidate(request), ({ paragraphs }) => ({
          chapterContent: { chapterId, saved: paragraphs, draft: null },
          contentRevision: get().contentRevision + 1,
          saveStatus: { kind: 'saved' },
          candidates: get().candidates.filter((c) => c.id !== request.candidateId),
          adoption: null,
        }));
        if (adopted) {
          await reloadFacts();
          return;
        }
        // 过期的候选稿不再列出（与接受相同）；直接读取列表，不清掉刚显示的原因。
        const list = await service.listCandidates(chapterId);
        if (list.ok) set({ candidates: list.value, ...(!list.value.some((c) => c.id === request.candidateId) && { adoption: null }) });
      },
      async openUsage() {
        if (!(await get().leaveChapter())) return;
        await run(service.usage(), (usage) => ({ usage, panel: 'usage', chapterContent: null, drawer: null }));
      },
      async openSearch(query) {
        if (!(await get().leaveChapter())) return;
        set({ panel: 'search', chapterContent: null, drawer: null });
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
        set({ modelServicesOpen: true, chapterContent: null, drawer: null });
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
      async applyBuiltinModel(modelId) {
        await run(service.applyBuiltinModel(modelId), (modelServices) => ({ modelServices }));
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
      setTheme: (theme) => savePreferences({ theme }),
      setLayout: (patch) => {
        const layout = get().library?.preferences.layout;
        return layout === undefined ? Promise.resolve() : savePreferences({ layout: { ...layout, ...patch } });
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

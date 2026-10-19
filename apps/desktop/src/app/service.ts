// 应用服务层（DESIGN_PATTERNS 第六章）：每个作者操作对应一个用例，协调作品列表、作品库与仓储。
// 界面组件只调用这里的用例、订阅状态，不直接访问仓储或端口。
import { relationUseCases } from './relations';
import { err, ok, type Result } from '@fudiao/shared';
import {
  interruptRunningSteps,
  latestCallWithUsage,
  getCover,
  getCoverThumbnail,
  removeCover,
  saveCover,
  type Cover,
  createChapter,
  createVolume,
  deleteVolume,
  listVolumes,
  moveVolume,
  updateVolume,
  createEntity,
  createFact,
  deleteFact,
  listFacts,
  listRelationships,
  reviewStaleFacts,
  setFactStatus,
  updateFact,
  deleteEntity,
  listEntities,
  setEntityLocked,
  updateEntity,
  importChapters,
  importData,
  createProject,
  getProject,
  listChapters,
  listParagraphs,
  saveChapterParagraphs,
  searchParagraphs,
  sourceStats,
  usageSummary,
  listLlmCalls,
  findCallByRequestHash,
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
  type ChapterTarget,
  type Entity,
  type Fact,
  type FactInput,
  type FactStatus,
  type EntityKind,
  type EntityPatch,
  type Project,
  type ProjectPatch,
  type RepoError,
  type Volume,
  type CurrentParagraph,
  type SavedParagraph,
  type SqlPort,
  type Snapshot,
  type SnapshotSummary,
  type ImportChapter,
  type SearchResult,
  type SourceStats,
  type UsageSummary,
  type Candidate,
  type LlmCallRow,
  type StructuralEdits,
} from '@fudiao/store';
import { draftDiffers, draftJson, parseDraft, type DraftFile } from './draft';
import { buildPackage, parsePackage, withProjectId } from './project-package';
import { toMarkdown, toTxt, type ExportChapter } from './text-export';
import { buildWritingContext, type ContextManifest, type ContextOverrides } from '@fudiao/context';
import { candidateUseCases } from './candidates';
import { writingSkillUseCases } from './writing-skills';
import { planningUseCases } from './planning';
import { memoryUseCases } from './memory';
import { assistantUseCases, type AssistantUsage } from './assistant';
import { narrationUseCases } from './narration';
import { quickBookUseCases } from './quick-book';
import { workflowUseCases } from './workflows';
import { bookAuditUseCases } from './book-audit';
import { asChangeEntries, captureWork, diffWork, undoChanges } from './assistant-undo';
import { reviewUseCases } from './review';
import { simEvaluationUseCases } from './sim-evaluation';
import { simulationUseCases } from './simulation';
import { writerUseCases } from './writer';
import { modelRunner } from './model-runner';
import { contextBudget, gatherWritingInput, type EditorSelection } from './writing-context';
import { maxOutputTokens, needsSelection, promptParts, targetLength } from './selection-ops';
import { renderSelectionEdit, type SelectionOperation } from '@fudiao/prompts';
import type { CallOptions, LlmResult } from '@fudiao/llm';
import { modelServices } from './model-services';
import { EMPTY_LIBRARY, folderName, joinPath, LibraryFile, samePath, sortWorks, type Preferences, type WorkEntry } from './library';
import { describeError, type AppError } from './errors';
import type { AppDeps, BackupInfo } from './ports';

/** 自动备份的间隔：打开作品时距上次自动备份超过这么久才备份。 */
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type { AppError } from './errors';

export type LibraryWork = WorkEntry & { readonly missing: boolean };
export type LibraryView = { readonly libraryDir: string; readonly works: readonly LibraryWork[]; readonly preferences: Preferences };

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
  /** 分卷（B68），按书中的顺序；没有分卷时为空。 */
  readonly volumes: readonly Volume[];
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
    const volumes = await listVolumes(session.port);
    if (!volumes.ok) return err(repo(volumes.error));
    return ok({ entry: session.entry, project: project.value, chapters: chapters.value, trashed: trashed.value, volumes: volumes.value });
  }

  /** 打开作品库并读取作品信息；成功后成为当前作品。 */
  /**
   * 打开作品库并读取作品信息；成功后成为当前作品。prepare 在新建或导入时写入初始内容
   * （新建作品信息、导回作品包），失败时关闭作品库。
   */
  async function openAt(
    path: string,
    entryOf: (project: Project) => Omit<WorkEntry, 'cover'>,
    prepare?: (port: SqlPort) => Promise<Result<unknown, AppError>>,
  ): Promise<Result<WorkView, AppError>> {
    await close();
    const opened = await deps.opener.open(path, deps.clock.now());
    if (!opened.ok) return err({ code: 'open_failed', error: opened.error });
    const port = opened.value.port;
    if (prepare !== undefined) {
      const prepared = await prepare(port);
      if (!prepared.ok) {
        await deps.opener.close();
        return prepared;
      }
    }
    const project = await getProject(port);
    if (!project.ok || project.value === null) {
      await deps.opener.close();
      return project.ok ? err({ code: 'not_a_work', path }) : err(repo(project.error));
    }
    // 作品列表里的封面缩略图是缓存，打开时按作品库更新（别处改过、或从作品包导回时带着封面）。
    const thumbnail = await getCoverThumbnail(port);
    const entry: WorkEntry = { ...entryOf(project.value), cover: thumbnail.ok ? thumbnail.value : null };
    const saved = await upsert(entry);
    if (!saved.ok) {
      await deps.opener.close();
      return saved;
    }
    session = { entry, port };
    // 写作工作流（B78）：上次没做完就关掉（或崩溃）的步骤标为中断，作者继续时从这一步重做。读不了也不妨碍打开作品。
    await interruptRunningSteps(port, ctx());
    return view();
  }

  /** 作品库下为新作品取一个不重名的文件夹：文件夹名取自标题，重名时加序号。 */
  async function newWorkPath(title: string): Promise<Result<string, AppError>> {
    const dir = await libraryDir();
    if (!dir.ok) return dir;
    const base = folderName(title);
    let path = joinPath(dir.value, base);
    for (let i = 2; (await deps.library.probe(path)).exists; i++) path = joinPath(dir.value, `${base}（${i}）`);
    return ok(path);
  }

  const freshEntry = (path: string) => (p: Project) => ({ id: p.id, path, title: p.title, archived: false, lastOpenedAt: deps.clock.now() });

  async function createWork(title: string): Promise<Result<WorkView, AppError>> {
    const name = title.trim();
    if (name === '') return err({ code: 'repo', error: { code: 'invalid', detail: '作品名不能为空' } });
    const path = await newWorkPath(name);
    if (!path.ok) return path;
    return openAt(path.value, freshEntry(path.value), async (port) => {
      const created = await createProject(port, { id: deps.ids.next(), title: name }, ctx());
      return created.ok ? created : err(repo(created.error));
    });
  }

  async function close(): Promise<void> {
    if (session === null) return;
    session = null;
    await deps.opener.close();
  }

  async function entities(): Promise<Result<Entity[], AppError>> {
    if (session === null) return err({ code: 'no_work' });
    const list = await listEntities(session.port);
    return list.ok ? list : err(repo(list.error));
  }

  /** 设定的修改：失败时也返回原因；成功后标出需要复核的事实，再重新读取列表。 */
  async function entityChange(f: (port: SqlPort) => Promise<Result<unknown, RepoError>>): Promise<Result<Entity[], AppError>> {
    if (session === null) return err({ code: 'no_work' });
    const done = await f(session.port);
    if (!done.ok) return err(repo(done.error));
    const reviewed = await reviewStaleFacts(session.port, ctx());
    return reviewed.ok ? entities() : err(repo(reviewed.error));
  }

  /** 事实列表；先标出需要复核的事实（需求 B12），列表中的状态因此总是最新的。 */
  async function facts(): Promise<Result<Fact[], AppError>> {
    if (session === null) return err({ code: 'no_work' });
    const reviewed = await reviewStaleFacts(session.port, ctx());
    if (!reviewed.ok) return err(repo(reviewed.error));
    const list = await listFacts(session.port);
    return list.ok ? list : err(repo(list.error));
  }

  async function factChange(f: (port: SqlPort) => Promise<Result<unknown, RepoError>>): Promise<Result<Fact[], AppError>> {
    if (session === null) return err({ code: 'no_work' });
    const done = await f(session.port);
    return done.ok ? facts() : err(repo(done.error));
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
    return ok({ libraryDir: dir.value, works, preferences: file.preferences });
  }

  /**
   * 写作类 AI 任务的上下文清单（B18）：按选区（或光标）收集本章与前面的章节、出现的设定与相关事实，按预算选入。
   * 调用前界面先保存正在编辑的正文。
   */
  async function writingContext(chapterId: string, selection: EditorSelection | null, overrides: ContextOverrides): Promise<Result<ContextManifest, AppError>> {
    if (session === null) return err({ code: 'no_work' });
    const port = session.port;
    const project = await getProject(port);
    if (!project.ok) return err(repo(project.error));
    if (project.value === null) return err({ code: 'not_found' });
    const chapters = await listChapters(port, 'normal');
    if (!chapters.ok) return err(repo(chapters.error));
    const paragraphs = await listParagraphs(port, chapterId);
    if (!paragraphs.ok) return err(repo(paragraphs.error));
    const entities = await listEntities(port);
    if (!entities.ok) return err(repo(entities.error));
    const facts = await listFacts(port);
    if (!facts.ok) return err(repo(facts.error));
    const relationships = await listRelationships(port);
    if (!relationships.ok) return err(repo(relationships.error));
    const input = gatherWritingInput(
      { project: project.value, chapters: chapters.value, chapterId, paragraphs: paragraphs.value, entities: entities.value, facts: facts.value, relationships: relationships.value },
      selection,
    );
    if (input === null) return err({ code: 'not_found' });
    // 没有设置默认模型时用保守的预算；设置读不出来也不妨碍查看清单。
    const choice = await services.defaultModel();
    const budget = contextBudget(choice.ok ? (choice.value?.model ?? null) : null);
    return ok(buildWritingContext(input, budget, overrides));
  }

  const services = modelServices(deps);
  const candidates = candidateUseCases(deps, () => session?.port ?? null);
  const writingSkills = writingSkillUseCases(deps, () => session?.port ?? null);
  /** 模型调用：用默认模型，调用记录写入当前作品库（M2-05 起由选区操作等使用）。 */
  const runner = modelRunner({ deps, project: () => session?.port ?? null, defaultModel: () => services.defaultModel() });
  const planning = planningUseCases(deps, () => session?.port ?? null, runner);
  const writer = writerUseCases(deps, () => (session === null ? null : { port: session.port, path: session.entry.path }), runner);
  const memory = memoryUseCases(deps, () => session?.port ?? null, runner);
  const narration = narrationUseCases(deps, () => (session === null ? null : { port: session.port, path: session.entry.path }), runner);
  const review = reviewUseCases(deps, () => (session === null ? null : { port: session.port, path: session.entry.path }), runner);
  const simEvaluation = simEvaluationUseCases(deps, () => session?.port ?? null);
  const relations = relationUseCases(deps, () => session?.port ?? null);
  const simulation = simulationUseCases({
    deps,
    project: () => session?.port ?? null,
    defaultModel: () => services.defaultModel(),
    provider: async (id) => {
      const view = await services.loadModelServices();
      return view.ok ? (view.value.providers.find((p) => p.id === id) ?? null) : null;
    },
    runner,
  });

  const app = {
    /** 应用的时钟（任务的开始与结束时间等，界面不直接读系统时间）。 */
    now: (): string => deps.clock.now(),
    ...services,
    ...candidates,
    ...writingSkills,
    ...planning,
    ...writer,
    ...memory,
    ...narration,
    ...review,
    ...simulation,
    ...simEvaluation,
    ...relations,

    /** 交给写手修订与写手写章共用一把锁：写手正在写这一章时不修订，修订期间也不开始写。 */
    async reviseIssue(issueId: string, options: CallOptions = {}) {
      const chapterId = await review.issueChapterId(issueId);
      if (!chapterId.ok) return chapterId;
      if (chapterId.value === null) return err(repo({ code: 'not_found' }));
      return writer.withWriterLock(chapterId.value, () => review.reviseIssue(issueId, options));
    },

    /** 接受候选稿后本章正文已变，删除旧草稿，避免下次打开时提示恢复旧内容。 */
    async acceptCandidate(candidateId: string) {
      const accepted = await candidates.acceptCandidate(candidateId);
      if (accepted.ok && session !== null) await deps.drafts.remove(session.entry.path, accepted.value.candidate.chapterId);
      return accepted;
    },
    runner,

    writingContext,

    /**
     * 选区操作（B16）：按上下文清单组合提示词，用默认模型流式生成。结果交给界面作为候选稿，不写入正文。
     * 调用前界面先保存正在编辑的正文。
     */
    async runSelectionOperation(
      request: {
        readonly chapterId: string;
        readonly selection: EditorSelection | null;
        readonly operation: SelectionOperation;
        readonly instruction: string;
        readonly overrides: ContextOverrides;
      },
      options: CallOptions = {},
    ): Promise<Result<{ result: LlmResult; manifest: ContextManifest; candidate: Candidate | null; cost: number | null }, AppError>> {
      const manifest = await writingContext(request.chapterId, request.selection, request.overrides);
      if (!manifest.ok) return manifest;
      const parts = promptParts(manifest.value);
      if (needsSelection(request.operation) && parts.selection.trim() === '') {
        return err({ code: 'settings', detail: '请先在正文中选中要处理的文字' });
      }
      const length = targetLength(request.operation, parts.selection);
      const prompt = renderSelectionEdit({ operation: request.operation, ...parts, length, instruction: request.instruction });
      if (!prompt.ok) return err({ code: 'settings', detail: prompt.error });
      const result = await runner.text({ prompt: prompt.value, maxOutputTokens: maxOutputTokens(length), effort: 'medium' }, options);
      if (!result.ok) return result;
      // 费用来自调用记录（价格未配置时为未知）；没有打开作品时不记录，费用也未知。
      const { outcome, text, requestHash } = result.value;
      const call = session === null ? null : await findCallByRequestHash(session.port, requestHash);
      const cost = call?.ok === true ? (call.value?.cost ?? null) : null;
      // 完整生成（含达到输出上限）的结果存为候选稿；取消与拒答只显示在界面上。
      if ((outcome !== 'completed' && outcome !== 'truncated') || text.trim() === '') return ok({ result: result.value, manifest: manifest.value, candidate: null, cost });
      const candidate = await candidates.saveCandidate({ chapterId: request.chapterId, selection: request.selection, operation: request.operation, text, requestHash });
      return candidate.ok ? ok({ result: result.value, manifest: manifest.value, candidate: candidate.value, cost }) : candidate;
    },

    /** 用量与费用（B19）：全部、按任务、按模型，以及最近的调用。 */
    async usage(): Promise<Result<{ summary: UsageSummary; recent: readonly LlmCallRow[] }, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const summary = await usageSummary(session.port);
      if (!summary.ok) return err(repo(summary.error));
      const recent = await listLlmCalls(session.port, 50);
      if (!recent.ok) return err(repo(recent.error));
      return ok({ summary: summary.value, recent: recent.value });
    },

    loadLibrary,

    /** 在作品库下新建作品文件夹；文件夹名取自标题，重名时加序号。 */
    createWork,

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

    /** 作品封面（B76）：没有时为 null，界面按书名排出文字封面。 */
    async workCover(): Promise<Result<Cover | null, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const cover = await getCover(session.port);
      return cover.ok ? cover : err(repo(cover.error));
    },

    /** 把作者选的图片缩放成封面与缩略图后保存；作品列表的缩略图随之更新。 */
    async setWorkCover(image: Blob): Promise<Result<Cover, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const prepared = await deps.images.prepareCover(image);
      if (!prepared.ok) return err({ code: 'settings', detail: prepared.error });
      const saved = await saveCover(session.port, session.entry.id, prepared.value, ctx());
      if (!saved.ok) return err(repo(saved.error));
      session = { ...session, entry: { ...session.entry, cover: prepared.value.thumbnail } };
      const cached = await upsert(session.entry);
      return cached.ok ? ok(saved.value) : cached;
    },

    /** 去掉封面，回到按书名排出的文字封面。 */
    async removeWorkCover(): Promise<Result<void, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const removed = await removeCover(session.port);
      if (!removed.ok) return err(repo(removed.error));
      session = { ...session, entry: { ...session.entry, cover: null } };
      return upsert(session.entry);
    },

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
      const snapshot = await getSnapshot(session.port, snapshotId);
      if (!snapshot.ok) return err(repo(snapshot.error));
      const refused = await writer.restoreRefused(snapshot.value.chapterId);
      if (refused !== null) return err(refused);
      const restored = await restoreSnapshot(session.port, { snapshotId, backupId: deps.ids.next() }, ctx());
      if (!restored.ok) return err(repo(restored.error));
      const chapterId = restored.value.backup.chapterId;
      await deps.drafts.remove(session.entry.path, chapterId);
      return ok({ chapterId, saved: restored.value.paragraphs, draft: null });
    },

    /** 把拆分好的章节导入为一部新作品（需求 B07）。 */
    async importTextAsWork(title: string, chapters: readonly ImportChapter[]): Promise<Result<WorkView, AppError>> {
      const created = await createWork(title);
      if (!created.ok || session === null) return created;
      const port = session.port;
      return withPort(() => importChapters(port, chapters, ctx(), () => deps.ids.next()));
    },

    /** 把拆分好的章节追加到当前作品的目录末尾。 */
    importChaptersIntoWork: (chapters: readonly ImportChapter[]) => withPort((port) => importChapters(port, chapters, ctx(), () => deps.ids.next())),

    /** 导入作品包，成为一部新作品；作品标识与列表中已有作品相同时换新标识。取消选择时返回 null。 */
    async importProject(): Promise<Result<WorkView | null, AppError>> {
      const files = await deps.transfer.pickProject();
      if (!files.ok) return err({ code: 'library', detail: files.error });
      if (files.value === null) return ok(null);
      const parsed = parsePackage(files.value);
      if (!parsed.ok) return err({ code: 'library', detail: parsed.error });
      const rawId = parsed.value.data.tables['project']?.[0]?.['id'];
      const projectId = typeof rawId === 'string' ? rawId : '';
      const data = file.works.some((w) => w.id === projectId) ? withProjectId(parsed.value.data, deps.ids.next()) : parsed.value.data;
      const path = await newWorkPath(parsed.value.manifest.title);
      if (!path.ok) return path;
      return openAt(path.value, freshEntry(path.value), async (port) => {
        const imported = await importData(port, data);
        if (imported.ok) return imported;
        // 较旧结构版本的作品包由 importData 按各迁移的转换导入；比本程序新的拒绝。
        return err({
          code: 'library',
          detail:
            imported.error.code === 'schema_mismatch'
              ? imported.error.actual > imported.error.expected
                ? '作品包由更新版本的复调导出，请先升级复调'
                : '作品包的结构版本无效'
              : `导入失败：${imported.error.code}`,
        });
      });
    },

    /** 导出整本或一章的正文。返回是否已保存。 */
    async exportText(kind: 'txt' | 'md', chapterId?: string): Promise<Result<boolean, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const work = await view();
      if (!work.ok) return work;
      const chosen = chapterId === undefined ? work.value.chapters : work.value.chapters.filter((c) => c.id === chapterId);
      const chapters: ExportChapter[] = [];
      for (const c of chosen) {
        const paragraphs = await listParagraphs(session.port, c.id);
        if (!paragraphs.ok) return err(repo(paragraphs.error));
        const volume = work.value.volumes.find((v) => v.id === c.volumeId)?.title;
        chapters.push({ title: c.title, paragraphs: paragraphs.value.map((p) => p.text), ...(volume !== undefined && chapterId === undefined && { volume }) });
      }
      const title = chapterId === undefined ? work.value.project.title : (chosen[0]?.title ?? '章节');
      const content = kind === 'txt' ? toTxt(chapters) : toMarkdown(chapters, chapterId === undefined ? title : undefined);
      const saved = await deps.exporter.exportText(`${folderName(title)}.${kind}`, content, kind);
      return saved.ok ? saved : err({ code: 'library', detail: saved.error });
    },

    /** 导出作品包。返回是否已保存。 */
    async exportProject(): Promise<Result<boolean, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const files = await buildPackage(session.port, deps.clock.now());
      if (!files.ok) return err({ code: 'library', detail: files.error });
      const saved = await deps.transfer.exportProject(`${folderName(session.entry.title)}.zip`, files.value);
      return saved.ok ? saved : err({ code: 'library', detail: saved.error });
    },

    async listBackups(): Promise<Result<readonly BackupInfo[], AppError>> {
      const list = await deps.backups.list();
      return list.ok ? list : err({ code: 'library', detail: list.error });
    },

    async createBackup(): Promise<Result<BackupInfo, AppError>> {
      const created = await deps.backups.create('manual', deps.clock.now());
      return created.ok ? created : err({ code: 'library', detail: created.error });
    },

    /** 打开作品时的自动备份：距上次自动备份超过 24 小时才备份。返回是否备份了。 */
    async autoBackupIfDue(): Promise<Result<boolean, AppError>> {
      const list = await deps.backups.list();
      if (!list.ok) return err({ code: 'library', detail: list.error });
      const latest = list.value.filter((b) => b.kind === 'auto').map((b) => b.createdAt).sort().at(-1);
      const now = deps.clock.now();
      if (latest !== undefined && Date.parse(now) - Date.parse(latest) < AUTO_BACKUP_INTERVAL_MS) return ok(false);
      const created = await deps.backups.create('auto', now);
      return created.ok ? ok(true) : err({ code: 'library', detail: created.error });
    },

    /** 修改对所有作品生效的偏好。 */
    async setPreferences(patch: Partial<Preferences>): Promise<Result<LibraryView, AppError>> {
      const saved = await save({ ...file, preferences: { ...file.preferences, ...patch } });
      return saved.ok ? loadLibrary() : saved;
    },

    /** 全文查找（需求 B04）：查回收站以外的章节。调用前界面先保存正在编辑的正文。 */
    async search(query: string): Promise<Result<SearchResult, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const result = await searchParagraphs(session.port, query);
      return result.ok ? result : err(repo(result.error));
    },

    /** 段落来源统计（需求 B33）：每章与全书的 AI 参与比例。 */
    async sourceStats(): Promise<Result<SourceStats, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const stats = await sourceStats(session.port);
      return stats.ok ? stats : err(repo(stats.error));
    },

    /** 恢复到备份（现稿先存为恢复前备份），重新读取作品。 */
    async restoreBackup(name: string): Promise<Result<WorkView, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const restored = await deps.backups.restore(name, deps.clock.now());
      if (!restored.ok) return err({ code: 'library', detail: restored.error });
      // 作品列表里的书名与封面是缓存：恢复后按作品库更新，不然列表里还是恢复前的。
      const project = await getProject(session.port);
      const thumbnail = await getCoverThumbnail(session.port);
      if (project.ok && project.value !== null && thumbnail.ok) {
        session = { ...session, entry: { ...session.entry, title: project.value.title, cover: thumbnail.value } };
        const cached = await upsert(session.entry);
        if (!cached.ok) return cached;
      }
      return view();
    },

    /** 设定条目（需求 B09）。修改后返回最新的完整列表。 */
    listEntities: () => entities(),

    /** id 只在撤销 AI 助手的删除时给出：以原来的标识重建，以它为依据的事实、关系与计划照旧指向它。 */
    async createEntity(kind: EntityKind, name: string, id?: string): Promise<Result<{ entities: Entity[]; created: Entity }, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const created = await createEntity(session.port, { id: id ?? deps.ids.next(), kind, name }, ctx());
      if (!created.ok) return err(repo(created.error));
      const list = await entities();
      return list.ok ? ok({ entities: list.value, created: created.value }) : list;
    },

    updateEntity: (entity: Entity, patch: EntityPatch) => entityChange((port) => updateEntity(port, entity.id, entity.version, patch, ctx())),
    setEntityLocked: (entity: Entity, locked: boolean) => entityChange((port) => setEntityLocked(port, entity.id, entity.version, locked, ctx())),
    deleteEntity: (entity: Entity) => entityChange((port) => deleteEntity(port, entity.id, entity.version)),

    /** 事实记录（需求 B11）：新建默认为候选，作者确认后才算已确认事实。 */
    listFacts: () => facts(),
    async createFact(input: FactInput, status: FactStatus): Promise<Result<{ facts: Fact[]; created: string }, AppError>> {
      const id = deps.ids.next();
      const list = await factChange((port) => createFact(port, id, input, status, ctx(), () => deps.ids.next()));
      return list.ok ? ok({ facts: list.value, created: id }) : list;
    },
    updateFact: (fact: Fact, input: FactInput) => factChange((port) => updateFact(port, fact.id, fact.version, input, ctx(), () => deps.ids.next())),
    setFactStatus: (fact: Fact, status: FactStatus) => factChange((port) => setFactStatus(port, fact.id, fact.version, status, ctx())),
    deleteFact: (fact: Fact) => factChange((port) => deleteFact(port, fact.id, fact.version)),

    exportPlainText: (suggestedName: string, content: string, kind?: 'txt' | 'md') => deps.exporter.exportText(suggestedName, content, kind),
    pickText: () => deps.transfer.pickText(),
    redecode: (token: string, encoding: string) => deps.transfer.redecode(token, encoding),
    releaseImport: (token: string) => deps.transfer.release(token),
    copyText: (content: string) => deps.exporter.copyText(content),

    /** 新建章节：after 为前一章（跟在它后面，同一卷）；省略时放在 volumeId 这一卷末尾，再省略时放在全书末尾。 */
    createChapter: (title: string, after?: string, volumeId?: string | null) =>
      withPort((port) => createChapter(port, { id: deps.ids.next(), title, ...(after !== undefined && { after }), ...(volumeId !== undefined && { volumeId }) }, ctx())),
    renameChapter: (chapter: Chapter, title: string) => withPort((port) => renameChapter(port, chapter.id, chapter.version, title, ctx())),
    updateChapterNotes: (chapter: Chapter, notes: { summary: string; notes: string }) =>
      withPort((port) => updateChapterNotes(port, chapter.id, chapter.version, notes, ctx())),
    /** 把章节移到 after 之后；after 为 null 时移到最前。 */
    /** 把章节移到某一卷（null 为未分卷）里某章之后（null 为卷首）。 */
    moveChapter: (chapter: Chapter, target: ChapterTarget) => withPort((port) => moveChapter(port, chapter.id, chapter.version, target, ctx())),

    /** 分卷（B68）：新建一卷（after 为前一卷，省略时放在最后）。 */
    createVolume: (title: string, after?: string) => withPort((port) => createVolume(port, { id: deps.ids.next(), title, ...(after !== undefined && { after }) }, ctx())),
    updateVolume: (volume: Volume, fields: { readonly title: string; readonly summary: string }) => withPort((port) => updateVolume(port, volume.id, volume.version, fields, ctx())),
    /** 调整卷的顺序（after 为 null 时移到最前），卷里的章节跟着移动。 */
    moveVolume: (volume: Volume, after: string | null) => withPort((port) => moveVolume(port, volume.id, volume.version, after, ctx())),
    /** 删除一卷；卷里还有章节时不删，说明先把它们移走。 */
    async deleteVolume(volume: Volume): Promise<Result<WorkView, AppError>> {
      if (session === null) return err({ code: 'no_work' });
      const done = await deleteVolume(session.port, volume.id, volume.version);
      if (!done.ok && done.error.code === 'in_use') return err({ code: 'settings', detail: `“${volume.title}”里还有章节：先把它们移到别的卷，或移入回收站` });
      return afterChange(done);
    },
    trashChapter: (chapter: Chapter) => withPort((port) => trashChapter(port, chapter.id, chapter.version, ctx())),
    restoreChapter: (chapter: Chapter) => withPort((port) => restoreChapter(port, chapter.id, chapter.version, ctx())),
  };


  // 快速成书（B67）：骨架与各步状态；计划、写作与审核沿用上面的用例。
  const quickBook = quickBookUseCases({
    deps,
    project: () => session?.port ?? null,
    runner,
    planningView: () => app.planningView(),
    defaultModel: () => services.defaultModel(),
    updateWorkInfo: (patch) => app.updateWorkInfo(patch),
  });

  // 写作工作流（B78）：步骤调用上面的用例；写章节默认就地依次写，桌面端由状态层经写手队列做。
  const workflows = workflowUseCases({
    deps,
    project: () => session?.port ?? null,
    host: { ...app, ...quickBook, ...bookAuditUseCases(deps, () => session?.port ?? null, runner) },
    // 采用的撤回沿用 AI 助手的撤销：同一套现状、差别与改回的规则。
    changes: {
      capture: () => captureWork(app, session?.port ?? null),
      diff: (before, after) => diffWork(before, after),
      undo: (entries) => undoChanges(app, () => session?.port ?? null, [asChangeEntries(entries)]),
    },
    async pricing() {
      const choice = await services.defaultModel();
      if (!choice.ok || choice.value === null) return null;
      const { model } = choice.value;
      return { model: model.displayName, prices: model.prices ?? undefined };
    },
    hooks: {
      async reviewChapters(chapterIds, options) {
        const done: string[] = [];
        for (const id of chapterIds) {
          const reviewed = await app.reviewChapter(id, options);
          if (!reviewed.ok || !reviewed.value.modelReviewed) {
            return { ok: false, summary: `${done.length > 0 ? `已审完 ${done.length} 章；` : ''}审核没有完成：${reviewed.ok ? (reviewed.value.reason ?? '') : describeError(reviewed.error)}` };
          }
          done.push(id);
        }
        return { ok: true, summary: `审完了 ${done.length} 章` };
      },
      async writeChapters(chapterIds, review, options) {
        const done: string[] = [];
        for (const id of chapterIds) {
          const written = await app.writeChapter(id, options);
          if (!written.ok) return { ok: false, summary: `${done.length > 0 ? `已写完 ${done.length} 章；` : ''}停在这一章：${describeError(written.error)}` };
          if (written.value.status !== 'written') return { ok: false, summary: `${done.length > 0 ? `已写完 ${done.length} 章；` : ''}写手停下：${written.value.reason ?? ''}` };
          const memory = await app.buildMemory(id, options);
          if (!memory.ok) return { ok: false, summary: `已写完 ${done.length + 1} 章，长篇记忆没有整理成：${describeError(memory.error)}` };
          if (review) {
            const reviewed = await app.reviewChapter(id, options);
            if (!reviewed.ok || !reviewed.value.modelReviewed) {
              return { ok: false, summary: `已写完 ${done.length + 1} 章，审核没有完成：${reviewed.ok ? (reviewed.value.reason ?? '') : describeError(reviewed.error)}` };
            }
          }
          done.push(id);
        }
        return { ok: true, summary: `写完了 ${done.length} 章${review ? '并审核' : ''}` };
      },
    },
  });

  // AI 助手（B69）：工具调用上面的用例，规则与守卫照常生效。
  const assistant = assistantUseCases({ deps, host: { ...app, workflows }, project: () => session?.port ?? null, workKey: () => session?.entry.path ?? null, runner });

  return {
    ...app,
    ...assistant,
    ...workflows,

    /**
     * 这部作品里 AI 助手最近一步的上下文用量（取自调用记录）：重新打开作品或重启之后，对话还在时照样显示。
     * 上限按那一步所用模型的能力；模型已经删掉时为 null。
     */
    async assistantContextUsage(): Promise<Result<AssistantUsage | null, AppError>> {
      if (session === null) return ok(null);
      const call = await latestCallWithUsage(session.port, 'assistant');
      if (!call.ok) return err(repo(call.error));
      const usage = call.value?.usage ?? null;
      if (call.value === null || usage === null) return ok(null);
      const view = await services.loadModelServices();
      if (!view.ok) return view;
      const model = view.value.models.find((m) => m.providerId === call.value?.provider && m.modelId === call.value.model);
      return ok(model === undefined ? null : { promptTokens: usage.input + usage.cacheRead + usage.cacheWrite, contextWindow: model.capabilities.contextWindow });
    },
    ...quickBook,
  };
}

export type AppService = ReturnType<typeof createAppService>;

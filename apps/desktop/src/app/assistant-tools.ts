// AI 助手的动作（需求 B69、B71）：命令表，每个动作一项——名称、执行，以及须作者确认时给作者看的说明。
// 动作的参数已由结构化输出管线按 packages/prompts 的 AssistantAction 校验；执行只调用现有的用例，
// 锁定设定、快照、版本守卫、回收站与“候选”照常生效。表的类型要求每个动作都有一项，新增动作时漏不掉。
import type { AssistantAction, AssistantTool, PlanDraftData, SelectionOperation } from '@fudiao/prompts';
import type { ContextOverrides } from '@fudiao/context';
import type { CallOptions } from '@fudiao/llm';
import { err, ok, type Result, type SkillStage } from '@fudiao/shared';
import {
  chapterLengths,
  listChapterPlans,
  type Chapter,
  type ChapterTarget,
  type Entity,
  type EntityKind,
  type EntityPatch,
  type Fact,
  type FactInput,
  type FactStatus,
  type Foreshadow,
  type ForeshadowFields,
  type PlanFields,
  type ProjectPatch,
  type RelationshipFields,
  type SearchResult,
  type SimRun,
  type SimScene,
  type SimSceneFields,
  type SqlPort,
  type StoredEvent,
  type Volume,
} from '@fudiao/store';
import type { RunEvent } from '@fudiao/engine';
import type { AppError } from './errors';
import { WORKFLOW_STATE_LABEL, WORKFLOW_STEP_STATUS_LABEL, ENTITY_KIND_LABEL, FORESHADOW_STATUS_LABEL, PLAN_STATUS_LABEL, RELATION_CATEGORY_LABEL, SIM_END_LABEL, SIM_PAUSE_LABEL, SIM_RUN_STATUS_LABEL, SKILL_STAGE_LABEL } from './labels';
import type { BeatSheetRequest, BeatSheetView } from './narration';
import { ACTION_LABELS, INJURY_LABELS } from './sim-describe';
import type { SceneDraft, SimRunDetail, SimRunOptions, SimRunView } from './simulation';
import type { AppliedDraft, PlanningView } from './planning';
import type { RelationsView } from './relations';
import type { SkillsView } from './writing-skills';
import type { ReviewIssueView, ReviewOutcome, RevisionOutcome } from './review';
import type { EditorSelection } from './writing-context';
import type { WriterEvents, WriterOutcome } from './writer';
import type { WorkflowKey, WorkflowUseCases, WorkflowView } from './workflows';
import type { ASSISTANT_WORKFLOWS } from '@fudiao/prompts';

/** 助手要界面做的事：打开章节或页面；打开一章旁的候选稿或审核问题；作品换了（新建或打开了另一部）；作品内容变了。 */
export type AssistantEffect =
  | { readonly kind: 'open_chapter'; readonly chapterId: string }
  | { readonly kind: 'show_candidates'; readonly chapterId: string }
  | { readonly kind: 'show_review'; readonly chapterId: string }
  | { readonly kind: 'chapter_changed'; readonly chapterId: string }
  | { readonly kind: 'open_page'; readonly page: Extract<AssistantAction, { tool: 'open_page' }>['page'] }
  | { readonly kind: 'work_opened' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'simulation_changed' };

/** 作者发话时在正文里选中的文字（edit_selection 的对象）。 */
export type AssistantSelection = { readonly chapterId: string; readonly range: EditorSelection; readonly text: string };

/**
 * 交给后台的长任务（桌面端由状态层实现）：开始后立即返回，任务在后台依次进行，进度出现在任务页与“正在进行的任务”里。
 * 返回 null 表示已经排上，否则是没有排上的原因（例如已有一批在进行）。
 */
export type BackgroundJobs = {
  /** 排上返回 null，否则是没排上的原因（例如本章正文保存不了：写手不覆盖未保存的修改）。 */
  /** onEnd：这一批结束时（写完、停下或出错）调用，给出怎样结束的一句话。 */
  writeChapters(chapterIds: readonly string[], review: boolean, onEnd?: (summary: string) => void): string | null | Promise<string | null>;
  reviewChapters(chapterIds: readonly string[], onEnd?: (summary: string) => void): string | null;
  /** 是否已有一次推演在后台推进（同一时间只推进一次）。 */
  simulating(): boolean;
  /** 后台写作正在写与排着的章节：助手不直接写、也不回退它们（不然轮到它时会互相当成作者改了正文而停下）。 */
  writing(): readonly string[];
  /** 在后台连续推进这次推演，直到结束、等待作者、暂停或被停下。返回 null 表示已经开始推进，否则是原因。 */
  simulate(runId: string, sceneId: string): string | null;
  /** 停下后台的写作、依次审核、推演或写作工作流；返回说明（停下了什么，或没有在进行的）。 */
  stop(what: 'writing' | 'review' | 'simulation' | 'workflow' | 'all'): string;
  /**
   * 在后台推进一次写作工作流（到需要作者、出错、预算用完或做完为止）；onEnd 给出停在哪里的一句话。
   * 返回 null 表示已经开始推进，否则是原因（例如已有一个在推进）。
   */
  workflow(runId: string, onEnd?: (summary: string) => void): string | null;
  /**
   * 在后台做一件单章的事（写手写章、审核、写手修订），登记为任务；work 收到任务的取消信号与流式回调。
   * 排上返回 null，否则是没排上的原因。写章与修订期间这一章只读。
   */
  run(job: BackgroundJob): Promise<string | null>;
};

export type BackgroundJob = {
  readonly kind: 'writing' | 'review' | 'revise';
  /** 任务页显示的名称。 */
  readonly title: string;
  readonly chapterId: string;
  readonly work: (options: CallOptions) => Promise<Outcome>;
};

/** 动作执行时能用到的界面回调：取消信号、要界面做的事、耗时动作的进展、作者选中的文字与后台任务。 */
export type ToolEvents = CallOptions & {
  readonly onEffect?: (effect: AssistantEffect) => void;
  /** 正在执行的耗时动作（写手写章、生成计划、审核等）的进展；动作做完时为 null。 */
  readonly onProgress?: (note: string | null) => void;
  /** 作者选中的文字；没有选中时为 null。 */
  readonly selection?: AssistantSelection | null;
  /** 后台任务；没有时（例如测试与命令行）后台动作说明不能用，单章的写作、审核与修订就地等它做完。 */
  readonly background?: BackgroundJobs;
  /** 交给用例的调用选项；没有给出时只带取消信号（在后台做的事用任务的取消信号与用量回调）。 */
  readonly callOptions?: CallOptions;
  /**
   * 排上一批后台写作或审核时取一个回调，这一批结束时用它给出怎样结束的一句话（AI 助手放进之后的现状）。
   * 排上时才取：回调记住排上时打开的是哪部作品。
   */
  readonly backgroundReport?: () => (summary: string) => void;
};

/** 作品的现状（章节、回收站与卷），由应用服务的 reloadWork 给出。 */
export type WorkSnapshot = {
  readonly project: { readonly title: string; readonly genre: string; readonly synopsis: string; readonly outline: string };
  readonly chapters: readonly Chapter[];
  readonly trashed: readonly Chapter[];
  readonly volumes: readonly Volume[];
};

/** 写作工作流的用例（B78）；没有时（例如较早的试用脚本）工作流动作说明不能用。 */
export type AssistantWorkflows = Pick<WorkflowUseCases, 'workflowCatalog' | 'quoteWorkflow' | 'startWorkflow' | 'listWorkflows' | 'workflowRun' | 'adoptWorkflowStep'>;

// 提示词里可发起的工作流与应用层命令表的键须相同：两边漏了一项都会在这里报错。
const SAME_WORKFLOWS: [WorkflowKey, (typeof ASSISTANT_WORKFLOWS)[number]] extends [(typeof ASSISTANT_WORKFLOWS)[number], WorkflowKey] ? true : never = true;
void SAME_WORKFLOWS;

/** 助手用到的现有用例（由应用服务提供）。 */
export type AssistantHost = {
  readonly workflows?: AssistantWorkflows;
  loadLibrary(): Promise<Result<{ readonly works: readonly { readonly id: string; readonly title: string; readonly archived: boolean; readonly missing: boolean }[] }, AppError>>;
  createWork(title: string): Promise<Result<unknown, AppError>>;
  openWork(id: string): Promise<Result<unknown, AppError>>;
  reloadWork(): Promise<Result<WorkSnapshot, AppError>>;
  updateWorkInfo(patch: ProjectPatch): Promise<Result<unknown, AppError>>;
  createVolume(title: string, after?: string): Promise<Result<{ readonly volumes: readonly Volume[] }, AppError>>;
  updateVolume(volume: Volume, fields: { readonly title: string; readonly summary: string }): Promise<Result<unknown, AppError>>;
  moveVolume(volume: Volume, after: string | null): Promise<Result<unknown, AppError>>;
  deleteVolume(volume: Volume): Promise<Result<unknown, AppError>>;
  createChapter(title: string, after?: string, volumeId?: string | null): Promise<Result<{ readonly chapters: readonly Chapter[] }, AppError>>;
  renameChapter(chapter: Chapter, title: string): Promise<Result<unknown, AppError>>;
  updateChapterNotes(chapter: Chapter, notes: { readonly summary: string; readonly notes: string }): Promise<Result<unknown, AppError>>;
  moveChapter(chapter: Chapter, target: ChapterTarget): Promise<Result<unknown, AppError>>;
  trashChapter(chapter: Chapter): Promise<Result<unknown, AppError>>;
  restoreChapter(chapter: Chapter): Promise<Result<unknown, AppError>>;
  createSnapshot(chapterId: string): Promise<Result<{ readonly id: string }, AppError>>;
  restoreSnapshot(snapshotId: string): Promise<Result<unknown, AppError>>;
  openChapter(chapterId: string): Promise<Result<{ readonly saved: readonly { readonly id: string; readonly text: string }[]; readonly draft: unknown }, AppError>>;
  search(query: string): Promise<Result<SearchResult, AppError>>;
  listEntities(): Promise<Result<Entity[], AppError>>;
  createEntity(kind: EntityKind, name: string, id?: string): Promise<Result<{ readonly created: Entity }, AppError>>;
  updateEntity(entity: Entity, patch: EntityPatch): Promise<Result<unknown, AppError>>;
  deleteEntity(entity: Entity): Promise<Result<unknown, AppError>>;
  listFacts(): Promise<Result<Fact[], AppError>>;
  createFact(input: FactInput, status: FactStatus): Promise<Result<unknown, AppError>>;
  deleteFact(fact: Fact): Promise<Result<unknown, AppError>>;
  relationsView(): Promise<Result<RelationsView, AppError>>;
  listWritingSkills(): Promise<Result<SkillsView, AppError>>;
  addCustomSkill(name: string, instruction: string, description?: string, key?: string, stages?: readonly SkillStage[]): Promise<Result<SkillsView, AppError>>;
  updateWritingSkill(skill: SkillsView['skills'][number]['skill'], patch: { readonly enabled?: boolean; readonly instruction?: string }): Promise<Result<SkillsView, AppError>>;
  setAvoidPhrases(phrases: readonly string[] | null): Promise<Result<SkillsView, AppError>>;
  deleteCustomSkill(skill: SkillsView['skills'][number]['skill']): Promise<Result<unknown, AppError>>;
  addRelationship(fields: RelationshipFields): Promise<Result<RelationsView, AppError>>;
  updateRelationship(relationship: RelationsView['relationships'][number], fields: RelationshipFields): Promise<Result<RelationsView, AppError>>;
  deleteRelationship(relationship: RelationsView['relationships'][number]): Promise<Result<RelationsView, AppError>>;
  planningView(): Promise<Result<PlanningView, AppError>>;
  savePlan(chapterId: string, fields: PlanFields): Promise<Result<unknown, AppError>>;
  deletePlan(chapterId: string): Promise<Result<unknown, AppError>>;
  draftPlans(request: { readonly chapterCount: number; readonly wordsPerChapter: number }, options?: CallOptions): Promise<Result<PlanDraftData, AppError>>;
  applyPlanDraft(draft: PlanDraftData): Promise<Result<AppliedDraft, AppError>>;
  writeChapter(chapterId: string, events?: WriterEvents): Promise<Result<WriterOutcome, AppError>>;
  rollbackWriter(chapterId: string): Promise<Result<unknown, AppError>>;
  buildMemory(chapterId: string, options?: CallOptions): Promise<Result<unknown, AppError>>;
  reviewChapter(chapterId: string, options?: CallOptions): Promise<Result<ReviewOutcome, AppError>>;
  addForeshadow(fields: ForeshadowFields): Promise<Result<unknown, AppError>>;
  updateForeshadow(foreshadow: Foreshadow, fields: ForeshadowFields): Promise<Result<unknown, AppError>>;
  deleteForeshadow(foreshadow: Foreshadow): Promise<Result<unknown, AppError>>;
  reviewIssues(chapterId: string): Promise<Result<ReviewIssueView[], AppError>>;
  resolveIssue(issueId: string, status: 'ignored' | 'fixed'): Promise<Result<ReviewIssueView[], AppError>>;
  reviseIssue(issueId: string, options?: CallOptions): Promise<Result<RevisionOutcome, AppError>>;
  issueChapterId(issueId: string): Promise<Result<string | null, AppError>>;
  exportText(kind: 'txt' | 'md', chapterId?: string): Promise<Result<boolean, AppError>>;
  runSelectionOperation(
    request: { readonly chapterId: string; readonly selection: EditorSelection | null; readonly operation: SelectionOperation; readonly instruction: string; readonly overrides: ContextOverrides },
    options?: CallOptions,
  ): Promise<Result<{ readonly candidate: { readonly id: string } | null }, AppError>>;
  listSimScenes(): Promise<Result<SimScene[], AppError>>;
  listSimRuns(sceneId: string): Promise<Result<SimRun[], AppError>>;
  draftSimScene(description: string, options?: CallOptions): Promise<Result<SceneDraft, AppError>>;
  saveSimScene(id: string | null, fields: SimSceneFields): Promise<Result<SimScene, AppError>>;
  startSimRun(sceneId: string, options: SimRunOptions): Promise<Result<SimRunView, AppError>>;
  simRunStatus(runId: string): Promise<Result<SimRunView, AppError>>;
  simRunDetail(runId: string): Promise<Result<SimRunDetail, AppError>>;
  simRunEvents(runId: string): Promise<Result<readonly StoredEvent[], AppError>>;
  draftBeatSheet(runId: string, request: BeatSheetRequest, options?: CallOptions): Promise<Result<BeatSheetView, AppError>>;
  narrateBeatSheet(id: string, chapterId: string, options?: CallOptions): Promise<Result<{ readonly id: string }, AppError>>;
};

/** 一个动作的结果：成功与否，以及告诉模型（也显示给作者）的说明。 */
export type Outcome = { readonly ok: boolean; readonly detail: string };
const done = (detail: string): Outcome => ({ ok: true, detail });
const failed = (detail: string): Outcome => ({ ok: false, detail });

/** 推演的全局概要最多给出的字数：太长时略去前面的回合。 */
const SIM_SUMMARY_LIMIT = 6_000;
/** list_simulations 最多列出的场景数，与每个场景最多列出的推演次数。 */
const LISTED_SCENES = 20;
const LISTED_RUNS = 5;
/** 生成的场景没有给回合上限时用的回合数（与推演页一致）。 */
const DEFAULT_SIM_ROUNDS = 8;
const PROTOCOL_LABEL = { simultaneous: '同时行动', turn_based: '轮流对话' } as const;

/** 读一章时最多给出的字数：太长时给开头与结尾。 */
const READ_LIMIT = 6_000;
/** 作品信息（简介、大纲、卷简介、人物关系）最多给出的字数。 */
const WORK_INFO_LIMIT = 20_000;
/** 审核结果在对话里列出的问题数。 */
const LISTED_ISSUES = 6;
/** list_review_issues 一次最多列出的问题数，与全书时最多看的章数。 */
const LISTED_PENDING = 30;
const ISSUE_CHAPTERS = 10;
/** “无”“不限”或空串表示清除章节。 */
const CLEARS = new Set(['', '无', '不限', '清除']);
const UNVOLUMED = '未分卷';

const SEVERITY_LABEL = { high: '严重', medium: '一般', low: '轻微' } as const;
const EDIT_LABEL = { rewrite: '改写', expand: '扩写', shorten: '缩写', polish: '润色' } as const;

/** 按标识或名称找一项：标识相同、名称相同、名称包含（只有一项时）；找不到或有几项对得上时说明。 */
export function pick<T extends { readonly id: string }>(items: readonly T[], ref: string, names: (t: T) => readonly string[], what: string): Result<T, string> {
  const key = ref.trim();
  const byId = items.find((t) => t.id === key);
  if (byId !== undefined) return ok(byId);
  const exact = items.filter((t) => names(t).some((n) => n.trim() === key));
  if (exact.length === 1) return ok(exact[0]!);
  const loose = exact.length > 1 ? exact : items.filter((t) => names(t).some((n) => n.includes(key) || (key.length >= 2 && key.includes(n.trim()) && n.trim().length >= 2)));
  if (loose.length === 1) return ok(loose[0]!);
  if (loose.length === 0) return err(`找不到${what}“${key}”`);
  return err(`有几个${what}都对得上“${key}”：${loose.slice(0, 6).map((t) => `${names(t)[0] ?? ''}[${t.id}]`).join('、')}，请用标识指明`);
}

/** 用例的错误换成告诉模型的说明。 */
export function describeForModel(e: AppError): string {
  if (e.code === 'settings') return e.detail;
  if (e.code === 'repo') {
    const r = e.error;
    if (r.code === 'locked') return '这是锁定设定，作者解锁后才能修改或删除';
    if (r.code === 'invalid') return r.detail;
    if (r.code === 'conflict') return '已在别处修改，请重试';
    if (r.code === 'in_use') return '还有事实、章节计划或故事事件用到它，不能删除';
    if (r.code === 'not_found') return '找不到这一项';
    return '保存失败';
  }
  if (e.code === 'no_work') return '还没有打开作品：先新建或打开一部作品';
  return e.code;
}

const failWith = (e: AppError): Outcome => failed(describeForModel(e));

/** 一条审核问题读成一行（带标识，供 resolve_review_issue 与 revise_review_issue 引用）。 */
const issueLine = (i: ReviewIssueView): string =>
  `- [${i.id}] ${SEVERITY_LABEL[i.severity]}：${i.description}${i.suggestion === '' ? '' : `（建议：${i.suggestion}）`}${i.anchor.quote === '' ? '' : `；原文：“${clip(i.anchor.quote, 60).text}”`}`;

/** 一条伏笔读成一行。 */
const foreshadowLine = (f: Foreshadow, titleOf: ReadonlyMap<string, string>): string => {
  const at = (id: string | null) => (id === null ? '未定' : `《${titleOf.get(id) ?? id}》`);
  return `- [${f.id}] ${f.title}（${FORESHADOW_STATUS_LABEL[f.status]}；埋设 ${at(f.plantChapterId)}，回收 ${at(f.payoffChapterId)}）：${f.content}${f.reveal.trim() === '' ? '' : `；揭晓前不得说破：${f.reveal}`}`;
};
/** 章节名列出前几个，太多时省略。 */
const titles = (chapters: readonly Chapter[]): string =>
  chapters.length <= 6 ? chapters.map((c) => `《${c.title}》`).join('') : `${chapters.slice(0, 3).map((c) => `《${c.title}》`).join('')}……${chapters.slice(-2).map((c) => `《${c.title}》`).join('')}`;

/** 关系读成一句话（给模型看的结果说明）。 */
const relationText = (r: { readonly fromId: string; readonly toId: string; readonly label: string; readonly mutual: boolean }, nameOf: ReadonlyMap<string, string>) =>
  r.mutual ? `${nameOf.get(r.fromId) ?? ''}与${nameOf.get(r.toId) ?? ''}：${r.label}` : `${nameOf.get(r.fromId) ?? ''}是${nameOf.get(r.toId) ?? ''}的${r.label}`;

/** 作者偏好存为一项自定义写作技能（SKILL.md）：写手写每一章、生成作品骨架与章节计划时都带上（B75）。 */
export const PREFERENCES_KEY = 'author-preferences';
const PREFERENCES_NAME = '作者偏好';
const PREFERENCES_DESCRIPTION = '作者明确说过的偏好与禁忌，规划与写每一章时都遵守';
const PREFERENCES_STAGES: readonly SkillStage[] = ['planning', 'writing'];

/** 偏好技能的指令里一行一条（去掉列表符号）。 */
export const preferenceLines = (instruction: string): string[] =>
  instruction
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l !== '');

/** 太长的文字只留开头与结尾。 */
export const clip = (text: string, limit: number): { readonly text: string; readonly clipped: boolean } =>
  text.length <= limit ? { text, clipped: false } : { text: `${text.slice(0, limit / 2)}\n……\n${text.slice(-limit / 2)}`, clipped: true };

/** 动作执行的环境：现有的用例、作品库、界面回调，以及按名称找卷、章节与设定。 */
export type ToolEnv = {
  readonly host: AssistantHost;
  readonly project: () => SqlPort | null;
  readonly events: ToolEvents;
  readonly work: () => Promise<Result<WorkSnapshot, AppError>>;
  readonly findChapter: (ref: string) => Promise<Result<Chapter, string>>;
  readonly findVolume: (ref: string) => Promise<Result<Volume, string>>;
  readonly findEntity: (ref: string) => Promise<Result<Entity, string>>;
  readonly hasPlans: () => Promise<boolean>;
  /** 告诉界面作品内容变了。 */
  readonly changed: () => void;
  /** 交给耗时用例的调用选项（作者停止时取消）。 */
  readonly call: () => CallOptions;
  /** 撤销上一轮的改动（由对话循环提供）。 */
  readonly undoLastTurn?: () => Promise<Outcome>;
  /**
   * 只在 f 执行期间记下对作品的改动（撤销用）。先调用模型、再写入作品的动作用它包住写入的那一步：
   * 等模型的时候作者在界面上做的修改不算助手的改动。不用它的动作，整个执行期间的改动都记下。
   */
  readonly recordChanges?: <T>(f: () => Promise<T>) => Promise<T>;
  /** 撤销上一轮会回退的正文（写手写章、写手修订）的说明；没有时为 null。撤销正文要先请作者确认。 */
  readonly undoTextPreview?: () => string | null;
};

export function toolEnv(
  host: AssistantHost,
  project: () => SqlPort | null,
  events: ToolEvents,
  undoLastTurn?: () => Promise<Outcome>,
  undoTextPreview?: () => string | null,
): ToolEnv {
  const work = () => host.reloadWork();
  return {
    ...(undoLastTurn !== undefined && { undoLastTurn }),
    ...(undoTextPreview !== undefined && { undoTextPreview }),
    host,
    project,
    events,
    work,
    async findChapter(ref) {
      const w = await work();
      return w.ok ? pick(w.value.chapters, ref, (c) => [c.title], '章节') : err(describeForModel(w.error));
    },
    async findVolume(ref) {
      const w = await work();
      return w.ok ? pick(w.value.volumes, ref, (v) => [v.title], '卷') : err(describeForModel(w.error));
    },
    async findEntity(ref) {
      const list = await host.listEntities();
      return list.ok ? pick(list.value, ref, (e) => [e.name, ...e.aliases], '设定') : err(describeForModel(list.error));
    },
    async hasPlans() {
      const port = project();
      if (port === null) return false;
      const plans = await listChapterPlans(port);
      return plans.ok && plans.value.length > 0;
    },
    changed: () => events.onEffect?.({ kind: 'changed' }),
    call: () => events.callOptions ?? (events.signal === undefined ? {} : { signal: events.signal }),
  };
}

/**
 * 关系适用的章节范围：给出章节时按名称或标识找，“不限”表示取消限制，null 表示不改（新建时即不限）。
 */
async function chapterRange(
  env: ToolEnv,
  from: string | null,
  to: string | null,
  current: { readonly from: string | null; readonly to: string | null },
): Promise<Result<{ readonly from: string | null; readonly to: string | null }, string>> {
  const resolve = async (ref: string | null, now: string | null): Promise<Result<string | null, string>> => {
    if (ref === null) return ok(now);
    if (ref.trim() === '不限' || ref.trim() === '') return ok(null);
    const c = await env.findChapter(ref);
    return c.ok ? ok(c.value.id) : c;
  };
  const f = await resolve(from, current.from);
  if (!f.ok) return f;
  const t = await resolve(to, current.to);
  if (!t.ok) return t;
  return ok({ from: f.value, to: t.value });
}

/** 场景配置里的角色（键与名字）；配置不合格时尽量读出能读的。 */
function sceneActors(config: Readonly<Record<string, unknown>>): { readonly id: string; readonly name: string }[] {
  const actors = config['actors'];
  if (!Array.isArray(actors)) return [];
  return actors.flatMap((a: unknown) => {
    if (a === null || typeof a !== 'object') return [];
    const x = a as Record<string, unknown>;
    return typeof x['id'] === 'string' ? [{ id: x['id'], name: typeof x['name'] === 'string' ? x['name'] : x['id'] }] : [];
  });
}

const actorList = (actors: readonly { readonly id: string; readonly name: string }[]) => actors.map((a) => `${a.name}（${a.id}）`).join('、');

/** 推演的状态读成一句话。 */
function runState(view: SimRunView): string {
  const { run } = view;
  const reason =
    run.status === 'ended'
      ? `（${SIM_END_LABEL[view.endReason ?? run.endReason ?? ''] ?? view.endReason ?? ''}）`
      : run.status === 'paused'
        ? `（${SIM_PAUSE_LABEL[view.pause?.reason ?? run.pauseReason ?? ''] ?? ''}${view.pause?.detail === undefined ? '' : `：${view.pause.detail}`}）`
        : '';
  return `${SIM_RUN_STATUS_LABEL[run.status]}${reason}，第 ${view.round} 回合`;
}

/** 按标识找推演；给的是场景（标识或场景名）时取这个场景最近的一次。 */
async function findRun(env: ToolEnv, ref: string): Promise<Result<SimRunView, string>> {
  const key = ref.trim();
  const direct = await env.host.simRunStatus(key);
  if (direct.ok) return ok(direct.value);
  if (direct.error.code !== 'not_found') return err(describeForModel(direct.error));
  const scenes = await env.host.listSimScenes();
  if (!scenes.ok) return err(describeForModel(scenes.error));
  const scene = pick(scenes.value, key, (x) => [x.title], '推演或推演场景');
  if (!scene.ok) return err(`${scene.error}（推演的标识见 list_simulations）`);
  const runs = await env.host.listSimRuns(scene.value.id);
  if (!runs.ok) return err(describeForModel(runs.error));
  const latest = runs.value[0];
  if (latest === undefined) return err(`场景“${scene.value.title}”还没有推演过；用 start_simulation 开始`);
  const view = await env.host.simRunStatus(latest.id);
  return view.ok ? ok(view.value) : err(describeForModel(view.error));
}

/** 已经结束的最后一个回合（写成正文只能写已经结束的回合）。 */
const lastEndedRound = (events: readonly StoredEvent[]): number =>
  events.reduce((n, e) => {
    const p = e.payload as RunEvent;
    return p.type === 'RoundEnded' ? Math.max(n, p.round) : n;
  }, 0);

/**
 * 一次推演的全局概要：每回合发生的事（谁做了什么、说了什么、看上去与听上去怎样）与此刻的局面。
 * 这是作者视角的全貌，只交给助手向作者汇报；写成正文另走 narrate_simulation（只用视角角色当时的认知，硬性规则 3）。
 */
function simSummary(detail: SimRunDetail): string {
  const rounds = detail.data?.rounds ?? [];
  const blocks = rounds.map((r) => {
    const lines = r.occurrences.map((o) => {
      const head = [o.actor ?? '', ACTION_LABELS[o.kind] ?? o.kind, o.item ?? '', o.target === null ? '' : `→ ${o.target}`].filter((x) => x !== '').join(' ');
      const where = o.zones.length === 0 ? '' : `（${o.zones.join(' → ')}）`;
      const speech = o.sentences.length === 0 ? '' : `：“${o.sentences.join('')}”`;
      const look = [o.visual ?? '', o.sound === null ? '' : `声音：${o.sound}`].filter((x) => x !== '').join('；');
      return `- ${head}${where}${speech}${look === '' ? '' : `；${look}`}`;
    });
    return `第 ${r.round} 回合：\n${lines.length === 0 ? '- 没有发生看得见的事' : lines.join('\n')}`;
  });
  let shown = blocks;
  let omitted = 0;
  while (shown.length > 1 && shown.join('\n').length > SIM_SUMMARY_LIMIT) {
    shown = shown.slice(1);
    omitted++;
  }
  const last = rounds.at(-1);
  const world =
    last === undefined
      ? ''
      : [
          `此刻的局面：${last.world.actors.map((a) => `${a.name}在${a.zone}${a.injury === '' || a.injury === 'none' ? '' : `，${INJURY_LABELS[a.injury] ?? a.injury}`}`).join('；')}`,
          last.world.items.length === 0 ? '' : `物品：${last.world.items.map((i) => `${i.name}在${i.where === '' ? '不明处' : i.where}`).join('；')}`,
        ]
          .filter((x) => x !== '')
          .join('\n');
  return [omitted > 0 ? `（前 ${omitted} 个回合略去）` : '', ...shown, world].filter((x) => x !== '').join('\n');
}

type ActionOf<K extends AssistantTool> = Extract<AssistantAction, { readonly tool: K }>;

/**
 * 动作的改动怎样撤销（assistant-undo.ts）：read 不改作品；work 改作品的结构化内容，执行前后各取现状、记下差别；
 * writer 是写手写章（撤销即回退写手写入）；revise 是写手修订（执行前存快照）；kept 的结果不在撤销范围，照旧保留
 * （新建的作品、候选稿、审核结果、长篇记忆、推演记录、导出的文件等）。
 */
export type UndoMode = 'read' | 'work' | 'writer' | 'revise' | 'kept';

/**
 * 须确认的动作：给作者看的说明，以及作者确认后执行的动作。说明里的那一项按确认时找到的为准：
 * 动作里的名称换成它的标识，作者确认之前改了名、又有了同名的，执行的仍是确认的那一项。
 */
export type Confirmation<K extends AssistantTool = AssistantTool> = { readonly summary: string; readonly action: ActionOf<K> };

/** 命令表的一项。confirm 给出时，返回非 null 的说明就先停下请作者确认（删除与覆盖类的动作）。 */
type Tool<K extends AssistantTool> = {
  readonly label: string;
  readonly undo: UndoMode;
  readonly confirm?: (action: ActionOf<K>, env: ToolEnv) => string | Confirmation<K> | null | Promise<string | Confirmation<K> | null>;
  readonly run: (action: ActionOf<K>, env: ToolEnv) => Promise<Outcome>;
};

const TOOLS: { readonly [K in AssistantTool]: Tool<K> } = {
  list_chapters: {
    label: '查看章节',
    undo: 'read',
    async run(action, env) {
      const work = await env.work();
      if (!work.ok) return failWith(work.error);
      const port = env.project();
      const lengths = port === null ? null : await chapterLengths(port);
      const lengthOf = new Map(lengths?.ok === true ? lengths.value.map((l) => [l.chapterId, l.length]) : []);
      let list = work.value.chapters;
      if (action.volume !== null) {
        if (action.volume.trim() === UNVOLUMED) list = list.filter((c) => c.volumeId === null);
        else {
          const v = pick(work.value.volumes, action.volume, (x) => [x.title], '卷');
          if (!v.ok) return failed(v.error);
          list = list.filter((c) => c.volumeId === v.value.id);
        }
      }
      const title = new Map(work.value.volumes.map((v) => [v.id, v.title]));
      return done(list.length === 0 ? '没有章节。' : list.map((c) => `[${c.id}] ${c.title}${c.volumeId === null ? '' : `（${title.get(c.volumeId) ?? ''}）`}，${lengthOf.get(c.id) ?? 0} 字`).join('\n'));
    },
  },
  get_work: {
    label: '查看作品信息',
    undo: 'read',
    async run(_action, env) {
      const work = await env.work();
      if (!work.ok) return failWith(work.error);
      const view = await env.host.relationsView();
      if (!view.ok) return failWith(view.error);
      const p = work.value.project;
      const nameOf = new Map(view.value.members.map((m) => [m.id, m.name]));
      const volumes = work.value.volumes.map((v) => `- [${v.id}] ${v.title}：${v.summary || '（没有简介）'}`);
      const relations = view.value.relationships.map((r) => `- [${r.id}] ${relationText(r, nameOf)}（${RELATION_CATEGORY_LABEL[r.category]}${r.secret ? '，隐秘' : ''}）`);
      const text = [
        `《${p.title}》${p.genre === '' ? '' : `（${p.genre}）`}`,
        `简介：${p.synopsis || '还没有'}`,
        `大纲：${p.outline || '还没有'}`,
        volumes.length === 0 ? '没有分卷。' : `分卷：\n${volumes.join('\n')}`,
        relations.length === 0 ? '没有人物关系。' : `人物关系（共 ${relations.length} 条）：\n${relations.join('\n')}`,
      ].join('\n');
      return done(clip(text, WORK_INFO_LIMIT).text);
    },
  },
  read_chapter: {
    label: '读章节',
    undo: 'read',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      const content = await env.host.openChapter(c.value.id);
      if (!content.ok) return failWith(content.error);
      const text = content.value.saved.map((p) => p.text).join('\n');
      if (text.trim() === '') return done(`《${c.value.title}》还没有正文。`);
      const shown = text.length <= READ_LIMIT ? text : `${text.slice(0, READ_LIMIT / 2)}\n……（中间省略 ${text.length - READ_LIMIT} 字）……\n${text.slice(-READ_LIMIT / 2)}`;
      return done(`《${c.value.title}》正文：\n${shown}`);
    },
  },
  search_text: {
    label: '查找正文',
    undo: 'read',
    async run(action, env) {
      const result = await env.host.search(action.query);
      if (!result.ok) return failWith(result.error);
      const hits = result.value.hits.slice(0, 20);
      if (hits.length === 0) return done(`没有找到“${action.query}”。`);
      return done(`${result.value.hits.length} 处${result.value.truncated ? '以上' : ''}：\n${hits.map((h) => `[${h.chapterId}] ${h.chapterTitle}：…${h.before}【${h.match}】${h.after}…`).join('\n')}`);
    },
  },
  get_entity: {
    label: '查看设定',
    undo: 'read',
    async run(action, env) {
      const e = await env.findEntity(action.entity);
      if (!e.ok) return failed(e.error);
      const x = e.value;
      const attributes = x.attributes.map((a) => `${a.label}：${a.value}`).join('；');
      return done(`[${x.id}] ${ENTITY_KIND_LABEL[x.kind]}：${x.name}${x.aliases.length > 0 ? `（别名：${x.aliases.join('、')}）` : ''}${x.locked ? '（锁定）' : ''}\n说明：${x.description || '无'}${attributes === '' ? '' : `\n属性：${attributes}`}`);
    },
  },
  list_facts: {
    label: '查看事实',
    undo: 'read',
    async run(action, env) {
      const facts = await env.host.listFacts();
      if (!facts.ok) return failWith(facts.error);
      let list = facts.value;
      if (action.about !== null) {
        const e = await env.findEntity(action.about);
        if (!e.ok) return failed(e.error);
        list = list.filter((f) => f.subjectIds.includes(e.value.id) || f.holderId === e.value.id);
      }
      const status = { candidate: '候选', confirmed: '已确认', needs_review: '待复核', rejected: '已驳回' } as const;
      return done(list.length === 0 ? '没有事实记录。' : list.slice(0, 50).map((f) => `[${f.id}] ${f.content}（${status[f.status]}）`).join('\n'));
    },
  },
  get_chapter_plan: {
    label: '查看章节计划',
    undo: 'read',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      const view = await env.host.planningView();
      if (!view.ok) return failWith(view.error);
      const plan = view.value.chapters.find((x) => x.chapter.id === c.value.id)?.plan ?? null;
      if (plan === null) return done(`《${c.value.title}》还没有章节计划。`);
      const entities = await env.host.listEntities();
      const name = new Map(entities.ok ? entities.value.map((e) => [e.id, e.name]) : []);
      return done(
        `《${c.value.title}》（${PLAN_STATUS_LABEL[plan.status]}）\n目标：${plan.goal}\n情节点：${plan.beats.join('；')}\n出场人物：${plan.castIds.map((id) => name.get(id) ?? id).join('、') || '无'}\n字数：${plan.targetWords ?? '未定'}`,
      );
    },
  },
  build_chapter_memory: {
    label: '整理长篇记忆',
    undo: 'kept',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      env.events.onProgress?.(`正在整理《${c.value.title}》的长篇记忆`);
      const built = await env.host.buildMemory(c.value.id, env.call());
      if (!built.ok) return failWith(built.error);
      env.changed();
      return done(`已按现在的正文重新整理《${c.value.title}》的长篇记忆；用 get_chapter_memory 查看。`);
    },
  },
  get_chapter_memory: {
    label: '查看长篇记忆',
    undo: 'read',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      const view = await env.host.planningView();
      if (!view.ok) return failWith(view.error);
      const memory = view.value.chapters.find((x) => x.chapter.id === c.value.id)?.memory ?? null;
      if (memory === null) return done(`《${c.value.title}》还没有长篇记忆（写手写完一章后自动整理；也可以在计划页生成）。`);
      const entities = await env.host.listEntities();
      const name = new Map(entities.ok ? entities.value.map((e) => [e.id, e.name]) : []);
      const foreshadow = new Map(view.value.foreshadows.map((f) => [f.id, f.title]));
      const cast = Object.entries(memory.castState).map(([id, s]) => `${name.get(id) ?? id}：${s}`);
      const progress = Object.entries(memory.foreshadowProgress).map(([id, s]) => `${foreshadow.get(id) ?? id}：${s}`);
      return done(
        [
          `《${c.value.title}》的长篇记忆${memory.status === 'stale' ? '（正文在整理之后改过，可能已经过时）' : ''}`,
          `梗概：${memory.summary}`,
          cast.length === 0 ? '' : `人物状态：${cast.join('；')}`,
          progress.length === 0 ? '' : `伏笔进展：${progress.join('；')}`,
          memory.openThreads.length === 0 ? '' : `章尾留给后面的事：${memory.openThreads.join('；')}`,
        ]
          .filter((l) => l !== '')
          .join('\n'),
      );
    },
  },
  list_foreshadows: {
    label: '查看伏笔账本',
    undo: 'read',
    async run(action, env) {
      const view = await env.host.planningView();
      if (!view.ok) return failWith(view.error);
      let list = view.value.foreshadows;
      if (action.chapter !== null) {
        const c = await env.findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        list = list.filter((f) => f.plantChapterId === c.value.id || f.payoffChapterId === c.value.id);
      }
      if (list.length === 0) return done(action.chapter === null ? '伏笔账本是空的。' : '没有在这一章埋设或回收的伏笔。');
      const titleOf = new Map(view.value.chapters.map((x) => [x.chapter.id, x.chapter.title]));
      const shown = new Set(list.map((f) => f.id));
      const suggestions = view.value.foreshadowSuggestions
        .filter((s) => shown.has(s.foreshadowId))
        .map((s) => {
          const name = list.find((f) => f.id === s.foreshadowId)?.title ?? '';
          const at = titleOf.get(s.chapterId) ?? '';
          return s.progress === null
            ? `- “${name}”或许可以标为${FORESHADOW_STATUS_LABEL[s.status]}：《${at}》已经写完，但长篇记忆里没有提到它，先读正文确认真的写到了`
            : `- “${name}”可以标为${FORESHADOW_STATUS_LABEL[s.status]}（《${at}》的长篇记忆：${s.progress}）`;
        });
      // 建议只按章节写没写完给出，正文里不一定真的埋下或回收了（试用中写手就漏埋过）。
      return done(`${list.map((f) => foreshadowLine(f, titleOf)).join('\n')}${suggestions.length === 0 ? '' : `\n状态的建议（确认正文写到了、作者同意后用 update_foreshadow 改）：\n${suggestions.join('\n')}`}`);
    },
  },
  list_review_issues: {
    label: '查看审核问题',
    undo: 'read',
    async run(action, env) {
      const view = await env.host.planningView();
      if (!view.ok) return failWith(view.error);
      let chapters: readonly Chapter[];
      if (action.chapter !== null) {
        const c = await env.findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        chapters = [c.value];
      } else {
        chapters = view.value.chapters.filter((x) => x.pendingIssues > 0).map((x) => x.chapter);
        if (chapters.length === 0) return done('没有待处理的审核问题。');
      }
      const lines: string[] = [];
      let listed = 0;
      let total = 0;
      for (const [i, c] of chapters.entries()) {
        if (i >= ISSUE_CHAPTERS) {
          lines.push(`……还有 ${chapters.length - ISSUE_CHAPTERS} 章有待处理的问题（${titles(chapters.slice(ISSUE_CHAPTERS))}），指明章节再看`);
          break;
        }
        const issues = await env.host.reviewIssues(c.id);
        if (!issues.ok) return failWith(issues.error);
        total += issues.value.length;
        if (issues.value.length === 0) {
          if (action.chapter !== null) lines.push(`《${c.title}》没有待处理的审核问题${view.value.chapters.find((x) => x.chapter.id === c.id)?.plan?.status === 'reviewed' ? '' : '（这一章可能还没有审核过）'}。`);
          continue;
        }
        const room = Math.max(0, LISTED_PENDING - listed);
        lines.push(`《${c.title}》${issues.value.length} 条：`, ...issues.value.slice(0, room).map(issueLine));
        if (issues.value.length > room) lines.push('……');
        listed += Math.min(room, issues.value.length);
      }
      return done(action.chapter === null ? `共 ${total} 条待处理（严重的在前）：\n${lines.join('\n')}` : lines.join('\n'));
    },
  },
  list_skills: {
    label: '查看写作技能',
    undo: 'read',
    async run(action, env) {
      const view = await env.host.listWritingSkills();
      if (!view.ok) return failWith(view.error);
      const list = view.value.skills.filter((s) => action.stage === null || s.skill.stages.includes(action.stage));
      if (list.length === 0) return done('没有写作技能。');
      return done(
        list
          .map((s) => `- ${s.skill.name}（${s.skill.stages.map((x) => SKILL_STAGE_LABEL[x]).join('、')}；${s.skill.enabled ? '启用' : '停用'}${s.builtinText === null ? '；自定义' : ''}）：${clip(s.description, 120).text}`)
          .join('\n'),
      );
    },
  },
  create_work: {
    label: '新建作品',
    undo: 'kept',
    async run(action, env) {
      const created = await env.host.createWork(action.title);
      if (!created.ok) return failWith(created.error);
      const patch: { -readonly [K in keyof ProjectPatch]: ProjectPatch[K] } = {};
      if (action.genre !== null) patch.genre = action.genre;
      if (action.synopsis !== null) patch.synopsis = action.synopsis;
      if (action.outline !== null) patch.outline = action.outline;
      if (Object.keys(patch).length > 0) {
        const info = await env.host.updateWorkInfo(patch);
        if (!info.ok) return failWith(info.error);
      }
      env.events.onEffect?.({ kind: 'work_opened' });
      return done(`已新建并打开《${action.title.trim()}》。`);
    },
  },
  open_work: {
    label: '打开作品',
    undo: 'read',
    async run(action, env) {
      const library = await env.host.loadLibrary();
      if (!library.ok) return failWith(library.error);
      const w = pick(
        library.value.works.filter((x) => !x.missing),
        action.work,
        (x) => [x.title],
        '作品',
      );
      if (!w.ok) return failed(w.error);
      const opened = await env.host.openWork(w.value.id);
      if (!opened.ok) return failWith(opened.error);
      env.events.onEffect?.({ kind: 'work_opened' });
      return done(`已打开《${w.value.title}》。`);
    },
  },
  update_work: {
    label: '修改作品信息',
    undo: 'work',
    confirm: async (action, env) => {
      if (action.outline === null) return null;
      const w = await env.host.reloadWork();
      const current = w.ok ? w.value.project.outline.trim() : '';
      return current !== '' && current !== action.outline.trim() ? '用新写的大纲替换现在的作品大纲（原来的大纲不保留）' : null;
    },
    async run(action, env) {
      const patch: { -readonly [K in keyof ProjectPatch]: ProjectPatch[K] } = {};
      if (action.title !== null) patch.title = action.title;
      if (action.genre !== null) patch.genre = action.genre;
      if (action.synopsis !== null) patch.synopsis = action.synopsis;
      if (action.outline !== null) patch.outline = action.outline;
      if (Object.keys(patch).length === 0) return failed('没有要改的内容');
      const info = await env.host.updateWorkInfo(patch);
      if (!info.ok) return failWith(info.error);
      env.changed();
      return done(`已修改作品信息：${Object.keys(patch).map((k) => ({ title: '作品名', genre: '类型', synopsis: '简介', outline: '大纲' })[k] ?? k).join('、')}。`);
    },
  },
  create_volume: {
    label: '新建卷',
    undo: 'work',
    async run(action, env) {
      let after: string | undefined;
      if (action.after !== null) {
        const v = await env.findVolume(action.after);
        if (!v.ok) return failed(v.error);
        after = v.value.id;
      }
      const before = await env.work();
      const known = new Set(before.ok ? before.value.volumes.map((v) => v.id) : []);
      const created = await env.host.createVolume(action.title, after);
      if (!created.ok) return failWith(created.error);
      const volume = created.value.volumes.find((v) => !known.has(v.id));
      if (volume !== undefined && action.summary !== null && action.summary.trim() !== '') {
        const described = await env.host.updateVolume(volume, { title: volume.title, summary: action.summary });
        if (!described.ok) return failWith(described.error);
      }
      env.changed();
      return done(`已新建卷“${action.title.trim()}”${volume === undefined ? '' : `[${volume.id}]`}。`);
    },
  },
  update_volume: {
    label: '修改卷',
    undo: 'work',
    async run(action, env) {
      const v = await env.findVolume(action.volume);
      if (!v.ok) return failed(v.error);
      const updated = await env.host.updateVolume(v.value, { title: action.title ?? v.value.title, summary: action.summary ?? v.value.summary });
      if (!updated.ok) return failWith(updated.error);
      env.changed();
      return done(`已修改卷“${action.title ?? v.value.title}”。`);
    },
  },
  move_volume: {
    label: '调整卷的顺序',
    undo: 'work',
    async run(action, env) {
      const v = await env.findVolume(action.volume);
      if (!v.ok) return failed(v.error);
      let after: string | null = null;
      if (action.after !== null) {
        const a = await env.findVolume(action.after);
        if (!a.ok) return failed(a.error);
        after = a.value.id;
      }
      const moved = await env.host.moveVolume(v.value, after);
      if (!moved.ok) return failWith(moved.error);
      env.changed();
      return done(`已调整“${v.value.title}”的顺序。`);
    },
  },
  delete_volume: {
    label: '删除卷',
    undo: 'work',
    // 找不到时不必确认：执行时照样找不到，原因告诉模型。
    confirm: async (action, env) => {
      const v = await env.findVolume(action.volume);
      return v.ok ? { summary: `删除卷“${v.value.title}”`, action: { ...action, volume: v.value.id } } : null;
    },
    async run(action, env) {
      const v = await env.findVolume(action.volume);
      if (!v.ok) return failed(v.error);
      const deleted = await env.host.deleteVolume(v.value);
      if (!deleted.ok) return failWith(deleted.error);
      env.changed();
      return done(`已删除卷“${v.value.title}”。`);
    },
  },
  create_chapter: {
    label: '新建章节',
    undo: 'work',
    async run(action, env) {
      const before = await env.work();
      if (!before.ok) return failWith(before.error);
      const known = new Set(before.value.chapters.map((c) => c.id));
      let created;
      if (action.after !== null) {
        const a = pick(before.value.chapters, action.after, (c) => [c.title], '章节');
        if (!a.ok) return failed(a.error);
        created = await env.host.createChapter(action.title, a.value.id);
      } else if (action.volume !== null) {
        let volumeId: string | null = null;
        if (action.volume.trim() !== UNVOLUMED) {
          const v = pick(before.value.volumes, action.volume, (x) => [x.title], '卷');
          if (!v.ok) return failed(v.error);
          volumeId = v.value.id;
        }
        created = await env.host.createChapter(action.title, undefined, volumeId);
      } else {
        created = await env.host.createChapter(action.title);
      }
      if (!created.ok) return failWith(created.error);
      const chapter = created.value.chapters.find((c) => !known.has(c.id));
      env.changed();
      return done(`已新建章节《${action.title.trim()}》${chapter === undefined ? '' : `[${chapter.id}]`}。`);
    },
  },
  update_chapter: {
    label: '修改章节',
    undo: 'work',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      let chapter = c.value;
      if (action.title !== null && action.title.trim() !== chapter.title) {
        const renamed = await env.host.renameChapter(chapter, action.title);
        if (!renamed.ok) return failWith(renamed.error);
        const again = await env.findChapter(chapter.id);
        if (!again.ok) return failed(again.error);
        chapter = again.value;
      }
      if (action.summary !== null || action.notes !== null) {
        const noted = await env.host.updateChapterNotes(chapter, { summary: action.summary ?? chapter.summary, notes: action.notes ?? chapter.notes });
        if (!noted.ok) return failWith(noted.error);
      }
      env.changed();
      return done(`已修改《${chapter.title}》。`);
    },
  },
  move_chapter: {
    label: '移动章节',
    undo: 'work',
    async run(action, env) {
      const work = await env.work();
      if (!work.ok) return failWith(work.error);
      const c = pick(work.value.chapters, action.chapter, (x) => [x.title], '章节');
      if (!c.ok) return failed(c.error);
      let target: ChapterTarget;
      if (action.after !== null) {
        const a = pick(work.value.chapters, action.after, (x) => [x.title], '章节');
        if (!a.ok) return failed(a.error);
        target = { volumeId: a.value.volumeId, after: a.value.id };
      } else if (action.volume !== null) {
        let volumeId: string | null = null;
        if (action.volume.trim() !== UNVOLUMED) {
          const v = pick(work.value.volumes, action.volume, (x) => [x.title], '卷');
          if (!v.ok) return failed(v.error);
          volumeId = v.value.id;
        }
        const members = work.value.chapters.filter((x) => x.volumeId === volumeId && x.id !== c.value.id);
        target = { volumeId, after: members.at(-1)?.id ?? null };
      } else {
        return failed('请给出 after（移到哪一章之后）或 volume（移到哪一卷）');
      }
      const moved = await env.host.moveChapter(c.value, target);
      if (!moved.ok) return failWith(moved.error);
      env.changed();
      return done(`已移动《${c.value.title}》。`);
    },
  },
  trash_chapter: {
    label: '移入回收站',
    undo: 'work',
    confirm: async (action, env) => {
      const c = await env.findChapter(action.chapter);
      return c.ok ? { summary: `把“${c.value.title}”移入回收站`, action: { ...action, chapter: c.value.id } } : null;
    },
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      const trashed = await env.host.trashChapter(c.value);
      if (!trashed.ok) return failWith(trashed.error);
      env.changed();
      return done(`已把《${c.value.title}》移入回收站（可以恢复）。`);
    },
  },
  open_chapter: {
    label: '打开章节',
    undo: 'read',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      env.events.onEffect?.({ kind: 'open_chapter', chapterId: c.value.id });
      return done(`已打开《${c.value.title}》。`);
    },
  },
  create_entity: {
    label: '新建设定',
    undo: 'work',
    async run(action, env) {
      const created = await env.host.createEntity(action.kind, action.name);
      if (!created.ok) return failWith(created.error);
      const patch: { -readonly [K in keyof EntityPatch]: EntityPatch[K] } = {};
      if (action.description !== null) patch.description = action.description;
      if (action.aliases !== null) patch.aliases = action.aliases.map((a) => a.trim()).filter((a) => a !== '');
      if (Object.keys(patch).length > 0) {
        const described = await env.host.updateEntity(created.value.created, patch);
        if (!described.ok) return failWith(described.error);
      }
      env.changed();
      return done(`已新建${ENTITY_KIND_LABEL[action.kind]}“${action.name.trim()}”[${created.value.created.id}]。`);
    },
  },
  update_entity: {
    label: '修改设定',
    undo: 'work',
    async run(action, env) {
      const e = await env.findEntity(action.entity);
      if (!e.ok) return failed(e.error);
      if (e.value.locked) return failed(`“${e.value.name}”是锁定设定，作者解锁后才能修改`);
      const patch: { -readonly [K in keyof EntityPatch]: EntityPatch[K] } = {};
      if (action.name !== null) patch.name = action.name;
      if (action.description !== null) patch.description = action.description;
      if (action.aliases !== null) patch.aliases = action.aliases.map((a) => a.trim()).filter((a) => a !== '');
      if (Object.keys(patch).length === 0) return failed('没有要改的内容');
      const updated = await env.host.updateEntity(e.value, patch);
      if (!updated.ok) return failWith(updated.error);
      env.changed();
      return done(`已修改“${action.name ?? e.value.name}”。`);
    },
  },
  delete_entity: {
    label: '删除设定',
    undo: 'work',
    confirm: async (action, env) => {
      const e = await env.findEntity(action.entity);
      return e.ok ? { summary: `删除设定“${e.value.name}”（与它有关的人物关系也一并删除）`, action: { ...action, entity: e.value.id } } : null;
    },
    async run(action, env) {
      const e = await env.findEntity(action.entity);
      if (!e.ok) return failed(e.error);
      const deleted = await env.host.deleteEntity(e.value);
      if (!deleted.ok) return failWith(deleted.error);
      env.changed();
      return done(`已删除“${e.value.name}”。`);
    },
  },
  add_fact: {
    label: '记录事实',
    undo: 'work',
    async run(action, env) {
      let holderId: string | null = null;
      if (action.kind === 'belief') {
        if (action.holder === null) return failed('人物认知须给出持有人（holder）');
        const h = await env.findEntity(action.holder);
        if (!h.ok) return failed(h.error);
        holderId = h.value.id;
      }
      const subjectIds: string[] = [];
      const missing: string[] = [];
      for (const s of action.subjects ?? []) {
        const e = await env.findEntity(s);
        if (e.ok) subjectIds.push(e.value.id);
        else missing.push(s);
      }
      const input: FactInput = {
        kind: action.kind,
        holderId,
        subjectIds,
        content: action.content,
        modality: action.kind === 'belief' ? 'inferred' : null,
        confidence: null,
        validFromChapterId: null,
        validToChapterId: null,
        validFrom: null,
        validTo: null,
        basis: [],
      };
      // 助手记下的事实是候选，作者在事实页确认后才算数（硬性规则 21）。
      const created = await env.host.createFact(input, 'candidate');
      if (!created.ok) return failWith(created.error);
      env.changed();
      return done(`已记为候选事实，等作者在“事实”页确认${missing.length > 0 ? `；这些设定没有找到，没有关联：${missing.join('、')}` : ''}。`);
    },
  },
  add_relationship: {
    label: '建立人物关系',
    undo: 'work',
    async run(action, env) {
      const from = await env.findEntity(action.from);
      if (!from.ok) return failed(from.error);
      const to = await env.findEntity(action.to);
      if (!to.ok) return failed(to.error);
      const range = await chapterRange(env, action.validFrom, action.validTo, { from: null, to: null });
      if (!range.ok) return failed(range.error);
      const added = await env.host.addRelationship({
        fromId: from.value.id,
        toId: to.value.id,
        category: action.category,
        label: action.label,
        mutual: action.mutual,
        description: action.description ?? '',
        secret: action.secret,
        validFromChapterId: range.value.from,
        validToChapterId: range.value.to,
      });
      if (!added.ok) return failWith(added.error);
      env.changed();
      const created = added.value.relationships.at(-1);
      const nameOf = new Map([
        [from.value.id, from.value.name],
        [to.value.id, to.value.name],
      ]);
      return done(`已建立关系：${relationText({ fromId: from.value.id, toId: to.value.id, label: action.label.trim(), mutual: action.mutual }, nameOf)}${created === undefined ? '' : `[${created.id}]`}。`);
    },
  },
  update_relationship: {
    label: '修改人物关系',
    undo: 'work',
    async run(action, env) {
      const view = await env.host.relationsView();
      if (!view.ok) return failWith(view.error);
      const current = view.value.relationships.find((r) => r.id === action.relationship.trim());
      if (current === undefined) return failed(`找不到关系“${action.relationship}”：请用当前状态里关系前面的标识`);
      const range = await chapterRange(env, action.validFrom, action.validTo, { from: current.validFromChapterId, to: current.validToChapterId });
      if (!range.ok) return failed(range.error);
      const fields: RelationshipFields = {
        fromId: current.fromId,
        toId: current.toId,
        category: action.category ?? current.category,
        label: action.label ?? current.label,
        mutual: action.mutual ?? current.mutual,
        description: action.description ?? current.description,
        secret: action.secret ?? current.secret,
        validFromChapterId: range.value.from,
        validToChapterId: range.value.to,
      };
      const updated = await env.host.updateRelationship(current, fields);
      if (!updated.ok) return failWith(updated.error);
      env.changed();
      const nameOf = new Map(view.value.members.map((m) => [m.id, m.name]));
      return done(`已修改关系：${relationText(fields, nameOf)}（${RELATION_CATEGORY_LABEL[fields.category]}${fields.secret ? '，隐秘' : ''}）。`);
    },
  },
  delete_relationship: {
    label: '删除人物关系',
    undo: 'work',
    confirm: async (action, env) => {
      const view = await env.host.relationsView();
      const r = view.ok ? view.value.relationships.find((x) => x.id === action.relationship.trim()) : undefined;
      if (r === undefined || !view.ok) return `删除关系“${action.relationship}”`;
      return `删除关系“${relationText(r, new Map(view.value.members.map((m) => [m.id, m.name])))}”`;
    },
    async run(action, env) {
      const view = await env.host.relationsView();
      if (!view.ok) return failWith(view.error);
      const current = view.value.relationships.find((r) => r.id === action.relationship.trim());
      if (current === undefined) return failed(`找不到关系“${action.relationship}”：请用当前状态里关系前面的标识`);
      const deleted = await env.host.deleteRelationship(current);
      if (!deleted.ok) return failWith(deleted.error);
      env.changed();
      return done(`已删除关系：${relationText(current, new Map(view.value.members.map((m) => [m.id, m.name])))}。`);
    },
  },
  remember_preference: {
    label: '记下作者偏好',
    undo: 'work',
    async run(action, env) {
      const preference = action.preference.trim();
      if (preference === '') return failed('偏好是空的');
      const view = await env.host.listWritingSkills();
      if (!view.ok) return failWith(view.error);
      const current = view.value.skills.find((s) => s.skill.key === PREFERENCES_KEY)?.skill;
      const lines = current === undefined ? [] : preferenceLines(current.instruction);
      if (lines.includes(preference)) return done(`“${preference}”已经记下了。`);
      const instruction = [...lines, preference].map((l) => `- ${l}`).join('\n');
      const saved =
        current === undefined
          ? await env.host.addCustomSkill(PREFERENCES_NAME, instruction, PREFERENCES_DESCRIPTION, PREFERENCES_KEY, PREFERENCES_STAGES)
          : await env.host.updateWritingSkill(current, { instruction, enabled: true });
      if (!saved.ok) return failWith(saved.error);
      env.changed();
      return done(`已记下作者偏好“${preference}”，生成大纲与章节计划、写手写每一章都会遵守（在“写作技能”的“${PREFERENCES_NAME}”里可以修改）。`);
    },
  },
  add_avoid_phrases: {
    label: '加入规避词表',
    undo: 'work',
    async run(action, env) {
      const view = await env.host.listWritingSkills();
      if (!view.ok) return failWith(view.error);
      const current = view.value.avoidPhrases;
      const added = [...new Set(action.phrases.map((p) => p.trim()).filter((p) => p !== '' && !current.includes(p)))];
      if (added.length === 0) return done('这些说法已经在规避词表里了。');
      const saved = await env.host.setAvoidPhrases([...current, ...added]);
      if (!saved.ok) return failWith(saved.error);
      return done(`已把${added.map((p) => `“${p}”`).join('、')}加进规避词表，审核时会逐处标出。`);
    },
  },
  set_skill: {
    label: '启用或停用写作技能',
    undo: 'work',
    async run(action, env) {
      const view = await env.host.listWritingSkills();
      if (!view.ok) return failWith(view.error);
      const found = pick(
        view.value.skills.map((s) => ({ ...s, id: s.skill.id })),
        action.skill,
        (s) => [s.skill.name, s.skill.key],
        '写作技能',
      );
      if (!found.ok) return failed(found.error);
      const skill = found.value.skill;
      const state = action.enabled ? '启用' : '停用';
      if (skill.enabled === action.enabled) return done(`“${skill.name}”本来就是${state}的。`);
      const saved = await env.host.updateWritingSkill(skill, { enabled: action.enabled });
      if (!saved.ok) return failWith(saved.error);
      env.changed();
      return done(`已${state}写作技能“${skill.name}”${action.enabled ? '，之后写的章节会带上它' : '，之后写的章节不再带上它'}（已写的章节不变）。`);
    },
  },
  save_chapter_plan: {
    label: '保存章节计划',
    undo: 'work',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      const view = await env.host.planningView();
      if (!view.ok) return failWith(view.error);
      const current = view.value.chapters.find((x) => x.chapter.id === c.value.id)?.plan ?? null;
      const entities = await env.host.listEntities();
      const characters = entities.ok ? entities.value.filter((e) => e.kind === 'character') : [];
      const unmatched: string[] = [];
      const castIds = (action.cast ?? []).flatMap((n) => {
        const e = pick(characters, n, (x) => [x.name, ...x.aliases], '人物');
        if (!e.ok) unmatched.push(n);
        return e.ok ? [e.value.id] : [];
      });
      const saved = await env.host.savePlan(c.value.id, {
        goal: action.goal,
        castIds: action.cast === null ? (current?.castIds ?? []) : [...new Set(castIds)],
        beats: action.beats.map((b) => b.trim()).filter((b) => b !== ''),
        foreshadowPlant: current?.foreshadowPlant ?? [],
        foreshadowPayoff: current?.foreshadowPayoff ?? [],
        treatment: current?.treatment ?? '',
        targetWords: action.targetWords ?? current?.targetWords ?? null,
      });
      if (!saved.ok) return failWith(saved.error);
      env.changed();
      return done(`已保存《${c.value.title}》的章节计划${unmatched.length > 0 ? `；这些人物还没有人物卡片，没有加入出场人物：${unmatched.join('、')}` : ''}。`);
    },
  },
  plan_chapters: {
    label: '生成章节计划',
    undo: 'work',
    confirm: async (action, env) => ((await env.hasPlans()) ? `按大纲重新生成 ${action.count} 章的章节计划并采用（会覆盖已有的计划）` : null),
    async run(action, env) {
      env.events.onProgress?.(`正在按大纲生成 ${action.count} 章的章节计划`);
      const draft = await env.host.draftPlans({ chapterCount: action.count, wordsPerChapter: action.wordsPerChapter ?? 3000 }, env.call());
      if (!draft.ok) return failWith(draft.error);
      const apply = () => env.host.applyPlanDraft(draft.value);
      const applied = await (env.recordChanges === undefined ? apply() : env.recordChanges(apply));
      if (!applied.ok) return failWith(applied.error);
      env.changed();
      const volumes = new Set(draft.value.chapters.map((c) => (c.volume ?? '').trim()).filter((v) => v !== '')).size;
      return done(
        `已生成并采用 ${draft.value.chapters.length} 章的计划${volumes > 0 ? `，分 ${volumes} 卷` : ''}${applied.value.unmatchedCast.length > 0 ? `；这些人物还没有人物卡片：${applied.value.unmatchedCast.join('、')}` : ''}。`,
      );
    },
  },
  write_chapter: {
    label: '写手写章',
    undo: 'writer',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      if (env.events.background?.writing().includes(c.value.id) === true) return failed(`《${c.value.title}》排在后台的写作里：等它写完，或在“任务”里停下以后再说`);
      env.events.onEffect?.({ kind: 'open_chapter', chapterId: c.value.id });
      env.events.onProgress?.(`写手正在写《${c.value.title}》`);
      const written = await env.host.writeChapter(c.value.id, {
        ...env.call(),
        onSegment: (n, total) => {
          env.events.onProgress?.(`写手正在写《${c.value.title}》：已写 ${n}/${total} 段`);
          // 每写完一段就让界面重新载入这一章，作者看得到正文在长。
          env.events.onEffect?.({ kind: 'chapter_changed', chapterId: c.value.id });
        },
      });
      if (!written.ok) return failWith(written.error);
      env.changed();
      const o = written.value;
      if (o.status === 'written') {
        // 和成书进度一样，写完就整理长篇记忆：后面的章节靠它接上前文，问“前面写了什么”也靠它。
        env.events.onProgress?.(`正在整理《${c.value.title}》的长篇记忆`);
        const memory = await env.host.buildMemory(c.value.id, env.call());
        const note = memory.ok ? '，长篇记忆已整理' : `；长篇记忆没有整理成（${describeForModel(memory.error)}），可以在计划页重新生成`;
        return done(`写手已写完《${c.value.title}》${note}（写入前的正文在“版本快照”里，可以一键回退）。`);
      }
      return failed(`写手${o.status === 'cancelled' ? '被取消' : '中途停下'}：${o.reason ?? ''}（已写 ${o.segmentsDone}/${o.segmentsTotal} 段，可以接着写）`);
    },
  },
  write_chapters: {
    label: '交给写手依次写',
    undo: 'kept',
    async run(action, env) {
      const jobs = env.events.background;
      if (jobs === undefined) return failed('这里不能在后台写作；请用 write_chapter 一章一章地写');
      const view = await env.host.planningView();
      if (!view.ok) return failWith(view.error);
      const writable = (c: (typeof view.value.chapters)[number]) => c.plan !== null && (c.plan.status === 'todo' || c.plan.status === 'writing');
      let targets: readonly Chapter[];
      const skipped: string[] = [];
      if (action.chapters === null) {
        targets = view.value.chapters.filter(writable).map((c) => c.chapter);
      } else {
        const found: Chapter[] = [];
        for (const ref of action.chapters) {
          const c = await env.findChapter(ref);
          if (!c.ok) return failed(c.error);
          const entry = view.value.chapters.find((x) => x.chapter.id === c.value.id);
          if (entry?.plan === null || entry === undefined) skipped.push(`《${c.value.title}》还没有章节计划`);
          else if (!writable(entry)) skipped.push(`《${c.value.title}》已经写过`);
          else if (!found.some((f) => f.id === c.value.id)) found.push(c.value);
        }
        targets = found;
      }
      if (targets.length === 0) return failed(skipped.length > 0 ? `没有可以写的章节：${skipped.join('；')}` : '没有有计划、还没写完的章节；先用 plan_chapters 或 save_chapter_plan 做计划');
      const refused = await jobs.writeChapters(
        targets.map((c) => c.id),
        action.review,
        env.events.backgroundReport?.(),
      );
      if (refused !== null) return failed(refused);
      return done(
        `已排上：写手在后台依次写 ${targets.length} 章（${titles(targets)}），每章写完整理长篇记忆${action.review ? '并审核' : ''}。这一轮不用等，进度在成书进度与“任务”页；问进度时看当前状态里的“正在进行的任务”。${skipped.length > 0 ? `没排上的：${skipped.join('；')}。` : ''}`,
      );
    },
  },
  continue_chapter: {
    label: '续写',
    undo: 'kept',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      env.events.onProgress?.(`正在续写《${c.value.title}》`);
      const content = await env.host.openChapter(c.value.id);
      if (!content.ok) return failWith(content.error);
      const last = content.value.saved.at(-1);
      if (last === undefined || content.value.saved.every((p) => p.text.trim() === '')) return failed(`《${c.value.title}》还没有正文可以接着写；有章节计划时用 write_chapter 让写手写`);
      const end = { paragraphId: last.id, offset: last.text.length };
      const result = await env.host.runSelectionOperation(
        { chapterId: c.value.id, selection: { from: end, to: end }, operation: 'continue', instruction: action.instruction ?? '', overrides: { include: [], exclude: [] } },
        env.call(),
      );
      if (!result.ok) return failWith(result.error);
      if (result.value.candidate === null) return failed('续写没有完成');
      env.events.onEffect?.({ kind: 'show_candidates', chapterId: c.value.id });
      return done(`已为《${c.value.title}》续写一段，作为候选稿放在章节旁的“AI 写作”里，作者接受后才写入正文。`);
    },
  },
  edit_selection: {
    label: '修改选中的文字',
    undo: 'kept',
    async run(action, env) {
      const chosen = env.events.selection ?? null;
      if (chosen === null || chosen.text.trim() === '') return failed('作者没有在正文里选中文字：请作者先选中要改的那段，再说要怎么改');
      const c = await env.findChapter(chosen.chapterId);
      if (!c.ok) return failed(c.error);
      env.events.onProgress?.(`正在${EDIT_LABEL[action.operation]}选中的文字`);
      const result = await env.host.runSelectionOperation(
        { chapterId: chosen.chapterId, selection: chosen.range, operation: action.operation, instruction: action.instruction ?? '', overrides: { include: [], exclude: [] } },
        env.call(),
      );
      if (!result.ok) return failWith(result.error);
      if (result.value.candidate === null) return failed(`${EDIT_LABEL[action.operation]}没有完成`);
      env.events.onEffect?.({ kind: 'show_candidates', chapterId: chosen.chapterId });
      return done(`已${EDIT_LABEL[action.operation]}《${c.value.title}》中选中的 ${chosen.text.length} 字，作为候选稿放在章节旁的“AI 写作”里，作者对照差异后接受。`);
    },
  },
  review_chapters: {
    label: '交给后台依次审核',
    undo: 'kept',
    async run(action, env) {
      const jobs = env.events.background;
      if (jobs === undefined) return failed('这里不能在后台审核；请用 review_chapter 一章一章地审');
      const view = await env.host.planningView();
      if (!view.ok) return failWith(view.error);
      let targets: readonly Chapter[];
      const skipped: string[] = [];
      if (action.chapters === null) {
        // 所有已经写好的章节，按书中顺序。
        targets = view.value.chapters.filter((c) => c.hasText && (c.plan === null || c.plan.status !== 'writing')).map((c) => c.chapter);
      } else {
        const found: Chapter[] = [];
        for (const ref of action.chapters) {
          const c = await env.findChapter(ref);
          if (!c.ok) return failed(c.error);
          const entry = view.value.chapters.find((x) => x.chapter.id === c.value.id);
          if (entry === undefined || !entry.hasText) skipped.push(`《${c.value.title}》还没有正文`);
          else if (!found.some((f) => f.id === c.value.id)) found.push(c.value);
        }
        targets = found;
      }
      if (targets.length === 0) return failed(skipped.length > 0 ? `没有可以审核的章节：${skipped.join('；')}` : '没有已经写好的章节可以审核');
      const refused = jobs.reviewChapters(
        targets.map((c) => c.id),
        env.events.backgroundReport?.(),
      );
      if (refused !== null) return failed(refused);
      return done(
        `已排上：在后台依次审核 ${targets.length} 章（${titles(targets)}）。这一轮不用等，问题会列在各章旁的“审核”里，进度在“任务”页；问进度时看当前状态里的“正在进行的任务”。${skipped.length > 0 ? `没排上的：${skipped.join('；')}。` : ''}`,
      );
    },
  },
  stop_background: {
    label: '停下后台任务',
    undo: 'kept',
    run(action, env) {
      const jobs = env.events.background;
      if (jobs === undefined) return Promise.resolve(failed('这里没有后台任务'));
      return Promise.resolve(done(jobs.stop(action.what)));
    },
  },
  resolve_review_issue: {
    label: '处理审核问题',
    undo: 'kept',
    async run(action, env) {
      const resolved = await env.host.resolveIssue(action.issue.trim(), action.status);
      if (!resolved.ok) return failWith(resolved.error);
      env.changed();
      return done(`已把这条问题${action.status === 'fixed' ? '标为已改好' : '忽略'}；这一章还有 ${resolved.value.length} 条待处理。`);
    },
  },
  revise_review_issue: {
    label: '交给写手修订',
    undo: 'revise',
    async run(action, env) {
      env.events.onProgress?.('写手正在修订问题所在的段落');
      const revised = await env.host.reviseIssue(action.issue.trim(), env.call());
      if (!revised.ok) return failWith(revised.error);
      const { chapterId } = revised.value;
      env.events.onEffect?.({ kind: 'chapter_changed', chapterId });
      env.events.onEffect?.({ kind: 'show_review', chapterId });
      env.changed();
      return done(
        `写手已修订这一段（修订前的正文存为了快照，可以恢复）；这一章还有 ${revised.value.issues.length} 条待处理（修订后程序检查会重新标出，标识可能变了，处理前先用 list_review_issues 看）。这一章的长篇记忆因此过时，后面的章节要接着写时用 build_chapter_memory 重新整理。`,
      );
    },
  },
  review_chapter: {
    label: '审核',
    undo: 'kept',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      env.events.onProgress?.(`正在审核《${c.value.title}》`);
      const reviewed = await env.host.reviewChapter(c.value.id, env.call());
      if (!reviewed.ok) return failWith(reviewed.error);
      env.events.onEffect?.({ kind: 'show_review', chapterId: c.value.id });
      const { issues, modelReviewed, reason } = reviewed.value;
      const note = modelReviewed ? '' : `（模型审核没有完成：${reason ?? '原因不明'}；下面只有程序检查的结果）`;
      if (issues.length === 0) return done(`审核完《${c.value.title}》，没有发现问题${note}。`);
      const listed = issues.slice(0, LISTED_ISSUES).map((i) => `- ${SEVERITY_LABEL[i.severity]}：${i.description}${i.suggestion === '' ? '' : `（建议：${i.suggestion}）`}`);
      const more = issues.length > LISTED_ISSUES ? '\n……' : '';
      return done(`审核完《${c.value.title}》，有 ${issues.length} 个待处理的问题${note}，列在章节旁的“审核”里：\n${listed.join('\n')}${more}`);
    },
  },
  rollback_writer: {
    label: '回退写手写入',
    undo: 'kept',
    confirm: async (action, env) => {
      const c = await env.findChapter(action.chapter);
      return c.ok ? { summary: `把“${c.value.title}”回退到写手写入之前（现稿会先存为快照）`, action: { ...action, chapter: c.value.id } } : null;
    },
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      if (env.events.background?.writing().includes(c.value.id) === true) return failed(`《${c.value.title}》排在后台的写作里：等它写完，或在“任务”里停下以后再回退`);
      const rolled = await env.host.rollbackWriter(c.value.id);
      if (!rolled.ok) return failWith(rolled.error);
      env.changed();
      env.events.onEffect?.({ kind: 'chapter_changed', chapterId: c.value.id });
      return done(`已把《${c.value.title}》回退到写手写入之前；回退前的正文存为了快照。`);
    },
  },
  add_foreshadow: {
    label: '记录伏笔',
    undo: 'work',
    async run(action, env) {
      let plantChapterId: string | null = null;
      let payoffChapterId: string | null = null;
      if (action.plant !== null) {
        const c = await env.findChapter(action.plant);
        if (!c.ok) return failed(c.error);
        plantChapterId = c.value.id;
      }
      if (action.payoff !== null) {
        const c = await env.findChapter(action.payoff);
        if (!c.ok) return failed(c.error);
        payoffChapterId = c.value.id;
      }
      const added = await env.host.addForeshadow({
        title: action.title,
        content: action.content,
        reveal: action.reveal ?? '',
        plantChapterId,
        plantAnchor: null,
        payoffChapterId,
        payoffAnchor: null,
        status: 'planned',
      });
      if (!added.ok) return failWith(added.error);
      env.changed();
      return done(`已在伏笔账本里记下“${action.title.trim()}”。`);
    },
  },
  update_foreshadow: {
    label: '修改伏笔',
    undo: 'work',
    async run(action, env) {
      const view = await env.host.planningView();
      if (!view.ok) return failWith(view.error);
      const found = pick(view.value.foreshadows, action.foreshadow, (f) => [f.title], '伏笔');
      if (!found.ok) return failed(found.error);
      const f = found.value;
      const chapterOf = async (ref: string | null, now: string | null): Promise<Result<string | null, string>> => {
        if (ref === null) return ok(now);
        if (CLEARS.has(ref.trim())) return ok(null);
        const c = await env.findChapter(ref);
        return c.ok ? ok(c.value.id) : c;
      };
      const plant = await chapterOf(action.plant, f.plantChapterId);
      if (!plant.ok) return failed(plant.error);
      const payoff = await chapterOf(action.payoff, f.payoffChapterId);
      if (!payoff.ok) return failed(payoff.error);
      const saved = await env.host.updateForeshadow(f, {
        title: action.title ?? f.title,
        content: action.content ?? f.content,
        reveal: action.reveal ?? f.reveal,
        plantChapterId: plant.value,
        // 换了章节，原来那一章里的段落锚点就不再适用。
        plantAnchor: plant.value === f.plantChapterId ? f.plantAnchor : null,
        payoffChapterId: payoff.value,
        payoffAnchor: payoff.value === f.payoffChapterId ? f.payoffAnchor : null,
        status: action.status ?? f.status,
      });
      if (!saved.ok) return failWith(saved.error);
      env.changed();
      return done(`已修改伏笔“${action.title ?? f.title}”${action.status === null ? '' : `，状态为${FORESHADOW_STATUS_LABEL[action.status]}`}。`);
    },
  },
  restore_chapter: {
    label: '从回收站恢复',
    undo: 'work',
    async run(action, env) {
      const work = await env.work();
      if (!work.ok) return failWith(work.error);
      const c = pick(work.value.trashed, action.chapter, (x) => [x.title], '回收站里的章节');
      if (!c.ok) return failed(c.error);
      const restored = await env.host.restoreChapter(c.value);
      if (!restored.ok) return failWith(restored.error);
      env.changed();
      return done(`已把《${c.value.title}》从回收站恢复。`);
    },
  },
  save_snapshot: {
    label: '保存快照',
    undo: 'kept',
    async run(action, env) {
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      const saved = await env.host.createSnapshot(c.value.id);
      if (!saved.ok) return failWith(saved.error);
      return done(`已给《${c.value.title}》存了一个版本快照，在章节的“版本快照”里。`);
    },
  },
  list_simulations: {
    label: '查看推演',
    undo: 'read',
    async run(action, env) {
      const scenes = await env.host.listSimScenes();
      if (!scenes.ok) return failWith(scenes.error);
      let list = scenes.value;
      if (action.scene !== null) {
        const s = pick(list, action.scene, (x) => [x.title], '推演场景');
        if (!s.ok) return failed(s.error);
        list = [s.value];
      }
      if (list.length === 0) return done('还没有推演场景；用 create_sim_scene 由一段局面描述建一个。');
      const lines: string[] = [];
      for (const scene of list.slice(0, LISTED_SCENES)) {
        lines.push(`[${scene.id}] ${scene.title}（${PROTOCOL_LABEL[scene.protocol]}，最多 ${scene.maxRounds} 回合；角色：${actorList(sceneActors(scene.config)) || '无'}）`);
        const runs = await env.host.listSimRuns(scene.id);
        if (!runs.ok) return failWith(runs.error);
        if (runs.value.length === 0) lines.push('  - 还没有推演过');
        for (const r of runs.value.slice(0, LISTED_RUNS)) {
          const reason =
            r.status === 'ended' && r.endReason !== null
              ? `（${SIM_END_LABEL[r.endReason] ?? r.endReason}）`
              : r.status === 'paused' && r.pauseReason !== null
                ? `（${SIM_PAUSE_LABEL[r.pauseReason] ?? r.pauseReason}）`
                : '';
          lines.push(`  - 推演 [${r.id}]：${SIM_RUN_STATUS_LABEL[r.status]}${reason}，第 ${r.round} 回合${r.parentRunId === null ? '' : '（分支）'}`);
        }
        if (runs.value.length > LISTED_RUNS) lines.push(`  - ……还有 ${runs.value.length - LISTED_RUNS} 次更早的推演`);
      }
      if (list.length > LISTED_SCENES) lines.push(`……还有 ${list.length - LISTED_SCENES} 个场景，指明场景名再看`);
      return done(lines.join('\n'));
    },
  },
  create_sim_scene: {
    label: '建推演场景',
    undo: 'kept',
    async run(action, env) {
      let chapterId: string | null = null;
      if (action.chapter !== null) {
        const c = await env.findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        chapterId = c.value.id;
      }
      env.events.onProgress?.('正在生成推演场景');
      const draft = await env.host.draftSimScene(action.description, env.call());
      if (!draft.ok) return failWith(draft.error);
      const { config, problems } = draft.value;
      if (problems.length > 0) {
        return failed(
          `生成的场景还有 ${problems.length} 处不合规则，没有保存：${problems.slice(0, 6).join('；')}${problems.length > 6 ? '……' : ''}。可以把描述写得更具体再试一次，或请作者在推演页“生成场景配置草稿”后逐项修改`,
        );
      }
      const title = action.title?.trim() || config.meta?.title?.trim() || '新场景';
      const protocol = config.actors.length === 2 ? 'turn_based' : 'simultaneous';
      const maxRounds = action.maxRounds ?? DEFAULT_SIM_ROUNDS;
      const saved = await env.host.saveSimScene(null, { chapterId, title, config, protocol, maxRounds, firstSpeaker: null });
      if (!saved.ok) return failWith(saved.error);
      env.events.onEffect?.({ kind: 'simulation_changed' });
      return done(
        `已保存推演场景“${title}”[${saved.value.id}]：${config.zones.length} 个区域，角色 ${actorList(config.actors)}，${PROTOCOL_LABEL[protocol]}，最多 ${maxRounds} 回合。作者可以在推演页修改；要推演时用 start_simulation。`,
      );
    },
  },
  start_simulation: {
    label: '开始推演',
    undo: 'kept',
    async run(action, env) {
      const jobs = env.events.background;
      if (jobs === undefined) return failed('这里不能在后台推演；请作者在推演页开始');
      if (jobs.simulating()) return failed('已经有一次推演在后台推进，等它推完或停下以后再开始');
      const scenes = await env.host.listSimScenes();
      if (!scenes.ok) return failWith(scenes.error);
      const scene = pick(scenes.value, action.scene, (x) => [x.title], '推演场景');
      if (!scene.ok) return failed(scene.error);
      const started = await env.host.startSimRun(scene.value.id, { mode: 'auto', ...(action.budgetUsd !== null && { budgetUsd: action.budgetUsd }) });
      if (!started.ok) return failWith(started.error);
      const runId = started.value.run.id;
      const refused = jobs.simulate(runId, scene.value.id);
      env.events.onEffect?.({ kind: 'simulation_changed' });
      if (refused !== null) return failed(`推演已登记 [${runId}]，但没有开始推进：${refused}；之后可以用 continue_simulation 接着推`);
      return done(
        `已开始推演 [${runId}]（场景“${scene.value.title}”，最多 ${scene.value.maxRounds} 回合${action.budgetUsd === null ? '' : `，费用上限 $${action.budgetUsd}`}），在后台连续推进到结束；裁决自动接受，采纳进作品前作者要逐项复核。这一轮不用等，进度在“正在进行的任务”与推演页；推完用 get_simulation 看概要。`,
      );
    },
  },
  continue_simulation: {
    label: '继续推演',
    undo: 'kept',
    async run(action, env) {
      const jobs = env.events.background;
      if (jobs === undefined) return failed('这里不能在后台推演；请作者在推演页继续');
      const found = await findRun(env, action.run);
      if (!found.ok) return failed(found.error);
      const view = found.value;
      if (view.phase === 'Ended') return failed(`这次推演已经结束了（${runState(view)}）；可以用 start_simulation 再推一次`);
      if (view.awaitingRulings > 0 || view.awaitingDirector) {
        const waiting = [view.awaitingRulings > 0 ? `${view.awaitingRulings} 条待核实的裁决` : '', view.awaitingDirector ? '一条导演提议' : ''].filter((x) => x !== '').join('与');
        return failed(`这次推演在等作者处理${waiting}，请作者在推演页处理后再继续`);
      }
      if (jobs.simulating()) return failed('已经有一次推演在后台推进，等它推完或停下以后再继续');
      const refused = jobs.simulate(view.run.id, view.run.sceneId);
      if (refused !== null) return failed(refused);
      return done(`推演 [${view.run.id}] 从第 ${view.round} 回合接着在后台推进；进度在“正在进行的任务”与推演页，推完用 get_simulation 看概要。`);
    },
  },
  get_simulation: {
    label: '查看推演概要',
    undo: 'read',
    async run(action, env) {
      const found = await findRun(env, action.run);
      if (!found.ok) return failed(found.error);
      const detail = await env.host.simRunDetail(found.value.run.id);
      if (!detail.ok) return failWith(detail.error);
      const d = detail.value;
      const v = d.view;
      const review = (d.data?.rounds ?? []).reduce((n, r) => n + r.rulings.filter((x) => x.needsReview).length, 0);
      const waiting = [
        ...d.pendingRulings.map((r) => `- 待核实的裁决：${r.rationale}${r.effects.length === 0 ? '' : `（${r.effects.join('；')}）`}`),
        ...(d.pendingDirector === null ? [] : [`- 导演提议：${d.pendingDirector.rationale}`]),
      ];
      return done(
        [
          `推演 [${v.run.id}]：${runState(v)}；已用 $${v.spentUsd.toFixed(4)}${v.estimatedCalls > 0 ? `（其中 ${v.estimatedCalls} 次没有用量，按估计的上限计入）` : ''}${v.unknownCostCalls > 0 ? `（另有 ${v.unknownCostCalls} 次调用费用未知）` : ''}${v.run.budgetUsd === null ? '' : `，费用上限 $${v.run.budgetUsd}`}`,
          `角色：${actorList(d.cast.actors)}`,
          review === 0 ? '' : `自动接受的裁决 ${review} 条，采纳进作品前要作者逐项复核`,
          waiting.length === 0 ? '' : `等作者在推演页处理：\n${waiting.join('\n')}`,
          simSummary(d),
        ]
          .filter((x) => x !== '')
          .join('\n'),
      );
    },
  },
  narrate_simulation: {
    label: '推演写成正文',
    undo: 'kept',
    async run(action, env) {
      const found = await findRun(env, action.run);
      if (!found.ok) return failed(found.error);
      const runId = found.value.run.id;
      const detail = await env.host.simRunDetail(runId);
      if (!detail.ok) return failWith(detail.error);
      const pov = pick(detail.value.cast.actors, action.pov, (a) => [a.name], '视角角色');
      if (!pov.ok) return failed(pov.error);
      const c = await env.findChapter(action.chapter);
      if (!c.ok) return failed(c.error);
      const events = await env.host.simRunEvents(runId);
      if (!events.ok) return failWith(events.error);
      const ended = lastEndedRound(events.value);
      if (ended === 0) return failed('这次推演还没有结束的回合，没有可以写的内容');
      const fromRound = action.fromRound ?? 1;
      const toRound = Math.min(action.toRound ?? ended, ended);
      if (fromRound > toRound) return failed(`回合范围不对：已经结束的回合是第 1 到第 ${ended} 回合`);
      // 不带作者说明与文风：助手看过全局概要，它写的说明可能带进视角角色不知道的事（硬性规则 3）。
      env.events.onProgress?.(`正在按${pov.value.name}的视角整理第 ${fromRound}–${toRound} 回合的节拍`);
      const sheet = await env.host.draftBeatSheet(runId, { pov: pov.value.id, fromRound, toRound, notes: '' }, env.call());
      if (!sheet.ok) return failWith(sheet.error);
      env.events.onProgress?.(`正在把${pov.value.name}的经历写进《${c.value.title}》`);
      const candidate = await env.host.narrateBeatSheet(sheet.value.sheet.id, c.value.id, env.call());
      if (!candidate.ok) return failWith(candidate.error);
      env.events.onEffect?.({ kind: 'show_candidates', chapterId: c.value.id });
      return done(
        `已按${pov.value.name}的视角把第 ${fromRound}–${toRound} 回合写成候选稿（${sheet.value.beats.length} 个节拍），放在《${c.value.title}》旁的“AI 写作”里；作者要用“采纳…”选定写进作品的事件与认知，不能直接接受。`,
      );
    },
  },
  list_workflows: {
    label: '列出写作工作流',
    undo: 'read',
    async run(_action, env) {
      const flows = env.host.workflows;
      if (flows === undefined) return failed('这里不能用写作工作流');
      const catalog = flows.workflowCatalog().map((w) => `- ${w.key}：${w.title}——${w.description}（${w.steps.length} 步：${w.steps.map((s) => s.label).join(' → ')}）`);
      const runs = await flows.listWorkflows();
      if (!runs.ok) return failWith(runs.error);
      const listed = runs.value.slice(0, 10).map((v) => `- ${workflowLine(v)}`);
      return done(`可用的工作流：\n${catalog.join('\n')}\n这部作品的运行：${listed.length === 0 ? '还没有' : `\n${listed.join('\n')}`}`);
    },
  },
  start_workflow: {
    label: '开始写作工作流',
    undo: 'kept',
    async run(action, env) {
      const flows = env.host.workflows;
      const jobs = env.events.background;
      if (flows === undefined || jobs === undefined) return failed('这里不能在后台推进写作工作流');
      const params = { idea: action.idea ?? '', genre: action.genre ?? '', chapters: action.chapters ?? 20, wordsPerChapter: action.wordsPerChapter ?? 3000 };
      const quote = await flows.quoteWorkflow(action.workflow, params);
      if (!quote.ok) return failWith(quote.error);
      const started = await flows.startWorkflow({ workflow: action.workflow, params, mode: action.mode, budgetUsd: action.budgetUsd });
      if (!started.ok) return failWith(started.error);
      const id = started.value.run.id;
      const refused = jobs.workflow(id, env.events.backgroundReport?.());
      if (refused !== null) return failed(`运行 [${id}] 已建好，但没有开始推进：${refused}`);
      env.events.onEffect?.({ kind: 'open_page', page: 'book' });
      const q = quote.value;
      const cost = q.costUsd === null ? '价格未知' : `约 $${q.costUsd.toFixed(2)}`;
      return done(
        `已排上：“${started.value.run.title}” [${id}] 在后台推进（${action.mode === 'step' ? '每步停下，草稿等作者在成书页采用' : '一路做完，会覆盖内容的步骤停下等作者'}）。预计约 ${q.calls} 次调用、${Math.round((q.inputTokens + q.outputTokens) / 1000)} 千 Token，${cost}${action.budgetUsd === null ? '' : `，上限 $${action.budgetUsd}`}。进度看“正在进行的任务”，停下时停在哪里会出现在“后台刚做完的”里。`,
      );
    },
  },
  get_workflow: {
    label: '查看写作工作流',
    undo: 'read',
    async run(action, env) {
      const flows = env.host.workflows;
      if (flows === undefined) return failed('这里不能用写作工作流');
      const view = await findWorkflow(flows, action.run);
      if (!view.ok) return failed(view.error);
      const v = view.value;
      const steps = v.steps.map((s) => `${s.idx + 1}. ${s.label}：${WORKFLOW_STEP_STATUS_LABEL[s.status]}${s.note === '' ? '' : `——${clip(s.note, 300).text}`}`);
      const spent = v.spent.cost > 0 ? `；已用 $${v.spent.cost.toFixed(3)}${v.spent.unknown > 0 ? `（另有 ${v.spent.unknown} 次费用未知）` : ''}` : '';
      return done(`${workflowLine(v)}${spent}\n${steps.join('\n')}`);
    },
  },
  continue_workflow: {
    label: '继续写作工作流',
    undo: 'kept',
    async run(action, env) {
      const flows = env.host.workflows;
      const jobs = env.events.background;
      if (flows === undefined || jobs === undefined) return failed('这里不能在后台推进写作工作流');
      const view = await findWorkflow(flows, action.run);
      if (!view.ok) return failed(view.error);
      const v = view.value;
      if (v.state === 'abandoned') return failed('这次运行已经放弃');
      if (v.state === 'done') return done('这次运行已经全部做完。');
      if (v.state === 'running') return failed('它正在推进，不用再继续');
      const waiting = v.steps.find((s) => s.status === 'awaiting_author');
      let note = '';
      if (action.adopt && waiting !== undefined) {
        if (waiting.kind === 'manual') return failed(`第 ${waiting.idx + 1} 步“${waiting.label}”须作者自己在成书页点（例如导出要选保存的位置）`);
        const adopted = await flows.adoptWorkflowStep(v.run.id, waiting.idx);
        if (!adopted.ok) return failWith(adopted.error);
        env.changed();
        note = `已采用第 ${waiting.idx + 1} 步“${waiting.label}”：${adopted.value.steps[waiting.idx]?.note ?? ''}。`;
      } else if (waiting !== undefined) {
        return failed(`停在第 ${waiting.idx + 1} 步“${waiting.label}”等作者处理（${waiting.note}）：作者同意按原样采用时用 adopt 为 true，想改的请作者在成书页修改后采用`);
      }
      const blocked = v.steps.find((s) => s.status === 'failed' || s.status === 'stale');
      if (blocked !== undefined && (waiting === undefined || blocked.idx < waiting.idx)) {
        return failed(`第 ${blocked.idx + 1} 步“${blocked.label}”${WORKFLOW_STEP_STATUS_LABEL[blocked.status]}（${blocked.note}）：请作者在成书页决定重做、跳过或保留`);
      }
      const refused = jobs.workflow(v.run.id, env.events.backgroundReport?.());
      if (refused !== null) return failed(`${note}没有接着推进：${refused}`);
      return done(`${note}已排上：“${v.run.title}”在后台接着推进；停下时停在哪里会出现在“后台刚做完的”里。`);
    },
  },
  undo_last_turn: {
    label: '撤销上一轮的改动',
    undo: 'read',
    // 和“回退写手写入”一样：要把正文改回去时先请作者确认。
    confirm: (_action, env) => env.undoTextPreview?.() ?? null,
    run(_action, env) {
      return env.undoLastTurn === undefined ? Promise.resolve(failed('这里不能撤销')) : env.undoLastTurn();
    },
  },
  export_book: {
    label: '导出',
    undo: 'kept',
    async run(action, env) {
      let chapterId: string | undefined;
      if (action.chapter !== null) {
        const c = await env.findChapter(action.chapter);
        if (!c.ok) return failed(c.error);
        chapterId = c.value.id;
      }
      const exported = await env.host.exportText(action.format === 'txt' ? 'txt' : 'md', chapterId);
      if (!exported.ok) return failWith(exported.error);
      return exported.value ? done('已导出。') : failed('作者取消了保存，没有导出');
    },
  },
  open_page: {
    label: '打开页面',
    undo: 'read',
    run(action, env) {
      env.events.onEffect?.({ kind: 'open_page', page: action.page });
      return Promise.resolve(done('已打开页面。'));
    },
  },
};

/** 一次运行读成一行：标识、名称、状态与停在哪一步。 */
function workflowLine(v: WorkflowView): string {
  const at = v.steps.find((s) => s.status !== 'done' && s.status !== 'skipped');
  const where = at === undefined ? '' : `，第 ${at.idx + 1} 步“${at.label}”${WORKFLOW_STEP_STATUS_LABEL[at.status]}${at.note === '' ? '' : `：${clip(at.note, 120).text}`}`;
  return `[${v.run.id}] ${v.run.title}（${v.run.mode === 'step' ? '每步停下' : '一路做完'}）：${WORKFLOW_STATE_LABEL[v.state]}${where}`;
}

/** 按标识找一次运行；没给时取最近的一次。 */
async function findWorkflow(flows: AssistantWorkflows, ref: string | null): Promise<Result<WorkflowView, string>> {
  if (ref !== null && ref.trim() !== '') {
    const one = await flows.workflowRun(ref.trim());
    return one.ok ? ok(one.value) : err(one.error.code === 'not_found' ? `找不到运行“${ref}”（标识见 list_workflows）` : describeForModel(one.error));
  }
  const all = await flows.listWorkflows();
  if (!all.ok) return err(describeForModel(all.error));
  const latest = all.value[0];
  return latest === undefined ? err('这部作品还没有运行过写作工作流；用 start_workflow 开始') : ok(latest);
}

/** 执行一个动作。 */
export function runTool<K extends AssistantTool>(tool: K, action: ActionOf<K>, env: ToolEnv): Promise<Outcome> {
  return TOOLS[tool].run(action, env);
}

/** 这个动作执行前要作者确认时，给作者看的说明；不需要确认时为 null。 */
export async function confirmationFor<K extends AssistantTool>(tool: K, action: ActionOf<K>, env: ToolEnv): Promise<Confirmation<K> | null> {
  const confirm: Tool<K>['confirm'] = TOOLS[tool].confirm;
  if (confirm === undefined) return null;
  const asked = await confirm(action, env);
  return asked === null ? null : typeof asked === 'string' ? { summary: asked, action } : asked;
}

/** 动作的改动怎样撤销。 */
export function undoModeOf(tool: AssistantTool): UndoMode {
  return TOOLS[tool].undo;
}

/** 动作在对话里的名称；不认识的（例如旧版本记下的动作）原样显示。 */
export function toolLabel(tool: string): string {
  return Object.hasOwn(TOOLS, tool) ? TOOLS[tool as AssistantTool].label : tool;
}

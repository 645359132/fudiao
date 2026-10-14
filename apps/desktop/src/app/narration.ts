// 推演写成正文（需求 B29、B45、B62，施工文档 M4-07）：节拍表与按节拍表写成的候选稿。
// 视角正文只用视角角色在那一刻的认知（硬性规则 3）：材料取自 buildCharacterView 生成的角色视图，
// 提示词模板的参数就是这个视图；他人的认知、角色卡、秘密与全局局面都不进入请求。
// 结果先成为候选稿（作者决定 2026-10-14），作者比较、修改后接受才写入章节。
import { ActorId, buildCharacterView, parseScene, type CharacterView, type KnowledgeId, type Occurrence, type Scene } from '@fudiao/domain';
import { buildViewerData, reduceRun, type RunEvent } from '@fudiao/engine';
import type { CallOptions } from '@fudiao/llm';
import { BeatSheetOutput, renderBeatSheet, renderCandidateText } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  adoptionStatements,
  createBeatSheet,
  createCandidate,
  createSnapshot,
  findCallByRequestHash,
  getBeatSheet,
  getCandidate,
  getSimRun,
  listBeatSheets,
  listChapters,
  listChapterEventLinks,
  listEntities,
  listParagraphs,
  listStoryEvents,
  planRangeReplace,
  rangeReplaceStatements,
  saveChapterParagraphs,
  setCandidateStatus,
  sqlEventStore,
  textInRange,
  updateBeatSheet,
  type AdoptedEvent,
  type AdoptedFact,
  type Beat,
  type BeatSheet,
  type Candidate,
  type EventLink,
  type FactInput,
  type RepoError,
  type SavedParagraph,
  type SimRun,
  type SqlPort,
  type StoredEvent,
  type StoryEvent,
} from '@fudiao/store';
import { insertFor, STALE_REASON } from './candidates';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';
import { describeObservation, describeStoryOccurrence } from './sim-describe';

/** 节拍表与正文的输出上限：正文所需之外另留出思考的余量。 */
export const BEAT_SHEET_OUTPUT_TOKENS = 4_000 + THINKING_ALLOWANCE;
export const NARRATION_OUTPUT_TOKENS = 8_000 + THINKING_ALLOWANCE;

/** 节拍：作者看得懂的内容（视角角色那一条认知写成的文字）与它所在的回合。 */
export type BeatView = Beat & { readonly round: number; readonly text: string };

export type BeatSheetView = { readonly sheet: BeatSheet; readonly povName: string; readonly beats: readonly BeatView[] };

export type BeatSheetRequest = {
  readonly pov: string;
  readonly fromRound: number;
  readonly toRound: number;
  /** 作者给节拍表的说明（例如“对峙展开，奔走略写”）。 */
  readonly notes: string;
};

/** 采纳时可以带进作品的一件事：推演里发生的一件事（提交时的事件序号与位置）。 */
export type AdoptionEvent = {
  readonly key: string;
  readonly round: number;
  readonly summary: string;
  readonly participants: readonly { readonly key: string; readonly name: string }[];
  /** 视角角色察觉到了这件事（这份正文能讲到的事）。 */
  readonly seenByPov: boolean;
};

/** 视角角色的一条见闻，可以记为他的认知。 */
export type AdoptionBelief = {
  readonly ref: string;
  readonly round: number;
  readonly text: string;
  readonly modality: 'observed' | 'heard' | 'inferred';
  readonly confidence: number | null;
  readonly about: readonly string[];
};

/** 场景里的角色、地点与物品对应到的设定；对不上时 entityId 为 null。 */
export type EntityLink = {
  readonly key: string;
  readonly name: string;
  readonly kind: 'character' | 'location' | 'item';
  readonly entityId: string | null;
  readonly entityName: string | null;
  readonly locked: boolean;
};

export type AdoptionDraft = {
  readonly candidateId: string;
  readonly chapterId: string;
  readonly povKey: string;
  readonly povName: string;
  readonly events: readonly AdoptionEvent[];
  readonly beliefs: readonly AdoptionBelief[];
  /** 自动接受、须逐条复核的裁决。 */
  readonly reviews: readonly { readonly requestId: string; readonly round: number; readonly rationale: string }[];
  readonly entities: readonly EntityLink[];
};

export type AdoptionRequest = {
  readonly candidateId: string;
  /** 采纳为故事事件的事（AdoptionEvent 的 key），至少一件。 */
  readonly events: readonly string[];
  /** 其中同时记为世界事实的事。 */
  readonly worldFacts: readonly string[];
  /** 记为视角角色认知的见闻（AdoptionBelief 的 ref）。 */
  readonly beliefs: readonly string[];
  /** 作者复核过的自动接受的裁决。 */
  readonly reviewed: readonly string[];
  /** 作者核对过涉及锁定设定的内容。 */
  readonly confirmLocked: boolean;
};

export type AdoptionResult = { readonly paragraphs: readonly SavedParagraph[]; readonly events: number; readonly facts: number };

const factInput = (
  kind: 'world' | 'belief',
  holderId: string | null,
  content: string,
  subjectIds: readonly string[],
  modality: 'observed' | 'heard' | 'inferred' | null,
  confidence: number | null,
): FactInput => ({
  kind,
  holderId,
  subjectIds: [...new Set(subjectIds)],
  content,
  modality,
  confidence,
  validFromChapterId: null,
  validToChapterId: null,
  validFrom: null,
  validTo: null,
  basis: [],
});

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

/** 视角角色在某一刻的认知：角色视图、这几个回合里的见闻与他自己的内心片段。 */
type Moment = {
  readonly scene: Scene;
  readonly view: CharacterView;
  readonly upToSeq: number;
  readonly materials: readonly KnowledgeId[];
  readonly thoughts: readonly { readonly round: number; readonly text: string }[];
};

export function narrationUseCases(deps: AppDeps, session: () => { readonly port: SqlPort; readonly path: string } | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });

  async function runOf(port: SqlPort, runId: string): Promise<Result<{ run: SimRun; scene: Scene; events: readonly StoredEvent[] }, AppError>> {
    const run = await getSimRun(port, runId);
    if (!run.ok) return err(repo(run.error));
    if (run.value === null) return err({ code: 'not_found' });
    const scene = parseScene(run.value.sceneConfig);
    if (!scene.ok) return err(settings('这次推演的场景配置读不出来'));
    try {
      return ok({ run: run.value, scene: scene.value, events: await sqlEventStore(port).read(runId) });
    } catch (error) {
      return err(settings(error instanceof Error ? error.message : String(error)));
    }
  }

  /** 回放到 upToSeq，取视角角色那一刻的视图；材料是 fromRound 到 toRound 之间他的见闻（不含开场时的初始认知）。 */
  function momentAt(scene: Scene, runId: string, events: readonly StoredEvent[], pov: string, upToSeq: number, fromRound: number, toRound: number): Result<Moment, AppError> {
    const actor = ActorId.safeParse(pov);
    if (!actor.success || !scene.actors.some((a) => a.id === actor.data)) return err(settings(`场景里没有角色“${pov}”`));
    const upTo = events.filter((e) => e.seq <= upToSeq);
    const state = reduceRun(scene, runId, upTo);
    if (!state.ok) return err(settings('运行记录回放失败'));
    const view = buildCharacterView(scene, state.value.sim, actor.data);
    const materials = view.knowledge
      .filter((k) => k.body.kind !== 'text' && k.round >= fromRound && k.round <= toRound)
      .sort((a, b) => a.round - b.round)
      .map((k) => k.id);
    const thoughts = upTo
      .map((e) => e.payload as RunEvent)
      .flatMap((e) =>
        e.type === 'ProposalSubmitted' && e.actor === actor.data && e.proposal !== null && e.round >= fromRound && e.round <= toRound && e.proposal.innerThought.trim() !== ''
          ? [{ round: e.round, text: e.proposal.innerThought }]
          : [],
      );
    return ok({ scene, view, upToSeq, materials, thoughts });
  }

  function viewOf(sheet: BeatSheet, moment: Moment): BeatSheetView {
    const names = new Map([...moment.view.names, { id: moment.view.actorId as string, name: moment.view.self.name }].map((n) => [n.id, n.name]));
    const name = (id: string) => names.get(id) ?? id;
    const byId = new Map(moment.view.knowledge.map((k) => [k.id as string, k]));
    return {
      sheet,
      povName: moment.view.self.name,
      beats: sheet.beats.map((b) => {
        const k = byId.get(b.ref);
        const body = k?.body;
        const claim = body?.kind === 'claim' ? moment.view.claims.find((c) => c.id === body.claim) : undefined;
        const text =
          body === undefined
            ? '（这条认知已不在他的视图中）'
            : body.kind === 'text'
              ? body.text
              : body.kind === 'observation'
                ? describeObservation(body.observation, name)
                : claim === undefined
                  ? '（听到的一句话）'
                  : `${name(claim.speaker)}说：“${claim.sentences.join('')}”`;
        return { ...b, round: k?.round ?? 0, text };
      }),
    };
  }

  /** 采纳要用到的一切：候选稿、节拍表那一刻的视角、范围内发生的事、设定的对应与需要复核的裁决。 */
  async function adoptionContext(port: SqlPort, candidateId: string) {
    const candidate = await getCandidate(port, candidateId);
    if (!candidate.ok) return err(repo(candidate.error));
    const c = candidate.value;
    if (c.status !== 'pending') return err(settings('这份候选稿已经处理过了'));
    if (c.operation !== 'narrate' || c.beatSheetId === null) return err(settings('只有推演写成的正文需要采纳'));
    const sheet = await getBeatSheet(port, c.beatSheetId);
    if (!sheet.ok) return err(repo(sheet.error));
    if (sheet.value === null) return err(settings('这份候选稿依据的节拍表已经不在了'));
    const { runId, povActor, fromRound, toRound, upToSeq } = sheet.value;
    const loaded = await runOf(port, runId);
    if (!loaded.ok) return loaded;
    const { scene, events } = loaded.value;
    const moment = momentAt(scene, runId, events, povActor, upToSeq, fromRound, toRound);
    if (!moment.ok) return moment;
    const entities = await listEntities(port);
    if (!entities.ok) return err(repo(entities.error));

    // 场景的键按名字（或别名）对应到设定：角色对人物，区域对地点，物品对物品。
    const kindOf = (key: string): 'character' | 'location' | 'item' | null =>
      scene.actors.some((a) => a.id === key) ? 'character' : scene.zones.some((z) => z.id === key) ? 'location' : scene.items.some((i) => i.id === key) ? 'item' : null;
    const sceneName = new Map([...scene.actors, ...scene.zones, ...scene.items, ...scene.mechanisms].map((x) => [x.id as string, x.name]));
    const name = (key: string) => sceneName.get(key) ?? key;
    const links: EntityLink[] = [...scene.actors, ...scene.zones, ...scene.items].map((x) => {
      const kind = kindOf(x.id)!;
      const entity = entities.value.find((e) => e.kind === kind && [e.name, ...e.aliases].some((n) => n.trim() === x.name.trim()));
      return { key: x.id, name: x.name, kind, entityId: entity?.id ?? null, entityName: entity?.name ?? null, locked: entity?.locked ?? false };
    });
    const entityOf = (key: string): string | null => links.find((l) => l.key === key)?.entityId ?? null;
    const lockedNames = new Map(entities.value.filter((e) => e.locked).map((e) => [e.id, e.name]));

    // 范围内发生的事：提交时的事件序号与它在这一批里的位置，以及谁察觉到了。
    const inRange = events.filter((e) => e.seq <= upToSeq);
    const perceived = new Map<string, { actor: string; channel: string }[]>();
    for (const e of inRange) {
      const p = e.payload as RunEvent;
      if (p.type !== 'PerceptionDelivered' || p.round < fromRound || p.round > toRound) continue;
      for (const o of p.observations) perceived.set(o.occurrence, [...(perceived.get(o.occurrence) ?? []), { actor: p.actor, channel: o.channel }]);
    }
    const occurrences = new Map<string, { seq: number; occurrence: Occurrence; perceivedBy: { actor: string; channel: string }[] }>();
    const draftEvents: AdoptionEvent[] = [];
    for (const e of inRange) {
      const p = e.payload as RunEvent;
      if (p.type !== 'StateChanged' || p.round < fromRound || p.round > toRound) continue;
      for (const [index, o] of p.occurrences.entries()) {
        const key = `${e.seq}:${index}`;
        const perceivedBy = perceived.get(o.id) ?? [];
        occurrences.set(key, { seq: e.seq, occurrence: o, perceivedBy });
        draftEvents.push({
          key,
          round: p.round,
          summary: describeStoryOccurrence(o, name),
          participants: [...new Set([...(o.actor === undefined ? [] : [o.actor]), ...o.participants])].map((k) => ({ key: k, name: name(k) })),
          // 视角角色察觉到的事，才是这份正文能讲到的事。
          seenByPov: perceivedBy.some((x) => x.actor === povActor),
        });
      }
    }

    // 视角角色的见闻：节拍表里没有省略的那些。
    const view = viewOf(sheet.value, moment.value);
    const knowledge = new Map(moment.value.view.knowledge.map((k) => [k.id as string, k]));
    const beliefs: AdoptionBelief[] = view.beats
      .filter((b) => b.treatment !== 'omit')
      .flatMap((b) => {
        const k = knowledge.get(b.ref);
        if (k === undefined) return [];
        return [{ ref: b.ref, round: b.round, text: b.text, modality: k.modality === 'claimed' ? 'heard' : k.modality, confidence: k.confidence, about: [...k.about] }];
      });

    // 自动模式里自动接受、待复核的裁决（范围内的回合）。
    const data = buildViewerData(scene, runId, inRange.map((e) => e.payload as RunEvent));
    const reviews = data.rounds
      .filter((r) => r.round >= fromRound && r.round <= toRound)
      .flatMap((r) => r.rulings.filter((x) => x.needsReview).map((x) => ({ requestId: x.requestId, round: r.round, rationale: x.rationale })));

    const draft: AdoptionDraft = {
      candidateId,
      chapterId: c.chapterId,
      povKey: povActor,
      povName: moment.value.view.self.name,
      events: draftEvents,
      beliefs,
      reviews,
      entities: links,
    };
    return ok({ draft, candidate: c, moment: { runId }, occurrences, entityOf, lockedNames });
  }

  async function sheetView(port: SqlPort, sheet: BeatSheet): Promise<Result<BeatSheetView, AppError>> {
    const loaded = await runOf(port, sheet.runId);
    if (!loaded.ok) return loaded;
    const moment = momentAt(loaded.value.scene, sheet.runId, loaded.value.events, sheet.povActor, sheet.upToSeq, sheet.fromRound, sheet.toRound);
    return moment.ok ? ok(viewOf(sheet, moment.value)) : moment;
  }

  return {
    /**
     * 由一次推演生成节拍表（B45）：视角角色、回合范围，以及作者的说明。认知取到 toRound 这一回合结束时为止，
     * 之后才发生的事他还不知道，不会进入材料。节拍只能指向这些见闻，模型给出的其他引用丢弃。
     */
    async draftBeatSheet(runId: string, request: BeatSheetRequest, options: CallOptions = {}): Promise<Result<BeatSheetView, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const loaded = await runOf(s.port, runId);
      if (!loaded.ok) return loaded;
      const { scene, events } = loaded.value;
      if (!Number.isInteger(request.fromRound) || !Number.isInteger(request.toRound) || request.fromRound < 1 || request.toRound < request.fromRound) {
        return err(settings('回合范围不对：起始回合须不小于 1，且不大于结束回合'));
      }
      const ended = events.find((e) => {
        const p = e.payload as RunEvent;
        return p.type === 'RoundEnded' && p.round === request.toRound;
      });
      if (ended === undefined) return err(settings(`第 ${request.toRound} 回合还没有结束，只能写已经结束的回合`));
      const moment = momentAt(scene, runId, events, request.pov, ended.seq, request.fromRound, request.toRound);
      if (!moment.ok) return moment;
      if (moment.value.materials.length === 0) return err(settings(`第 ${request.fromRound} 到第 ${request.toRound} 回合里，${moment.value.view.self.name}没有看到或听到什么，没有可以写的节拍`));

      const prompt = renderBeatSheet(moment.value.view, {
        materials: moment.value.materials,
        thoughts: moment.value.thoughts,
        ...(request.notes.trim() !== '' && { authorNotes: request.notes.trim() }),
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: BEAT_SHEET_OUTPUT_TOKENS, effort: 'medium' }, BeatSheetOutput, options);
      if (!result.ok) return result;
      const known = new Set<string>(moment.value.materials);
      const seen = new Set<string>();
      const beats = result.value.value.beats.filter((b) => known.has(b.ref) && !seen.has(b.ref) && seen.add(b.ref));
      if (beats.length === 0) return err(settings('模型给出的节拍都对不上视角角色的见闻，请重试'));
      const hash = result.value.attempts.at(-1)?.requestHash;
      const call = hash === undefined ? null : await findCallByRequestHash(s.port, hash);
      const created = await createBeatSheet(
        s.port,
        {
          id: deps.ids.next(),
          runId,
          povActor: request.pov,
          fromRound: request.fromRound,
          toRound: request.toRound,
          upToSeq: ended.seq,
          beats,
          style: '',
          llmCallId: call?.ok === true ? (call.value?.id ?? null) : null,
        },
        ctx(),
      );
      return created.ok ? ok(viewOf(created.value, moment.value)) : err(repo(created.error));
    },

    async listBeatSheets(runId: string): Promise<Result<BeatSheetView[], AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const sheets = await listBeatSheets(s.port, runId);
      if (!sheets.ok) return err(repo(sheets.error));
      const loaded = await runOf(s.port, runId);
      if (!loaded.ok) return loaded;
      const views: BeatSheetView[] = [];
      for (const sheet of sheets.value) {
        const moment = momentAt(loaded.value.scene, runId, loaded.value.events, sheet.povActor, sheet.upToSeq, sheet.fromRound, sheet.toRound);
        if (!moment.ok) return moment;
        views.push(viewOf(sheet, moment.value));
      }
      return ok(views);
    },

    /** 作者修改节拍的处理方式、说明、是否暂不揭示与文风。节拍指向的认知不能换：只能是视角角色那一刻的见闻。 */
    async saveBeatSheet(id: string, fields: { readonly beats: readonly Beat[]; readonly style: string }): Promise<Result<BeatSheetView, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const sheet = await getBeatSheet(s.port, id);
      if (!sheet.ok) return err(repo(sheet.error));
      if (sheet.value === null) return err({ code: 'not_found' });
      const allowed = new Set(sheet.value.beats.map((b) => b.ref));
      if (fields.beats.some((b) => !allowed.has(b.ref))) return err(settings('节拍只能指向原来的这些见闻'));
      const saved = await updateBeatSheet(s.port, sheet.value, fields, ctx());
      return saved.ok ? sheetView(s.port, saved.value) : err(repo(saved.error));
    },

    /** 作品里的故事事件（B55），按建立的先后。 */
    async storyEvents(): Promise<Result<StoryEvent[], AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const list = await listStoryEvents(s.port);
      return list.ok ? list : err(repo(list.error));
    },

    /** 一章正文段落与故事事件的关联（B55）。 */
    async chapterEventLinks(chapterId: string): Promise<Result<EventLink[], AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const list = await listChapterEventLinks(s.port, chapterId);
      return list.ok ? list : err(repo(list.error));
    },

    /**
     * 采纳的准备（B29、B55）：一份推演写成的候选稿可以带进作品的东西——节拍表回合范围内发生的事（可记为故事事件，
     * 也可同时记为世界事实）、视角角色的这些见闻（可记为他的认知）——以及采纳前必须做的事：
     * 自动接受、尚待复核的裁决要逐条复核；场景里的角色、地点与物品按名字对应到设定，涉及锁定设定的要作者核对。
     */
    async adoptionDraft(candidateId: string): Promise<Result<AdoptionDraft, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const loaded = await adoptionContext(s.port, candidateId);
      return loaded.ok ? ok(loaded.value.draft) : loaded;
    },

    /**
     * 采纳（B29、B55）：作者选定事件、事实，复核过自动接受的裁决后，在一个事务中写入正文（带来源标记）、
     * 故事事件、事件与段落的关联、事实及其来源，并把候选稿标为已接受；写入前保存章节快照（草案采纳验收）。
     * 原文在生成之后改过时不写入，候选稿标为过期。
     */
    async adoptCandidate(request: AdoptionRequest): Promise<Result<AdoptionResult, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const { port } = s;
      const loaded = await adoptionContext(port, request.candidateId);
      if (!loaded.ok) return loaded;
      const { draft, candidate, moment, occurrences, entityOf, lockedNames } = loaded.value;

      const unreviewed = draft.reviews.filter((r) => !request.reviewed.includes(r.requestId));
      if (unreviewed.length > 0) return err(settings(`还有 ${unreviewed.length} 条自动接受的裁决没有复核：自动模式的结果须逐条复核后才能采纳`));
      const chosen = draft.events.filter((e) => request.events.includes(e.key));
      if (chosen.length === 0) return err(settings('请至少选一件事：推演写成的正文要关联它讲述的事件'));
      const draftFile = await deps.drafts.read(s.path, candidate.chapterId);
      if (draftFile.ok && draftFile.value !== null) return err(settings('这一章有未保存的修改：请先打开这一章保存或丢弃'));

      // 事件与事实（人物与地点换成设定的标识；对不上设定的略去）。
      const eventIds = new Map(chosen.map((e) => [e.key, deps.ids.next()]));
      const events: AdoptedEvent[] = chosen.map((e) => {
        const o = occurrences.get(e.key)!;
        const people = [...new Set([...(o.occurrence.actor === undefined ? [] : [o.occurrence.actor]), ...o.occurrence.participants])];
        return {
          id: eventIds.get(e.key)!,
          summary: e.summary,
          participants: people.flatMap((k) => entityOf(k) ?? []),
          locationId: o.occurrence.zones.length === 0 ? null : entityOf(o.occurrence.zones[o.occurrence.zones.length - 1]!),
          perceptions: o.perceivedBy.flatMap((p) => {
            const id = entityOf(p.actor);
            return id === null ? [] : [{ entityId: id, channel: p.channel }];
          }),
          originRunId: moment.runId,
          originSeq: o.seq,
        };
      });
      const facts: AdoptedFact[] = [];
      for (const e of chosen.filter((x) => request.worldFacts.includes(x.key))) {
        const event = events.find((x) => x.id === eventIds.get(e.key))!;
        facts.push({ id: deps.ids.next(), eventId: event.id, input: factInput('world', null, e.summary, event.participants, null, null) });
      }
      const povEntity = entityOf(draft.povKey);
      const beliefs = draft.beliefs.filter((b) => request.beliefs.includes(b.ref));
      if (beliefs.length > 0 && povEntity === null) return err(settings(`视角角色“${draft.povName}”没有对应的人物设定，不能把他的见闻记为认知：先在“设定”里建这个人物`));
      for (const b of beliefs) {
        facts.push({
          id: deps.ids.next(),
          eventId: events[0]?.id ?? null,
          input: factInput('belief', povEntity, b.text, b.about.flatMap((k) => entityOf(k) ?? []), b.modality, b.confidence),
        });
      }
      const touched = new Set(facts.flatMap((f) => [...f.input.subjectIds, ...(f.input.holderId === null ? [] : [f.input.holderId])]));
      const locked = [...touched].flatMap((id) => lockedNames.get(id) ?? []);
      if (locked.length > 0 && !request.confirmLocked) {
        return err(settings(`要写入的事实涉及锁定设定：${[...new Set(locked)].join('、')}。请核对它们没有改变这些设定后，勾选“我已核对涉及锁定设定的内容”再采纳`));
      }

      // 正文：与接受候选稿相同的过期检查与写法（段落来源、生成原文）。
      const paragraphs = await listParagraphs(port, candidate.chapterId);
      if (!paragraphs.ok) return err(repo(paragraphs.error));
      const stale = async () => {
        await setCandidateStatus(port, candidate, 'stale', STALE_REASON, ctx());
        return err(settings(`候选稿已过期：${STALE_REASON}，请重新写成正文`));
      };
      const i = paragraphs.value.findIndex((p) => p.id === candidate.target.from.paragraphId);
      const j = paragraphs.value.findIndex((p) => p.id === candidate.target.to.paragraphId);
      const versions = Object.fromEntries(paragraphs.value.slice(i, j + 1).map((p) => [p.id, p.version]));
      const same =
        i >= 0 &&
        Object.keys(versions).length === Object.keys(candidate.baseVersions).length &&
        Object.entries(candidate.baseVersions).every(([id, v]) => versions[id] === v) &&
        textInRange(paragraphs.value, candidate.target) === candidate.baseText;
      if (!same) return stale();
      const plan = planRangeReplace(paragraphs.value, candidate.target, insertFor(candidate, paragraphs.value), () => deps.ids.next());
      if (!plan.ok) return stale();
      // 写入的段落：新插入的各段，以及文字有变化的那一段（空章节时候选稿写进原有的空段落）。
      const before = paragraphs.value.find((p) => p.id === plan.value.update.id);
      const written = [...(before !== undefined && before.text !== plan.value.update.text ? [plan.value.update.id] : []), ...plan.value.inserts.map((p) => p.id)];

      const snapshot = await createSnapshot(port, { id: deps.ids.next(), chapterId: candidate.chapterId, reason: 'accept_candidate' }, ctx());
      if (!snapshot.ok) return err(repo(snapshot.error));
      const done = await port.transaction([
        ...rangeReplaceStatements(candidate.chapterId, plan.value, ctx()),
        ...adoptionStatements({ candidate, events, facts, paragraphIds: written }, ctx(), () => deps.ids.next()),
      ]);
      if (!done.ok) return done.error.code === 'guard_failed' ? stale() : err(repo({ code: 'sql', error: done.error }));
      const after = await listParagraphs(port, candidate.chapterId);
      if (!after.ok) return err(repo(after.error));
      return ok({ paragraphs: after.value, events: events.length, facts: facts.length });
    },

    /**
     * 按节拍表把视角角色的经历写成正文（B29、B62），存为这一章末尾的候选稿：标为省略的节拍不进入请求。
     * 这一章有未保存的修改时不写；这一章还没有段落时先建一个空段落，候选稿接在它后面。
     */
    async narrateBeatSheet(id: string, chapterId: string, options: CallOptions = {}): Promise<Result<Candidate, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const { port } = s;
      const sheet = await getBeatSheet(port, id);
      if (!sheet.ok) return err(repo(sheet.error));
      if (sheet.value === null) return err({ code: 'not_found' });
      const chapters = await listChapters(port, 'normal');
      if (!chapters.ok) return err(repo(chapters.error));
      const chapter = chapters.value.find((c) => c.id === chapterId);
      if (chapter === undefined) return err(settings('找不到这一章（可能在回收站里）'));
      const draft = await deps.drafts.read(s.path, chapterId);
      if (draft.ok && draft.value !== null) return err(settings(`“${chapter.title}”有未保存的修改：请先打开这一章保存或丢弃`));
      if (sheet.value.beats.every((b) => b.treatment === 'omit')) return err(settings('节拍都标为省略了，没有可写的内容'));

      const loaded = await runOf(port, sheet.value.runId);
      if (!loaded.ok) return loaded;
      const moment = momentAt(loaded.value.scene, sheet.value.runId, loaded.value.events, sheet.value.povActor, sheet.value.upToSeq, sheet.value.fromRound, sheet.value.toRound);
      if (!moment.ok) return moment;
      const prompt = renderCandidateText(moment.value.view, {
        beats: sheet.value.beats.map((b) => ({ ...b, ref: b.ref as KnowledgeId })),
        thoughts: moment.value.thoughts.map((t) => t.text),
        ...(sheet.value.style.trim() !== '' && { style: sheet.value.style.trim() }),
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.text({ prompt: prompt.value, maxOutputTokens: NARRATION_OUTPUT_TOKENS, effort: 'high' }, options);
      if (!result.ok) return result;
      if (result.value.outcome === 'cancelled') return err(settings('已取消'));
      if (result.value.outcome === 'refused') return err(settings(`模型拒绝了这次写作${result.value.refusal?.explanation ? `：${result.value.refusal.explanation}` : ''}`));
      const text = result.value.text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
        .join('\n');
      if (text === '') return err(settings('模型没有写出文字'));

      let paragraphs = await listParagraphs(port, chapterId);
      if (!paragraphs.ok) return err(repo(paragraphs.error));
      if (paragraphs.value.length === 0) {
        const blank = await saveChapterParagraphs(port, chapterId, [], [{ id: deps.ids.next(), text: '', source: 'handwritten' }], { splits: [], merges: [] }, ctx());
        if (!blank.ok) return err(repo(blank.error));
        paragraphs = blank;
      }
      const last = paragraphs.value.at(-1);
      if (last === undefined) return err(settings('这一章没有可以接上的位置'));
      const end = { paragraphId: last.id, offset: last.text.length };
      const call = await findCallByRequestHash(port, result.value.requestHash);
      const created = await createCandidate(
        port,
        {
          id: deps.ids.next(),
          chapterId,
          operation: 'narrate',
          target: { from: end, to: end },
          baseText: '',
          baseVersions: { [last.id]: last.version },
          generated: text,
          llmCallId: call.ok ? (call.value?.id ?? null) : null,
          beatSheetId: sheet.value.id,
        },
        ctx(),
      );
      return created.ok ? created : err(repo(created.error));
    },
  };
}

// 推演写成正文（需求 B29、B45、B62，施工文档 M4-07）：节拍表与按节拍表写成的候选稿。
// 视角正文只用视角角色在那一刻的认知（硬性规则 3）：材料取自 buildCharacterView 生成的角色视图，
// 提示词模板的参数就是这个视图；他人的认知、角色卡、秘密与全局局面都不进入请求。
// 结果先成为候选稿（作者决定 2026-10-14），作者比较、修改后接受才写入章节。
import { ActorId, buildCharacterView, parseScene, type CharacterView, type KnowledgeId, type Scene } from '@fudiao/domain';
import { reduceRun, type RunEvent } from '@fudiao/engine';
import type { CallOptions } from '@fudiao/llm';
import { BeatSheetOutput, renderBeatSheet, renderCandidateText } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  createBeatSheet,
  createCandidate,
  findCallByRequestHash,
  getBeatSheet,
  getSimRun,
  listBeatSheets,
  listChapters,
  listParagraphs,
  saveChapterParagraphs,
  sqlEventStore,
  updateBeatSheet,
  type Beat,
  type BeatSheet,
  type Candidate,
  type RepoError,
  type SimRun,
  type SqlPort,
  type StoredEvent,
} from '@fudiao/store';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';
import { describeObservation } from './sim-describe';

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

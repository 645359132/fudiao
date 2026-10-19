import type {
  ActorId,
  Adjudication,
  ItemId,
  CharacterView,
  KnowledgeId,
  Observation,
  Occurrence,
  RuleViolation,
  RulingRequest,
  Scene,
  SecretCandidate,
  SimState,
} from '@fudiao/domain';
import { clockAt, deliveredSentences } from '@fudiao/domain';
import type { JsonValue } from '@fudiao/shared';
import { err, ok, type Result } from '@fudiao/shared';
import type { z } from 'zod';
import { parseTemplate, render, type RenderContext } from './engine';
import { PARTIAL_SOURCES, TEMPLATE_SOURCES } from './generated/templates';
import { AssistantTurnOutput } from './assistant';
import { modelJsonSchema } from './json-schema';
import { SelfTestOutput } from './self-test';
import { flag, knowledgeModel, namesOf, observationModel, violationModel, viewModel } from './models';
import {
  ActionProposal,
  BaselineOutput,
  BeatSheetOutput,
  BeliefUpdateOutput,
  BookSeedOutput,
  DirectorProposalOutput,
  EvidenceJudgementOutput,
  ChapterReviewOutput,
  ChapterMemoryOutput,
  PlanDraftOutput,
  SceneDraftOutput,
  SemanticRulingOutput,
  StalemateJudgementOutput,
  SynopsisOutput,
} from './schemas';

export type TemplateId = keyof typeof TEMPLATE_SOURCES;

/** 渲染好的提示词，结构与 packages/llm 的请求字段一致，由引擎组装成请求。 */
export type RenderedPrompt = {
  readonly template: { readonly id: string; readonly version: string };
  readonly task: string;
  readonly system: readonly { readonly text: string; readonly cache?: boolean }[];
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly output?: { readonly name: string; readonly schema: { readonly [key: string]: JsonValue } };
};

const OUTPUTS: Readonly<Record<string, z.ZodType>> = {
  SelfTestOutput,
  ActionProposal,
  BaselineOutput,
  SynopsisOutput,
  StalemateJudgementOutput,
  DirectorProposalOutput,
  SemanticRulingOutput,
  BeliefUpdateOutput,
  EvidenceJudgementOutput,
  BeatSheetOutput,
  SceneDraftOutput,
  ChapterReviewOutput,
  ChapterMemoryOutput,
  PlanDraftOutput,
  BookSeedOutput,
  AssistantTurnOutput,
};

function renderTemplate(id: TemplateId, context: RenderContext): Result<RenderedPrompt, string> {
  const parsed = parseTemplate(TEMPLATE_SOURCES[id]);
  if (!parsed.ok) return err(`${id}：${parsed.error}`);
  const { meta, segments } = parsed.value;
  const system: { text: string; cache?: boolean }[] = [];
  const messages: { role: 'user'; content: string }[] = [];
  for (const segment of segments) {
    const text = render(segment.body, context, PARTIAL_SOURCES);
    if (!text.ok) return err(`${id}：${text.error}`);
    if (segment.kind === 'system') system.push({ text: text.value, ...(segment.cache && { cache: true }) });
    else messages.push({ role: 'user', content: text.value });
  }
  const schema = meta.output === undefined ? undefined : OUTPUTS[meta.output];
  if (meta.output !== undefined && schema === undefined) return err(`${id}：未知的输出 schema ${meta.output}`);
  return ok({
    template: { id: meta.id, version: meta.version },
    task: meta.task,
    system,
    messages,
    ...(meta.output !== undefined && schema !== undefined && { output: { name: meta.output, schema: modelJsonSchema(schema) } }),
  });
}

const nameIn = (view: CharacterView, id: string) =>
  view.names.find((n) => n.id === id)?.name ?? (id === view.actorId ? view.self.name : id);

export type ActionPromptOptions =
  | { readonly protocol: 'simultaneous' }
  | {
      readonly protocol: 'turn_based';
      /** 对方正在说的话，听者可以在任一句之后打断。 */
      readonly pendingSpeech?: { readonly speaker: ActorId; readonly sentences: readonly string[] };
    };

/** 角色行动提案。参数只能是角色视图，拿不到世界状态（硬性规则 1、2）。 */
export function renderCharacterAction(view: CharacterView, options: ActionPromptOptions): Result<RenderedPrompt, string> {
  const pending = options.protocol === 'turn_based' ? options.pendingSpeech : undefined;
  return renderTemplate('character_action', {
    ...viewModel(view),
    protocol: { simultaneous: options.protocol === 'simultaneous', turnBased: options.protocol === 'turn_based' },
    pendingSpeech:
      pending === undefined
        ? null
        : {
            speaker: nameIn(view, pending.speaker),
            sentences: pending.sentences.map((text, i) => ({ n: i + 1, text })),
          },
  });
}

/** 提案被规则拒绝后的修正请求。 */
export function renderActionRejected(view: CharacterView, violation: RuleViolation): Result<RenderedPrompt, string> {
  const names = namesOf(view.names);
  return renderTemplate('action_rejected', { violation: violationModel(violation, names) });
}

/** 结构化输出管线的修正消息。 */
export function renderStructuredRepair(issues: readonly string[]): Result<string, string> {
  const rendered = renderTemplate('structured_repair', { issues: [...issues] });
  if (!rendered.ok) return rendered;
  return ok(rendered.value.messages.map((m) => m.content).join('\n\n'));
}

/** 认知更新。fresh 为这一回合新得到的认知条目标识。 */
export function renderBeliefUpdate(view: CharacterView, fresh: readonly KnowledgeId[]): Result<RenderedPrompt, string> {
  return renderTemplate('belief_update', { ...viewModel(view), fresh: [...fresh] });
}

export type RulingInput = {
  readonly scene: Scene;
  readonly state: SimState;
  readonly adjudication: Adjudication;
  readonly request: RulingRequest;
};

/**
 * 语义裁决。裁决者以世界事实为准，可以看到涉及的人与物的真实状态，
 * 但不看场景标题、探索问题与任何人物的内心。
 */
export function renderSemanticRuling(input: RulingInput): Result<RenderedPrompt, string> {
  const { scene, state, adjudication, request } = input;
  const names = namesOf([...scene.zones, ...scene.actors, ...scene.items, ...scene.mechanisms]);
  const involved = new Set<string>(request.actors);
  const itemModel = (id: ItemId) => {
    const item = state.world.items[id];
    return {
      id,
      name: names(id) ?? id,
      holder: item?.location.kind === 'actor' ? names(item.location.actor) : null,
      zone: item?.location.kind === 'zone' ? names(item.location.zone) : null,
      counters: Object.entries(item?.counters ?? {}).map(([name, value]) => ({ name, value })),
    };
  };
  const resolved = adjudication.occurrences
    .filter((o) => o.participants.some((p) => involved.has(p)))
    .map((o): Observation => ({
      occurrence: '',
      channel: 'participant',
      kind: o.kind,
      zones: o.zones,
      ...(o.actor && { actor: o.actor }),
      ...(o.item && { item: o.item }),
      ...(o.target && { target: o.target }),
      ...(o.mechanism && { mechanism: o.mechanism }),
      ...(o.attempted && { attempted: o.attempted }),
      ...(o.violation && { violation: o.violation }),
      ...(o.speech && { speech: { clarity: 'full', sentences: o.speech.sentences, volume: o.speech.volume } }),
    }))
    .map((o) => observationModel(o, names, null));

  return renderTemplate('semantic_ruling', {
    round: state.round,
    time: clockAt(scene, state.round),
    zones: scene.zones.map((z) => ({ id: z.id, name: z.name })),
    edges: scene.edges.map((e) => ({ a: names(e.between[0]) ?? '', b: names(e.between[1]) ?? '', adjacent: e.adjacent, visible: e.visible })),
    narrativeRules: scene.rules.narrativeRules,
    hasNarrativeRules: scene.rules.narrativeRules.length > 0,
    actors: request.actors.map((id) => {
      const actor = state.world.actors[id];
      return {
        id,
        name: names(id) ?? id,
        zone: names(actor?.zone) ?? '',
        injury: flag(actor?.injury ?? 'none'),
        withdrawn: actor?.status === 'withdrawn',
        items: scene.items
          .filter((it) => {
            const loc = state.world.items[it.id]?.location;
            return loc?.kind === 'actor' && loc.actor === id;
          })
          .map((it) => itemModel(it.id)),
      };
    }),
    items: request.items.map(itemModel),
    flags: Object.entries(state.world.flags).map(([key, value]) => ({ key, value })),
    hasFlags: Object.keys(state.world.flags).length > 0,
    actions: request.actions.map((a) => ({
      actor: a.actor,
      actorName: names(a.actor) ?? a.actor,
      k: flag(a.kind),
      target: names(a.target),
      item: names(a.item),
      toZone: names(a.toZone),
      speech: a.utterance === undefined ? null : deliveredSentences(a.utterance).join(''),
      description: a.description ?? null,
      needsRuling: request.semantic.includes(a.actor),
    })),
    contested: request.contested.map((id) => names(id) ?? id),
    hasContested: request.contested.length > 0,
    resolved,
    hasResolved: resolved.length > 0,
  });
}

/** 证据链要对照的一个秘密：标识、文本与涉及的对象。只给判断模型使用。 */
export type EvidenceSecret = { readonly id: string; readonly text: string; readonly subjects: readonly string[] };

/**
 * 证据链命中判断。secrets 是这个人物不知道的全部秘密（不随回合变化）。线索只列一遍：他已有的、涉及这些秘密的
 * 认知条目，按得知的先后（只追加），不含本回合新提出的推测（几条猜测不能互相支撑）。这样同一人物前后几回合的
 * 请求开头相同，服务端的前缀缓存可以命中；推测各自引用秘密，不再为每对推测与秘密重复整份线索。
 */
export function renderEvidenceJudgement(view: CharacterView, candidates: readonly SecretCandidate[], secrets: readonly EvidenceSecret[]): Result<RenderedPrompt, string> {
  const names = namesOf([...view.names, { id: view.actorId, name: view.self.name }]);
  const byId = new Map(view.knowledge.map((k) => [k.id, k]));
  const round = Math.max(0, ...candidates.map((c) => byId.get(c.inference)?.round ?? 0));
  const subjects = new Set(secrets.flatMap((s) => s.subjects));
  const evidence = view.knowledge.filter((k) => (k.modality !== 'inferred' || k.round < round) && k.about.some((ref) => subjects.has(ref)));
  return renderTemplate('evidence_judgement', {
    name: view.self.name,
    secrets: secrets.map((s) => ({ id: s.id, text: s.text })),
    evidence: evidence.map((k) => knowledgeModel(k, names, view.actorId, view.claims)),
    candidates: candidates.map((c) => {
      const inference = byId.get(c.inference);
      return { inference: c.inference, secretId: c.secret, text: inference?.body.kind === 'text' ? inference.body.text : '' };
    }),
  });
}

export type BeatSheetInput = {
  /** 视角角色在对应时点认知中的条目；不在视图中的标识会被拒绝。 */
  readonly materials: readonly KnowledgeId[];
  readonly thoughts: readonly { readonly round: number; readonly text: string }[];
  readonly authorNotes?: string;
};

function povMaterials(view: CharacterView, ids: readonly KnowledgeId[]) {
  const names = namesOf([...view.names, { id: view.actorId, name: view.self.name }]);
  const missing = ids.find((id) => !view.knowledge.some((k) => k.id === id));
  if (missing !== undefined) return err(`${missing} 不在视角人物的认知中`);
  return ok(
    new Map(
      view.knowledge
        .filter((k) => ids.includes(k.id))
        .map((k) => [k.id, knowledgeModel(k, names, view.actorId, view.claims)] as const),
    ),
  );
}

/** 节拍表。材料只能来自视角人物的认知（正文视角验收）。 */
export function renderBeatSheet(view: CharacterView, input: BeatSheetInput): Result<RenderedPrompt, string> {
  const materials = povMaterials(view, input.materials);
  if (!materials.ok) return materials;
  const base = viewModel(view);
  return renderTemplate('beat_sheet', {
    self: base['self'] ?? null,
    card: base['card'] ?? null,
    hasTraits: base['hasTraits'] ?? false,
    materials: input.materials.flatMap((id) => {
      const m = materials.value.get(id);
      return m === undefined ? [] : [m];
    }),
    thoughts: input.thoughts.map((t) => ({ round: t.round, text: t.text })),
    hasThoughts: input.thoughts.length > 0,
    authorNotes: input.authorNotes ?? null,
  });
}

export type CandidateTextInput = {
  readonly beats: readonly {
    readonly ref: KnowledgeId;
    readonly treatment: 'expand' | 'brief' | 'omit' | 'flashback' | 'blank';
    readonly note: string;
    readonly withhold: boolean;
  }[];
  readonly thoughts: readonly string[];
  readonly style?: string;
};

/** 候选稿正文。标记为省略的节拍不进入请求，因此不会出现在正文中。 */
export function renderCandidateText(view: CharacterView, input: CandidateTextInput): Result<RenderedPrompt, string> {
  const kept = input.beats.filter((b) => b.treatment !== 'omit');
  const materials = povMaterials(view, kept.map((b) => b.ref));
  if (!materials.ok) return materials;
  const base = viewModel(view);
  return renderTemplate('candidate_text', {
    self: base['self'] ?? null,
    card: base['card'] ?? null,
    hasTraits: base['hasTraits'] ?? false,
    beats: kept.map((b, i) => ({
      n: i + 1,
      ...flag(b.treatment),
      withhold: b.withhold,
      material: materials.value.get(b.ref) ?? null,
      note: b.note === '' ? null : b.note,
    })),
    thoughts: [...input.thoughts],
    hasThoughts: input.thoughts.length > 0,
    style: input.style ?? null,
  });
}

/**
 * 单次提示词对照组（M0 评估）：把整个场景交给模型直接写成正文。
 * 这是作者侧的提示词，可以看到全部设定与秘密，不受角色视图的限制；它不是角色代理的输入。
 */
export function renderBaseline(scene: Scene, options: { readonly targetLength: number }): Result<RenderedPrompt, string> {
  const names = namesOf([...scene.zones, ...scene.actors, ...scene.items, ...scene.mechanisms]);
  const loose = scene.items.filter((i) => i.location.kind === 'zone');
  return renderTemplate('baseline_scene', {
    targetLength: options.targetLength,
    zones: scene.zones.map((z) => ({ name: z.name })),
    edges: scene.edges.map((e) => ({ a: names(e.between[0]) ?? '', b: names(e.between[1]) ?? '', adjacent: e.adjacent, visible: e.visible })),
    actors: scene.actors.map((a) => ({
      name: a.name,
      zone: names(a.zone) ?? '',
      injury: flag(a.injury),
      card: {
        goal: a.card.goal ?? null,
        bottomLine: a.card.bottomLine ?? null,
        traits: a.card.traits,
        riskPreference: a.card.riskPreference ?? null,
        emotionThreshold: a.card.emotionThreshold ?? null,
        lossOfControl: a.card.lossOfControl ?? null,
        speechStyle: a.card.speechStyle ?? null,
      },
      hasTraits: a.card.traits.length > 0,
      knowledge: a.card.initialKnowledge.map((k) => k.text),
      items: scene.items.filter((i) => i.location.kind === 'actor' && i.location.actor === a.id).map((i) => i.name),
    })),
    looseItems: loose.map((i) => ({ name: i.name, zone: i.location.kind === 'zone' ? (names(i.location.zone) ?? '') : '' })),
    hasLoose: loose.length > 0,
    secrets: scene.secrets.map((s) => s.text),
    hasSecrets: scene.secrets.length > 0,
    rules: scene.rules.narrativeRules,
    hasRules: scene.rules.narrativeRules.length > 0,
  });
}

/** 选区操作（B16）：续写、改写、扩写、缩写、润色。 */
export type SelectionOperation = 'continue' | 'rewrite' | 'expand' | 'shorten' | 'polish';

export type SelectionEditInput = {
  readonly operation: SelectionOperation;
  /** 上下文清单中纳入的材料（作品信息、梗概、设定、事实等），不含前后文与选中的文字。 */
  readonly materials: readonly { readonly title: string; readonly text: string }[];
  readonly before: string;
  readonly selection: string;
  readonly after: string;
  /** 目标字数：续写、扩写、缩写使用。 */
  readonly length: number;
  /** 作者附加的要求，可为空。 */
  readonly instruction: string;
};

/** 选区操作的提示词。这是作者侧的写作辅助，材料来自作者可见的作品内容，不经过角色视图。 */
export function renderSelectionEdit(input: SelectionEditInput): Result<RenderedPrompt, string> {
  return renderTemplate('selection_edit', {
    materials: input.materials.map((m) => ({ title: m.title, text: m.text })),
    before: input.before,
    hasBefore: input.before !== '',
    selection: input.selection,
    hasSelection: input.selection !== '',
    after: input.after,
    hasAfter: input.after !== '',
    length: input.length,
    instruction: input.instruction.trim(),
    isContinue: input.operation === 'continue',
    isRewrite: input.operation === 'rewrite',
    isExpand: input.operation === 'expand',
    isShorten: input.operation === 'shorten',
    isPolish: input.operation === 'polish',
  });
}

/** 能力自检（B57）：固定的结构化输出测试，期望内容见 self-test.ts。 */
export function renderSelfTest(): Result<RenderedPrompt, string> {
  return renderTemplate('self_test', {});
}

/** 模型服务的连接测试（B15）：一个最小的请求，只用来确认地址、凭据与模型可用。 */
export function renderConnectionTest(): Result<RenderedPrompt, string> {
  return renderTemplate('connection_test', {});
}

/**
 * 推演运行的事件梗概（M0 评估的分层比较）。作者侧提示词：读全局事件记录，
 * 与对照组的梗概由同一模型写出，评价时不暴露来源。
 */
export function renderRunSynopsis(
  scene: Scene,
  start: SimState,
  final: SimState,
  rounds: readonly { readonly round: number; readonly occurrences: readonly Occurrence[] }[],
): Result<RenderedPrompt, string> {
  const names = sceneNames(scene);
  return renderTemplate('run_synopsis', {
    actors: scene.actors.map((a) => ({ name: a.name })),
    start: actorStates(scene, start, names),
    rounds: globalRounds(rounds, names),
    final: actorStates(scene, final, names),
  });
}

type RoundRecord = { readonly round: number; readonly occurrences: readonly Occurrence[] };

const sceneNames = (scene: Scene) => namesOf([...scene.zones, ...scene.actors, ...scene.items, ...scene.mechanisms]);

/** 作者侧提示词中的“发生的事”：按全局记录完整呈现，不经过任何角色的感知。 */
function occurrenceAsObservation(o: Occurrence, options: { readonly hideWhispers?: boolean } = {}): Observation {
  const hidden = options.hideWhispers === true && o.speech?.volume === 'whisper';
  return {
    occurrence: o.id,
    channel: 'participant',
    kind: o.kind,
    zones: o.zones,
    ...(o.actor && { actor: o.actor }),
    ...(o.item && { item: o.item }),
    ...(o.target && { target: o.target }),
    ...(o.mechanism && { mechanism: o.mechanism }),
    ...(o.attempted && { attempted: o.attempted }),
    ...(o.kind === 'failed_attempt' && { failed: true as const }),
    ...(o.speech && { speech: hidden ? { clarity: 'muffled' } : { clarity: 'full', sentences: o.speech.sentences, volume: o.speech.volume } }),
    ...(o.description && { description: o.description }),
  };
}

function globalRounds(rounds: readonly RoundRecord[], names: ReturnType<typeof namesOf>, options: { readonly hideWhispers?: boolean } = {}) {
  return rounds.map((r) => ({
    round: r.round,
    // 观察与发现机关不改变局面，不列出。
    events: r.occurrences
      .filter((o) => o.kind !== 'observe' && o.kind !== 'discovered')
      .map((o) => observationModel(occurrenceAsObservation(o, options), names, null)),
  }));
}

function actorStates(scene: Scene, state: SimState, names: ReturnType<typeof namesOf>) {
  return scene.actors.map((a) => {
    const s = state.world.actors[a.id];
    return { name: a.name, zone: names(s?.zone) ?? '', injury: flag(s?.injury ?? 'none'), withdrawn: s?.status === 'withdrawn' };
  });
}

/**
 * 僵局判断（M0-07）：作者侧请求，读最近几回合的全局记录与各人的当前目标，
 * 不读任何角色的认知与内心。
 */
export function renderStalemateJudgement(scene: Scene, rounds: readonly RoundRecord[]): Result<RenderedPrompt, string> {
  const names = sceneNames(scene);
  return renderTemplate('stalemate_judgement', {
    actors: scene.actors.map((a) => ({ name: a.name, goal: a.card.goal ?? '' })),
    window: rounds.length,
    rounds: globalRounds(rounds, names),
  });
}

export type DirectorInput = {
  readonly scene: Scene;
  readonly state: SimState;
  readonly recent: readonly RoundRecord[];
  readonly tensionCurve: string;
  readonly maxRounds: number;
  /** 触发方式为僵局时，检测到的僵局类型。 */
  readonly stalemate?: 'standoff' | 'repetition' | 'circling' | 'polite_resolution';
};

/**
 * 导演提议（B47 简化形式）。导演透镜只含全局局面与张力曲线：
 * 不含任何角色的认知、角色卡、内心片段与秘密原文，导演不改变角色的决策与认知。
 */
export function renderDirectorProposal(input: DirectorInput): Result<RenderedPrompt, string> {
  const { scene, state } = input;
  const names = sceneNames(scene);
  const flags = Object.entries(state.world.flags).map(([key, value]) => ({ key, value }));
  return renderTemplate('director_proposal', {
    zones: scene.zones.map((z) => ({ id: z.id, name: z.name })),
    flags,
    hasFlags: flags.length > 0,
    curve: input.tensionCurve,
    round: state.round,
    time: clockAt(scene, state.round),
    maxRounds: input.maxRounds,
    stalemate: input.stalemate === undefined ? null : flag(input.stalemate),
    actors: actorStates(scene, state, names),
    items: scene.items.map((i) => {
      const loc = state.world.items[i.id]?.location;
      return {
        name: i.name,
        holder: loc?.kind === 'actor' ? names(loc.actor) : null,
        zone: loc?.kind === 'zone' ? names(loc.zone) : null,
      };
    }),
    // 导演的外部事件会按感知分发给角色：耳语的内容导演用不上，不给，免得经事件描述传给听不到的人。
    rounds: globalRounds(input.recent, names, { hideWhispers: true }),
  });
}

/** 场景配置草稿（B39）。 */
export function renderSceneDraft(description: string): Result<RenderedPrompt, string> {
  return renderTemplate('scene_draft', { description });
}

export type WriterChapterInput = {
  readonly title: string;
  readonly genre: string;
  readonly chapterTitle: string;
  readonly goal: string;
  readonly treatment: string;
  /** 本章所在的卷（B68）：卷名与本卷简介；未分卷时省略。 */
  readonly volume?: { readonly title: string; readonly summary: string };
  /** 启用的写作技能：名称、适用说明（SKILL.md 的 description）与指令。 */
  readonly skills: readonly { readonly name: string; readonly description: string; readonly text: string }[];
  readonly avoidPhrases: readonly string[];
  /** state：长篇记忆中这个人物最近一次出场后的状态，没有时为空。 */
  readonly cast: readonly { readonly name: string; readonly description: string; readonly state: string }[];
  /**
   * 人物关系网（B73）中适用于本章、至少一端出场的关系。读作“from 是 to 的 label”，mutual 时为“from 与 to：label”；
   * secret 为读者还不知道的关系（可以暗示，不要点明）。
   */
  readonly relations?: readonly WriterRelation[];
  readonly facts: readonly string[];
  /** 前面章节的梗概，从远到近。 */
  readonly memories: readonly { readonly title: string; readonly summary: string }[];
  readonly toPlant: readonly { readonly title: string; readonly content: string }[];
  /** progress：长篇记忆中这条伏笔在前面各章的进展，从远到近。 */
  readonly toPayoff: readonly { readonly title: string; readonly content: string; readonly reveal: string; readonly progress: readonly string[] }[];
  /** 本章不得说破的揭晓内容。 */
  readonly mustNotReveal: readonly string[];
  /** 上一章结尾留下、本章要接住的事（B74，取自上一章的长篇记忆）。 */
  readonly openThreads?: readonly string[];
  readonly beatsBefore: readonly string[];
  readonly beatsNow: readonly string[];
  readonly beatsAfter: readonly string[];
  readonly previousEnding: string;
  /** 本章已有正文的结尾部分。 */
  readonly written: string;
  readonly words: number;
  readonly isLast: boolean;
};

export type WriterRelation = { readonly from: string; readonly to: string; readonly label: string; readonly mutual: boolean; readonly description: string; readonly secret: boolean };

/**
 * 写手成章（B59）：作者侧的写作，材料是作者的计划、设定、伏笔账本与前文，输出纯文本。
 * 从角色推演写成的单视角正文不走这个模板（那里只能用视角角色的认知，硬性规则 3）。
 */
export function renderWriterChapter(input: WriterChapterInput): Result<RenderedPrompt, string> {
  return renderTemplate('writer_chapter', {
    title: input.title,
    genre: input.genre,
    chapterTitle: input.chapterTitle,
    volumeTitle: input.volume?.title ?? '',
    volumeSummary: input.volume?.summary.trim() ?? '',
    goal: input.goal,
    treatment: input.treatment.trim(),
    // 说明常以“名称：”开头（与【名称】重复），去掉这一截。
    skills: input.skills.map((s) => ({ name: s.name, description: withoutName(s.name, s.description.trim()), text: s.text })),
    hasSkills: input.skills.length > 0,
    avoidPhrases: [...input.avoidPhrases],
    hasAvoid: input.avoidPhrases.length > 0,
    cast: input.cast.map((c) => ({ name: c.name, description: c.description.trim(), state: c.state.trim() })),
    hasCast: input.cast.length > 0,
    relations: (input.relations ?? []).map((r) => ({ ...r, description: r.description.trim() })),
    hasRelations: (input.relations ?? []).length > 0,
    hasSecretRelations: (input.relations ?? []).some((r) => r.secret),
    facts: [...input.facts],
    hasFacts: input.facts.length > 0,
    memories: input.memories.map((m) => ({ title: m.title, summary: m.summary })),
    hasMemories: input.memories.length > 0,
    toPlant: input.toPlant.map((f) => ({ title: f.title, content: f.content })),
    hasToPlant: input.toPlant.length > 0,
    toPayoff: input.toPayoff.map((f) => ({ title: f.title, content: f.content, reveal: f.reveal, progress: [...f.progress], hasProgress: f.progress.length > 0 })),
    hasToPayoff: input.toPayoff.length > 0,
    mustNotReveal: [...input.mustNotReveal],
    hasMustNotReveal: input.mustNotReveal.length > 0,
    openThreads: [...(input.openThreads ?? [])],
    hasOpenThreads: (input.openThreads ?? []).length > 0,
    beatsBefore: [...input.beatsBefore],
    beatsNow: [...input.beatsNow],
    beatsAfter: [...input.beatsAfter],
    hasBeats: input.beatsBefore.length + input.beatsNow.length + input.beatsAfter.length > 0,
    hasBeatsNow: input.beatsNow.length > 0,
    previousEnding: input.previousEnding,
    written: input.written,
    words: input.words,
    isLast: input.isLast,
  });
}

/** 一章梗概的字数上限。 */
export const MEMORY_SUMMARY_WORDS = 300;

export type ChapterMemoryInput = {
  readonly title: string;
  readonly chapterTitle: string;
  /** 人物设定的名字。 */
  readonly characters: readonly string[];
  /** 尚未废弃的伏笔。 */
  readonly foreshadows: readonly { readonly title: string; readonly content: string; readonly reveal: string }[];
  readonly text: string;
};

/** 长篇记忆（B66）：作者侧的整理，材料是本章正文、人物设定的名字与伏笔账本。 */
export function renderChapterMemory(input: ChapterMemoryInput): Result<RenderedPrompt, string> {
  return renderTemplate('chapter_memory', {
    title: input.title,
    chapterTitle: input.chapterTitle,
    characters: input.characters.map((name) => ({ name })),
    hasCharacters: input.characters.length > 0,
    foreshadows: input.foreshadows.map((f) => ({ title: f.title, content: f.content, reveal: f.reveal.trim() })),
    hasForeshadows: input.foreshadows.length > 0,
    text: input.text,
    summaryWords: MEMORY_SUMMARY_WORDS,
  });
}

export type ChapterReviewInput = {
  readonly title: string;
  readonly chapterTitle: string;
  /** 带标签的设定：本章的出场人物与正文中提到的设定。state 是长篇记忆中最近的状态，没有时为空。 */
  readonly entities: readonly { readonly label: string; readonly name: string; readonly kind: string; readonly locked: boolean; readonly description: string; readonly state: string }[];
  readonly facts: readonly { readonly label: string; readonly content: string }[];
  /** 前面章节的梗概，从远到近。 */
  readonly memories: readonly { readonly title: string; readonly summary: string }[];
  /** 章节计划；作者手写、没有计划的章节为 null。 */
  readonly plan: { readonly goal: string; readonly treatment: string; readonly cast: readonly string[]; readonly beats: readonly string[] } | null;
  /** role：这条伏笔在本章的要求（要埋、要回收、不得说破）。 */
  readonly foreshadows: readonly { readonly label: string; readonly title: string; readonly role: string; readonly content: string; readonly reveal: string }[];
  readonly paragraphs: readonly { readonly label: string; readonly text: string }[];
};

/** 审核（B64）：作者侧的检查，材料是本章正文、章节计划、相关的设定、事实、伏笔与前文梗概。 */
export function renderChapterReview(input: ChapterReviewInput): Result<RenderedPrompt, string> {
  return renderTemplate('chapter_review', {
    title: input.title,
    chapterTitle: input.chapterTitle,
    entities: input.entities.map((e) => ({ label: e.label, name: e.name, kind: e.kind, locked: e.locked, description: e.description.trim(), state: e.state.trim() })),
    hasEntities: input.entities.length > 0,
    facts: input.facts.map((f) => ({ label: f.label, content: f.content })),
    hasFacts: input.facts.length > 0,
    memories: input.memories.map((m) => ({ title: m.title, summary: m.summary })),
    hasMemories: input.memories.length > 0,
    hasPlan: input.plan !== null,
    goal: input.plan?.goal ?? '',
    treatment: input.plan?.treatment.trim() ?? '',
    cast: [...(input.plan?.cast ?? [])],
    hasCast: (input.plan?.cast.length ?? 0) > 0,
    beats: [...(input.plan?.beats ?? [])],
    hasBeats: (input.plan?.beats.length ?? 0) > 0,
    foreshadows: input.foreshadows.map((f) => ({ label: f.label, title: f.title, role: f.role, content: f.content, reveal: f.reveal.trim() })),
    hasForeshadows: input.foreshadows.length > 0,
    paragraphs: input.paragraphs.map((p) => ({ label: p.label, text: p.text })),
  });
}

export type WriterReviseInput = {
  readonly title: string;
  readonly chapterTitle: string;
  readonly avoidPhrases: readonly string[];
  /** 问题引用的依据，已写成文字（例如“设定 林舟：落魄书生”）。 */
  readonly evidence: readonly string[];
  readonly mustNotReveal: readonly string[];
  /** 前一段与后一段，没有时为空。 */
  readonly before: string;
  readonly paragraph: string;
  readonly after: string;
  readonly issues: readonly { readonly quote: string; readonly description: string; readonly suggestion: string }[];
};

/** 写手修订（B64）：只改审核问题所在的一段，输出纯文本。 */
export function renderWriterRevise(input: WriterReviseInput): Result<RenderedPrompt, string> {
  return renderTemplate('writer_revise', {
    title: input.title,
    chapterTitle: input.chapterTitle,
    avoidPhrases: [...input.avoidPhrases],
    hasAvoid: input.avoidPhrases.length > 0,
    evidence: [...input.evidence],
    hasEvidence: input.evidence.length > 0,
    mustNotReveal: [...input.mustNotReveal],
    hasMustNotReveal: input.mustNotReveal.length > 0,
    before: input.before,
    paragraph: input.paragraph,
    after: input.after,
    issues: input.issues.map((i) => ({ quote: i.quote, description: i.description, suggestion: i.suggestion.trim() })),
  });
}

/** 作品中启用的规划技能（B75）：生成作品骨架与章节计划时带上。 */
export type PlanningSkill = { readonly name: string; readonly description: string; readonly text: string };

const skillsData = (skills: readonly PlanningSkill[]) => ({
  skills: skills.map((s) => ({ name: s.name, description: withoutName(s.name, s.description.trim()), text: s.text })),
  hasSkills: skills.length > 0,
});

export type PlanDraftInput = {
  readonly title: string;
  readonly genre: string;
  readonly synopsis: string;
  readonly outline: string;
  /** 人物设定的名字与说明（说明可为空）。 */
  readonly characters: readonly { readonly name: string; readonly description: string }[];
  readonly skills: readonly PlanningSkill[];
  readonly chapters: readonly string[];
  /** 作品已有的卷名（B68），按顺序；没有分卷时为空。 */
  readonly volumes?: readonly string[];
  readonly foreshadows: readonly { readonly title: string; readonly content: string; readonly reveal: string }[];
  readonly chapterCount: number;
  readonly wordsPerChapter: number;
};

/** 章节计划草稿（B65）：作者侧的规划，材料是作者的大纲、设定与已有的伏笔。 */
export function renderPlanDraft(input: PlanDraftInput): Result<RenderedPrompt, string> {
  return renderTemplate('plan_draft', {
    title: input.title,
    genre: input.genre,
    synopsis: input.synopsis,
    outline: input.outline,
    characters: input.characters.map((c) => ({ name: c.name, description: c.description.trim() })),
    hasCharacters: input.characters.length > 0,
    ...skillsData(input.skills),
    chapters: input.chapters.map((title) => ({ title })),
    hasChapters: input.chapters.length > 0,
    volumes: (input.volumes ?? []).map((title) => ({ title })),
    hasVolumes: (input.volumes ?? []).length > 0,
    foreshadows: input.foreshadows.map((f) => ({ title: f.title, content: f.content, reveal: f.reveal })),
    hasForeshadows: input.foreshadows.length > 0,
    chapterCount: input.chapterCount,
    wordsPerChapter: input.wordsPerChapter,
  });
}

/** 技能的适用说明常以“名称：”开头，与【名称】重复，去掉这一截。 */
function withoutName(name: string, description: string): string {
  for (const sep of ['：', ':']) {
    if (description.startsWith(name + sep)) return description.slice(name.length + sep.length).trim();
  }
  return description;
}

export type BookSeedInput = {
  readonly idea: string;
  readonly genre: string;
  /** 作者已定的作品名；没有时为空，由模型拟。 */
  readonly title: string;
  readonly characters: readonly string[];
  readonly skills: readonly PlanningSkill[];
  readonly chapterCount: number;
  readonly wordsPerChapter: number;
};

/** 作品骨架（B67）：作者侧的规划，材料只有作者的想法与已有的人物名。 */
export function renderBookSeed(input: BookSeedInput): Result<RenderedPrompt, string> {
  return renderTemplate('book_seed', {
    idea: input.idea,
    genre: input.genre,
    title: input.title,
    characters: input.characters.map((name) => ({ name })),
    hasCharacters: input.characters.length > 0,
    ...skillsData(input.skills),
    chapterCount: input.chapterCount,
    wordsPerChapter: input.wordsPerChapter,
  });
}

/** 助手看到的作品现状（B69）：每一步都按最新的数据重新给出。 */
export type AssistantState = {
  readonly works: readonly string[];
  /** 正在后台进行的任务（写手、审核、推演等），一句话一项；没有时为空。 */
  readonly running?: readonly string[];
  /** 上一句话之后在后台做完的事（单章的写作、审核与修订，M5-23），一句话一件。 */
  readonly finished?: readonly string[];
  /** 为了放进模型的上下文，这一步缩减了对话与现状。 */
  readonly trimmed?: boolean;
  readonly work: null | {
    readonly title: string;
    readonly genre: string;
    readonly synopsis: string;
    readonly outline: string;
    readonly volumes: readonly { readonly id: string; readonly title: string; readonly summary: string }[];
    readonly chapters: readonly { readonly id: string; readonly title: string; readonly volume: string; readonly words: number; readonly plan: string }[];
    readonly chapterCount: number;
    /** 全书（回收站以外）的字数与有章节计划的章数：章节只列出一部分时，助手说数字也有据可依。 */
    readonly totalWords?: number;
    readonly plannedCount?: number;
    /** 章节太多时只列出前后部分。 */
    readonly omitted: boolean;
    readonly entities: readonly { readonly id: string; readonly kind: string; readonly name: string; readonly locked: boolean }[];
    /** 设定的总数（只列出一部分时）。 */
    readonly entityCount?: number;
    /** 回收站里的章节。 */
    readonly trashed: readonly { readonly id: string; readonly title: string }[];
    /**
     * 人物关系网（B73）：读作“from 是 to 的 label”，mutual 时“from 与 to：label”；category 为类别的中文名；
     * range 为适用的章节范围（例如“第三章起”），不限时为空。太多时只列前面的部分。
     */
    readonly relations?: readonly { readonly id: string; readonly from: string; readonly to: string; readonly label: string; readonly mutual: boolean; readonly secret: boolean; readonly category: string; readonly range: string }[];
    readonly relationCount?: number;
    /** 已记下的作者偏好（B74）。 */
    readonly preferences?: readonly string[];
    /** 作者正在看的页面或章节；没有时为空。 */
    readonly current: string;
    /** 作者在正文里选中的文字（edit_selection 的对象）；没有选中时为 null。太长时 text 只含开头与结尾。 */
    readonly selection: null | { readonly chapter: string; readonly text: string; readonly length: number; readonly clipped: boolean };
  };
};

export type AssistantResult = { readonly tool: string; readonly ok: boolean; readonly detail: string };

/** 对话记录：作者的话、助手每一步的输出、动作的结果。 */
export type AssistantHistoryItem =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly output: AssistantTurnOutput }
  | { readonly role: 'results'; readonly results: readonly AssistantResult[] };

function renderPartial(name: string, context: RenderContext): Result<string, string> {
  const source = PARTIAL_SOURCES[name];
  if (source === undefined) return err(`局部模板 ${name} 不存在`);
  return render(source, context, PARTIAL_SOURCES);
}

/**
 * 助手的一步（B69）：系统提示（规则与动作说明）不变；之前的对话按原样排在前面（只追加，便于命中前缀缓存）；
 * 最后一条消息给出作品现状与最新的请求或动作结果。连续的同一方消息合并成一条。
 */
export function renderAssistantTurn(input: { readonly history: readonly AssistantHistoryItem[]; readonly state: AssistantState }): Result<RenderedPrompt, string> {
  const last = input.history.at(-1);
  if (last === undefined || last.role === 'assistant') return err('助手的一步须以作者的话或动作结果结尾');
  const rendered = renderTemplate('assistant_turn', {
    works: [...input.state.works],
    running: [...(input.state.running ?? [])],
    hasRunning: (input.state.running ?? []).length > 0,
    finished: [...(input.state.finished ?? [])],
    hasFinished: (input.state.finished ?? []).length > 0,
    trimmed: input.state.trimmed === true,
    work:
      input.state.work === null
        ? null
        : {
            ...input.state.work,
            volumes: [...input.state.work.volumes],
            chapters: [...input.state.work.chapters],
            entities: [...input.state.work.entities],
            trashed: [...input.state.work.trashed],
            hasVolumes: input.state.work.volumes.length > 0,
            hasTrashed: input.state.work.trashed.length > 0,
            preferences: [...(input.state.work.preferences ?? [])],
            hasPreferences: (input.state.work.preferences ?? []).length > 0,
            relations: [...(input.state.work.relations ?? [])],
            hasRelations: (input.state.work.relationCount ?? (input.state.work.relations ?? []).length) > 0,
            relationCount: input.state.work.relationCount ?? (input.state.work.relations ?? []).length,
            relationsOmitted: (input.state.work.relationCount ?? 0) > (input.state.work.relations ?? []).length,
            entityCount: input.state.work.entityCount ?? input.state.work.entities.length,
            entitiesOmitted: (input.state.work.entityCount ?? 0) > input.state.work.entities.length,
            selection: input.state.work.selection === null ? null : { ...input.state.work.selection },
          },
    hasResults: last.role === 'results',
    results: last.role === 'results' ? last.results.map((r) => ({ ...r })) : [],
    request: last.role === 'user' ? last.text : '',
  });
  if (!rendered.ok) return rendered;
  const earlier: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const item of input.history.slice(0, -1)) {
    const text =
      item.role === 'assistant'
        ? ok(JSON.stringify(item.output))
        : item.role === 'user'
          ? renderPartial('assistant_request', { request: item.text })
          : renderPartial('assistant_results', { results: item.results.map((r) => ({ ...r })) });
    if (!text.ok) return text;
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const previous = earlier.at(-1);
    if (previous !== undefined && previous.role === role) previous.content = `${previous.content}\n\n${text.value}`;
    else earlier.push({ role, content: text.value });
  }
  const final = rendered.value.messages.at(-1);
  if (final === undefined) return err('助手模板缺少给模型的消息');
  const messages = earlier.at(-1)?.role === 'user' ? [...earlier.slice(0, -1), { role: 'user' as const, content: `${earlier.at(-1)?.content ?? ''}\n\n${final.content}` }] : [...earlier, final];
  return ok({ ...rendered.value, messages });
}

export const TEMPLATE_IDS = Object.keys(TEMPLATE_SOURCES) as TemplateId[];

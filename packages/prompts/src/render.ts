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
import { deliveredSentences } from '@fudiao/domain';
import type { JsonValue } from '@fudiao/shared';
import { err, ok, type Result } from '@fudiao/shared';
import type { z } from 'zod';
import { parseTemplate, render, type RenderContext } from './engine';
import { PARTIAL_SOURCES, TEMPLATE_SOURCES } from './generated/templates';
import { modelJsonSchema } from './json-schema';
import { SelfTestOutput } from './self-test';
import { flag, knowledgeModel, namesOf, observationModel, violationModel, viewModel } from './models';
import {
  ActionProposal,
  BaselineOutput,
  BeatSheetOutput,
  BeliefUpdateOutput,
  DirectorProposalOutput,
  EvidenceJudgementOutput,
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
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[];
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
      needsRuling: request.semantic.includes(a.actor),
    })),
    contested: request.contested.map((id) => names(id) ?? id),
    hasContested: request.contested.length > 0,
    resolved,
    hasResolved: resolved.length > 0,
  });
}

/** 证据链命中判断。secrets 为秘密标识到秘密文本的映射，只给判断模型使用。 */
export function renderEvidenceJudgement(
  view: CharacterView,
  candidates: readonly SecretCandidate[],
  secrets: Readonly<Record<string, string>>,
): Result<RenderedPrompt, string> {
  const names = namesOf([...view.names, { id: view.actorId, name: view.self.name }]);
  const byId = new Map(view.knowledge.map((k) => [k.id, k]));
  const items = candidates.map((c) => {
    const inference = byId.get(c.inference);
    return {
      inference: c.inference,
      text: inference?.body.kind === 'text' ? inference.body.text : '',
      secret: secrets[c.secret] ?? '',
      evidence: c.evidence.flatMap((id) => {
        const k = byId.get(id);
        return k === undefined ? [] : [knowledgeModel(k, names, view.actorId, view.claims)];
      }),
    };
  });
  return renderTemplate('evidence_judgement', { candidates: items });
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
  final: SimState,
  rounds: readonly { readonly round: number; readonly occurrences: readonly Occurrence[] }[],
): Result<RenderedPrompt, string> {
  const names = sceneNames(scene);
  return renderTemplate('run_synopsis', {
    actors: scene.actors.map((a) => ({ name: a.name })),
    rounds: globalRounds(rounds, names),
    final: actorStates(scene, final, names),
  });
}

type RoundRecord = { readonly round: number; readonly occurrences: readonly Occurrence[] };

const sceneNames = (scene: Scene) => namesOf([...scene.zones, ...scene.actors, ...scene.items, ...scene.mechanisms]);

/** 作者侧提示词中的“发生的事”：按全局记录完整呈现，不经过任何角色的感知。 */
function occurrenceAsObservation(o: Occurrence): Observation {
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
    ...(o.speech && { speech: { clarity: 'full', sentences: o.speech.sentences, volume: o.speech.volume } }),
    ...(o.description && { description: o.description }),
  };
}

function globalRounds(rounds: readonly RoundRecord[], names: ReturnType<typeof namesOf>) {
  return rounds.map((r) => ({
    round: r.round,
    // 观察与发现机关不改变局面，不列出。
    events: r.occurrences
      .filter((o) => o.kind !== 'observe' && o.kind !== 'discovered')
      .map((o) => observationModel(occurrenceAsObservation(o), names, null)),
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
  readonly stalemate?: 'standoff' | 'repetition' | 'polite_resolution';
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
    rounds: globalRounds(input.recent, names),
  });
}

/** 场景配置草稿（B39）。 */
export function renderSceneDraft(description: string): Result<RenderedPrompt, string> {
  return renderTemplate('scene_draft', { description });
}

export const TEMPLATE_IDS = Object.keys(TEMPLATE_SOURCES) as TemplateId[];

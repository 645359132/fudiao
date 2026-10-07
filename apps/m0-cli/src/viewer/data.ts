import {
  applyEvent,
  buildCharacterView,
  initialState,
  type CharacterView,
  type Observation,
  type Scene,
  type SimState,
} from '@fudiao/domain';
import type { RunEvent } from '@fudiao/engine';

// 静态查看页的数据：只由事件记录回放得到，不调用模型（硬性规则 9）。
// “角色所见”直接取自 buildCharacterView，与实际发给角色代理的信息一致。

export type ViewerKnowledge = {
  readonly id: string;
  readonly round: number;
  readonly modality: string;
  readonly confidence: number | null;
  readonly order: number;
  readonly concerning: string | null;
  readonly text: string | null;
  readonly observation: Observation | null;
  readonly claim: { readonly speaker: string; readonly sentences: readonly string[] } | null;
};

export type ViewerView = {
  readonly zone: string;
  readonly injury: string;
  readonly status: string;
  readonly items: readonly string[];
  readonly visibleActors: readonly { readonly name: string; readonly zone: string; readonly holding: readonly string[] }[];
  readonly visibleItems: readonly { readonly name: string; readonly zone: string }[];
  readonly mechanisms: readonly string[];
  readonly knowledge: readonly ViewerKnowledge[];
};

export type ViewerRound = {
  readonly round: number;
  readonly proposals: readonly {
    readonly actor: string;
    readonly kind: string;
    readonly target: string | null;
    readonly item: string | null;
    readonly toZone: string | null;
    readonly sentences: readonly string[];
    readonly intent: string | null;
    readonly rationale: string | null;
    readonly innerThought: string | null;
    readonly source: string;
    readonly rejected: string | null;
  }[];
  readonly rulings: readonly {
    readonly requestId: string;
    readonly rationale: string;
    readonly uncertainties: readonly string[];
    readonly by: string | null;
    readonly needsReview: boolean;
  }[];
  readonly occurrences: readonly {
    readonly id: string;
    readonly kind: string;
    readonly actor: string | null;
    readonly zones: readonly string[];
    readonly item: string | null;
    readonly target: string | null;
    readonly sentences: readonly string[];
    readonly visual: string | null;
    readonly sound: string | null;
    readonly perceivedBy: readonly { readonly actor: string; readonly channel: string }[];
  }[];
  readonly world: {
    readonly actors: readonly { readonly id: string; readonly name: string; readonly zone: string; readonly injury: string; readonly status: string }[];
    readonly items: readonly { readonly name: string; readonly where: string; readonly counters: Readonly<Record<string, number>> }[];
    readonly flags: Readonly<Record<string, boolean>>;
    readonly mechanisms: readonly { readonly name: string; readonly zone: string; readonly armed: boolean }[];
  };
  readonly views: Readonly<Record<string, ViewerView>>;
  readonly notes: readonly string[];
};

export type ViewerData = {
  readonly runId: string;
  readonly title: string;
  readonly protocol: string;
  readonly mode: string;
  readonly endReason: string | null;
  readonly actors: readonly { readonly id: string; readonly name: string }[];
  readonly names: Readonly<Record<string, string>>;
  readonly rounds: readonly ViewerRound[];
};

function viewOf(view: CharacterView, name: (id: string) => string): ViewerView {
  return {
    zone: name(view.self.zone),
    injury: view.self.injury,
    status: view.self.status,
    items: view.self.items.map((i) => `${i.name}${Object.entries(i.counters).map(([k, v]) => `（${k} ${v}）`).join('')}`),
    visibleActors: view.visible.actors.map((a) => ({ name: a.name, zone: name(a.zone), holding: a.holding.map((h) => h.name) })),
    visibleItems: view.visible.items.map((i) => ({ name: i.name, zone: name(i.zone) })),
    mechanisms: view.visible.mechanisms.map((m) => `${m.name}（${name(m.zone)}）`),
    knowledge: view.knowledge.map((k) => {
      const body = k.body;
      const claim = body.kind === 'claim' ? view.claims.find((c) => c.id === body.claim) : undefined;
      return {
        id: k.id,
        round: k.round,
        modality: k.modality,
        confidence: k.confidence,
        order: k.order,
        concerning: k.concerning ?? null,
        text: body.kind === 'text' ? body.text : null,
        observation: body.kind === 'observation' ? body.observation : null,
        claim: claim ? { speaker: claim.speaker, sentences: claim.sentences } : null,
      };
    }),
  };
}

const SOURCE = { model: '模型', author: '作者替换', prepared: '上一回合的回应' } as const;

export function buildViewerData(scene: Scene, runId: string, events: readonly RunEvent[]): ViewerData {
  const names: Record<string, string> = {};
  for (const e of [...scene.zones, ...scene.actors, ...scene.items, ...scene.mechanisms]) names[e.id] = e.name;
  const name = (id: string) => names[id] ?? id;

  const start = events[0];
  if (start?.type !== 'RunStarted') throw new Error('运行记录缺少 RunStarted');
  let sim: SimState = initialState(scene, start.config.seed);
  const rounds: ViewerRound[] = [];
  let current: {
    proposals: ViewerRound['proposals'][number][];
    rulings: Map<string, ViewerRound['rulings'][number]>;
    occurrences: ViewerRound['occurrences'][number][];
    notes: string[];
  } = { proposals: [], rulings: new Map(), occurrences: [], notes: [] };
  let endReason: string | null = null;

  const snapshot = (round: number): ViewerRound => ({
    round,
    proposals: current.proposals,
    rulings: [...current.rulings.values()],
    occurrences: current.occurrences,
    world: {
      actors: scene.actors.map((a) => {
        const s = sim.world.actors[a.id];
        return { id: a.id, name: a.name, zone: name(s?.zone ?? ''), injury: s?.injury ?? '', status: s?.status ?? '' };
      }),
      items: scene.items.map((i) => {
        const s = sim.world.items[i.id];
        const loc = s?.location;
        return {
          name: i.name,
          where: loc === undefined ? '' : loc.kind === 'actor' ? `${name(loc.actor)}手里` : name(loc.zone),
          counters: s?.counters ?? {},
        };
      }),
      flags: sim.world.flags,
      mechanisms: scene.mechanisms.map((m) => ({ name: m.name, zone: name(m.zone), armed: sim.world.mechanisms[m.id]?.armed ?? false })),
    },
    views: Object.fromEntries(scene.actors.map((a) => [a.id, viewOf(buildCharacterView(scene, sim, a.id), name)])),
    notes: current.notes,
  });

  for (const event of events.slice(1)) {
    switch (event.type) {
      case 'RoundStarted':
      case 'BeliefsUpdated':
      case 'KnowledgeEdited': {
        const next = applyEvent(scene, sim, event);
        if (next.ok) sim = next.value;
        break;
      }
      case 'StateChanged': {
        const next = applyEvent(scene, sim, event);
        if (next.ok) sim = next.value;
        for (const o of event.occurrences) {
          current.occurrences.push({
            id: o.id,
            kind: o.kind,
            actor: o.actor ? name(o.actor) : null,
            zones: o.zones.map(name),
            item: o.item ? name(o.item) : null,
            target: o.target ? name(o.target) : null,
            sentences: o.speech?.sentences ?? [],
            visual: o.description?.visual ?? null,
            sound: o.description?.sound ?? null,
            perceivedBy: [],
          });
        }
        break;
      }
      case 'PerceptionDelivered': {
        const next = applyEvent(scene, sim, event);
        if (next.ok) sim = next.value;
        for (const obs of event.observations) {
          const o = current.occurrences.find((x) => x.id === obs.occurrence);
          if (o) (o.perceivedBy as { actor: string; channel: string }[]).push({ actor: name(event.actor), channel: obs.channel });
        }
        break;
      }
      case 'ProposalSubmitted':
        current.proposals.push({
          actor: name(event.actor),
          kind: event.action.kind,
          target: event.action.target ? name(event.action.target) : null,
          item: event.action.item ? name(event.action.item) : null,
          toZone: event.action.toZone ? name(event.action.toZone) : null,
          sentences: event.action.utterance?.sentences ?? [],
          intent: event.proposal?.intent ?? null,
          rationale: event.proposal?.rationale ?? null,
          innerThought: event.proposal?.innerThought ?? null,
          source: event.forRound === event.round ? SOURCE[event.source] : '回应（留到下一回合）',
          rejected: null,
        });
        break;
      case 'ProposalRejected': {
        const p = [...current.proposals].reverse().find((x) => x.actor === name(event.actor));
        if (p) (p as { rejected: string | null }).rejected = event.violation.code;
        break;
      }
      case 'AdjudicationProposed':
        current.rulings.set(event.requestId, { requestId: event.requestId, rationale: event.rationale, uncertainties: event.uncertainties, by: null, needsReview: false });
        break;
      case 'AdjudicationConfirmed': {
        const r = current.rulings.get(event.requestId);
        if (r) current.rulings.set(event.requestId, { ...r, by: event.by, needsReview: event.needsReview });
        break;
      }
      case 'EvidenceGapFlagged':
        current.notes.push(`缺少证据链的命中：${name(event.actor)}的推测 ${event.inference}（${event.explanation}）`);
        break;
      case 'AuthorIntervened':
        current.notes.push(`作者介入（${event.kind}）：${event.reason}`);
        break;
      case 'RunPaused':
        current.notes.push(`暂停：${event.reason}${event.detail ? `（${event.detail}）` : ''}`);
        break;
      case 'StalemateDetected':
        current.notes.push(`僵局：${event.kind}${event.explanation ? `（${event.explanation}）` : ''}`);
        break;
      // 导演事件发生在回合之间，记在下一回合开头。
      case 'DirectorProposed':
        current.notes.push(`导演提议：${event.rationale}${event.event === null ? '（不注入事件）' : ''}`);
        break;
      case 'DirectorDecided':
        if (event.accepted || event.by === 'author') current.notes.push(`导演提议${event.accepted ? '已采用' : '未采用'}（${event.by === 'author' ? '作者' : '自动'}）`);
        break;
      case 'RoundEnded':
        rounds.push(snapshot(event.round));
        current = { proposals: [], rulings: new Map(), occurrences: [], notes: [] };
        break;
      case 'RunEnded':
        endReason = event.reason;
        break;
      case 'RunStarted':
      case 'ViewBuilt':
      case 'ProposalsComplete':
      case 'Committed':
      case 'BeliefsReviewed':
      case 'EvidenceChecked':
      case 'RunResumed':
        break;
    }
  }
  if (current.proposals.length > 0 || current.occurrences.length > 0 || current.notes.length > 0) rounds.push(snapshot(sim.round));

  return {
    runId,
    title: scene.meta.title ?? runId,
    protocol: start.config.protocol,
    mode: start.config.mode,
    endReason,
    actors: scene.actors.map((a) => ({ id: a.id, name: a.name })),
    names,
    rounds,
  };
}

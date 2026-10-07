import { applyEvent, initialState, type Scene, type SimState } from '@novel-writer/domain';
import type { RunEvent } from '@novel-writer/engine';

/** 一次运行的结局与关键转折，由事件记录重放得到，不调用模型。 */
export type RunOutcome = {
  readonly runId: string;
  /** 结局签名：结束原因、各人是否离场与伤势、各物品最终在谁手里。签名相同的运行归为一类。 */
  readonly signature: string;
  readonly ending: readonly string[];
  readonly turns: readonly string[];
};

export type OutcomeGroup = {
  readonly signature: string;
  readonly ending: readonly string[];
  readonly runs: readonly string[];
  /** 代表运行：归类中标识最小的一次，保证结果与输入顺序无关。 */
  readonly representative: RunOutcome;
};

const END_LABEL: Readonly<Record<string, string>> = {
  max_rounds: '达到回合上限',
  actors_left: '在场角色不足两人',
  stalemate: '僵局（目标已无法达成）',
  budget: '预算用尽',
  author_stop: '作者停止',
};

const INJURY_LABEL: Readonly<Record<string, string>> = { none: '无伤', light: '轻伤', severe: '重伤', incapacitated: '失去行动能力' };

export function runOutcome(scene: Scene, runId: string, events: readonly RunEvent[]): RunOutcome {
  const names = new Map<string, string>();
  for (const e of [...scene.zones, ...scene.actors, ...scene.items, ...scene.mechanisms]) names.set(e.id, e.name);
  const name = (id: string) => names.get(id) ?? id;
  const start = events[0];
  if (start?.type !== 'RunStarted') throw new Error(`运行 ${runId} 的记录缺少 RunStarted`);

  let sim: SimState = initialState(scene, start.config.seed);
  let round = 0;
  let endReason: string | null = null;
  let director = false;
  const turns: string[] = [];
  const holder = (world: SimState['world'], item: string) => {
    const loc = world.items[item as keyof SimState['world']['items']]?.location;
    return loc === undefined ? '不明' : loc.kind === 'actor' ? `${name(loc.actor)}手里` : name(loc.zone);
  };

  for (const event of events.slice(1)) {
    if (event.type === 'RoundStarted') round = event.round;
    if (event.type === 'Committed') director = event.origin === 'director';
    if (event.type === 'RunEnded') endReason = event.reason;
    if (
      event.type !== 'RoundStarted' &&
      event.type !== 'StateChanged' &&
      event.type !== 'PerceptionDelivered' &&
      event.type !== 'BeliefsUpdated' &&
      event.type !== 'KnowledgeEdited'
    ) {
      continue;
    }
    const next = applyEvent(scene, sim, event);
    if (!next.ok) throw new Error(`运行 ${runId} 的记录无法重放：${next.error.code}`);
    if (event.type === 'StateChanged') {
      const before = sim.world;
      const after = next.value.world;
      const at = `第 ${round} 回合${director ? '（导演事件）' : ''}`;
      if (director) {
        for (const o of event.occurrences) turns.push(`${at}：${o.description?.visual ?? o.description?.sound ?? '外部事件'}`);
      }
      for (const item of scene.items) {
        if (holder(before, item.id) !== holder(after, item.id)) {
          turns.push(`${at}：${item.name}从${holder(before, item.id)}到${holder(after, item.id)}`);
        }
      }
      for (const actor of scene.actors) {
        const a = before.actors[actor.id];
        const b = after.actors[actor.id];
        if (a === undefined || b === undefined) continue;
        if (a.injury !== b.injury) turns.push(`${at}：${actor.name}${INJURY_LABEL[b.injury] ?? b.injury}`);
        if (a.status !== b.status) turns.push(`${at}：${actor.name}${b.status === 'withdrawn' ? '离场' : '回到场中'}`);
      }
      for (const m of scene.mechanisms) {
        if (before.mechanisms[m.id]?.armed === true && after.mechanisms[m.id]?.armed === false) turns.push(`${at}：${m.name}触发`);
      }
      director = false;
    }
    sim = next.value;
  }

  const ending = [
    `结束：${endReason === null ? '未结束' : (END_LABEL[endReason] ?? endReason)}`,
    ...scene.actors.map((a) => {
      const s = sim.world.actors[a.id];
      return `${a.name}：${s?.status === 'withdrawn' ? '离场' : '在场'}，${INJURY_LABEL[s?.injury ?? ''] ?? s?.injury ?? ''}`;
    }),
    ...scene.items.map((i) => `${i.name}：${holder(sim.world, i.id)}`),
  ];
  return { runId, signature: ending.join('；'), ending, turns };
}

/** 按结局签名归类；类按次数从多到少，次数相同按签名排序。 */
export function groupOutcomes(outcomes: readonly RunOutcome[]): OutcomeGroup[] {
  const groups = new Map<string, RunOutcome[]>();
  for (const o of outcomes) groups.set(o.signature, [...(groups.get(o.signature) ?? []), o]);
  return [...groups.entries()]
    .map(([signature, list]) => {
      const sorted = [...list].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
      const representative = sorted[0];
      if (representative === undefined) throw new Error('空的归类');
      return { signature, ending: representative.ending, runs: sorted.map((o) => o.runId), representative };
    })
    .sort((a, b) => b.runs.length - a.runs.length || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
}

export function renderOutcomes(title: string, groups: readonly OutcomeGroup[]): string {
  const total = groups.reduce((n, g) => n + g.runs.length, 0);
  const lines = [`# 走向归类：${title}`, '', `共 ${total} 次运行，${groups.length} 种结局。`, ''];
  for (const [index, g] of groups.entries()) {
    lines.push(`## 结局 ${index + 1}（${g.runs.length} 次）`, '');
    for (const e of g.ending) lines.push(`- ${e}`);
    lines.push('', `运行：${g.runs.join('、')}`, '', `代表运行 ${g.representative.runId} 的关键转折：`, '');
    if (g.representative.turns.length === 0) lines.push('- （没有物品易手、伤势变化、离场、机关触发或导演事件）');
    for (const t of g.representative.turns) lines.push(`- ${t}`);
    lines.push('');
  }
  return lines.join('\n');
}

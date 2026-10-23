// 人物的出场、退场与回归（需求 B73 补充）的纯函数。出场取第一次出现的章节（章节计划的出场人物、长篇记忆的人物状态、
// 记下的出场）；退场那一章人物还在，下一章起不在；回归那一章起又在。章节的先后用书中顺序的下标表示。
import type { ChapterOrder } from './types';

export type PresenceKind = 'enter' | 'exit' | 'return';

/** 记下的出场、退场与回归（应用层由仓储的记录转来）。 */
export type PresenceRecord = { readonly entityId: string; readonly chapterId: string; readonly kind: PresenceKind; readonly note: string };

/** 一个人物在书中的进出：第一次出场的章节下标（推算不出时为 null），以及按章节顺序的退场与回归。 */
export type CastTimeline = {
  readonly first: number | null;
  readonly changes: readonly { readonly kind: 'exit' | 'return'; readonly at: number; readonly note: string }[];
};

export type CastTimelineInput = {
  readonly order: ChapterOrder;
  /** 出现过的章节：章节计划的出场人物与长篇记忆的人物状态。 */
  readonly appearances: readonly { readonly chapterId: string; readonly entityId: string }[];
  readonly records: readonly PresenceRecord[];
};

/** 各人物的进出。不在目录里的章节（例如回收站里的）不算。 */
export function castTimelines({ order, appearances, records }: CastTimelineInput): Map<string, CastTimeline> {
  const first = new Map<string, number>();
  const changes = new Map<string, { kind: 'exit' | 'return'; at: number; note: string }[]>();
  const seen = (id: string, at: number) => {
    const was = first.get(id);
    if (was === undefined || at < was) first.set(id, at);
  };
  for (const a of appearances) {
    const at = order.get(a.chapterId);
    if (at !== undefined) seen(a.entityId, at);
  }
  for (const r of records) {
    const at = order.get(r.chapterId);
    if (at === undefined) continue;
    if (r.kind === 'enter') {
      seen(r.entityId, at);
      continue;
    }
    // 退场的人物至少在那一章出现过；回归的也是。
    seen(r.entityId, at);
    changes.set(r.entityId, [...(changes.get(r.entityId) ?? []), { kind: r.kind, at, note: r.note }]);
  }
  const out = new Map<string, CastTimeline>();
  for (const id of new Set([...first.keys(), ...changes.keys()])) {
    // 同一章既退场又回归时先退场后回归（下一章起照常在）。
    const list = [...(changes.get(id) ?? [])].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'exit' ? -1 : 1));
    out.set(id, { first: first.get(id) ?? null, changes: list });
  }
  return out;
}

/** 第 index 章时在退场中：返回那次退场（章节下标与说明）；不在退场中时为 null。 */
export function exitAt(timeline: CastTimeline | undefined, index: number): { readonly at: number; readonly note: string } | null {
  let current: { at: number; note: string } | null = null;
  for (const c of timeline?.changes ?? []) {
    if (c.kind === 'exit' && c.at < index) current = { at: c.at, note: c.note };
    else if (c.kind === 'return' && c.at <= index) current = null;
  }
  return current;
}

/** 第 index 章时已出场、没有退场。推算不出第一次出场的人物算作没出场。 */
export function presentAt(timeline: CastTimeline | undefined, index: number): boolean {
  return timeline !== undefined && timeline.first !== null && timeline.first <= index && exitAt(timeline, index) === null;
}

/** 给模型的人物说明后面带上的退场情况：“第 N 章退场：说明”（书写到最后仍在退场中时）；没有时为空。 */
export function exitNote(timeline: CastTimeline | undefined, chapters: number): string {
  const exit = exitAt(timeline, chapters);
  if (exit === null) return '';
  return `第 ${exit.at + 1} 章退场${exit.note.trim() === '' ? '' : `：${exit.note.trim()}`}`;
}

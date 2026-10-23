// 人物关系网（需求 B73）：关系的读写、关系图上的位置，以及关系图的筛选与布局（纯函数）。
import { err, ok, type Result } from '@fudiao/shared';
import {
  createRelationship,
  deleteRelationship,
  listEntities,
  listRelationPositions,
  listRelationships,
  setRelationPosition,
  updateRelationship,
  type Entity,
  type RelationPosition,
  type Relationship,
  type RelationshipFields,
  type RepoError,
  type SqlPort,
} from '@fudiao/store';
import { castTimelines, presentAt, relationApplies, type CastTimeline } from '@fudiao/writing';
import type { AppError } from './errors';
import type { AppDeps } from './ports';
import { castPresenceOf, relationChangesOf, type CastPresenceView, type RelationChangesView } from './relation-changes';

/** 关系页的数据：全部关系、可以作为一端的设定（人物、组织，以及已有关系涉及的其他设定）与作者拖定的位置。 */
export type RelationsView = {
  readonly relationships: readonly Relationship[];
  readonly members: readonly Entity[];
  readonly positions: readonly RelationPosition[];
  /** 人物的出场与退场（B73 补充）：按章节查看时只显示已出场、没有退场的人物。 */
  readonly presence: CastPresenceView;
  /** 模型找出、待作者确认的关系与人物变化，以及还要找的章节。 */
  readonly changes: RelationChangesView;
};

const repo = (error: RepoError): AppError => ({ code: 'repo', error });

export function relationUseCases(deps: AppDeps, project: () => SqlPort | null) {
  const ctx = () => ({ now: deps.clock.now() });

  async function view(port: SqlPort): Promise<Result<RelationsView, AppError>> {
    const [relationships, entities, positions] = await Promise.all([listRelationships(port), listEntities(port), listRelationPositions(port)]);
    if (!relationships.ok) return err(repo(relationships.error));
    if (!entities.ok) return err(repo(entities.error));
    if (!positions.ok) return err(repo(positions.error));
    const presence = await castPresenceOf(port);
    if (!presence.ok) return presence;
    const changes = await relationChangesOf(port, ctx());
    if (!changes.ok) return changes;
    const linked = new Set(relationships.value.flatMap((r) => [r.fromId, r.toId]));
    return ok({
      relationships: relationships.value,
      members: entities.value.filter((e) => e.kind === 'character' || e.kind === 'organization' || linked.has(e.id)),
      positions: positions.value,
      presence: presence.value,
      changes: changes.value,
    });
  }

  /** 改动之后返回最新的关系页数据。 */
  async function change(write: (port: SqlPort) => Promise<Result<unknown, RepoError>>): Promise<Result<RelationsView, AppError>> {
    const port = project();
    if (port === null) return err({ code: 'no_work' });
    const done = await write(port);
    if (!done.ok) return err(repo(done.error));
    return view(port);
  }

  return {
    async relationsView(): Promise<Result<RelationsView, AppError>> {
      const port = project();
      return port === null ? err({ code: 'no_work' }) : view(port);
    },
    addRelationship: (fields: RelationshipFields) => change((port) => createRelationship(port, { id: deps.ids.next(), ...fields }, ctx())),
    updateRelationship: (relationship: Relationship, fields: RelationshipFields) => change((port) => updateRelationship(port, relationship.id, relationship.version, fields, ctx())),
    deleteRelationship: (relationship: Relationship) => change((port) => deleteRelationship(port, relationship.id, relationship.version)),
    /** 记下一项设定在关系图上的位置；null 时取消，回到自动排布。 */
    setRelationPosition: (entityId: string, at: { readonly x: number; readonly y: number } | null) => change((port) => setRelationPosition(port, entityId, at, ctx())),
    /** 取消全部拖定的位置，整张图重新自动排布。 */
    async resetRelationLayout(): Promise<Result<RelationsView, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const positions = await listRelationPositions(port);
      if (!positions.ok) return err(repo(positions.error));
      for (const p of positions.value) {
        const cleared = await setRelationPosition(port, p.entityId, null, ctx());
        if (!cleared.ok) return err(repo(cleared.error));
      }
      return view(port);
    },
  };
}

// —— 关系图（纯函数）——

/** 关系图的逻辑尺寸；界面按容器宽度缩放。拖定的位置也记在这个坐标系里。 */
export const GRAPH_SIZE = { width: 1000, height: 640 } as const;
const MARGIN = 60;

/** 书中第 index 章成立的关系；index 为 null 时不按章节筛选。chapterOrder 是书中顺序。 */
export function relationsAt(relationships: readonly Relationship[], chapterOrder: readonly string[], index: number | null): Relationship[] {
  if (index === null) return [...relationships];
  const order = new Map(chapterOrder.map((id, i) => [id, i]));
  return relationships.filter((r) => relationApplies(r, index, order));
}

/** 各人物在书中的进出（第一次出场取推算的与记下的里最早的）。chapterOrder 是书中顺序。 */
export function presenceTimelines(presence: CastPresenceView, chapterOrder: readonly string[]): Map<string, CastTimeline> {
  return castTimelines({
    order: new Map(chapterOrder.map((id, i) => [id, i])),
    appearances: Object.entries(presence.firstChapter).map(([entityId, chapterId]) => ({ entityId, chapterId })),
    records: presence.records,
  });
}

/**
 * 书中第 index 章时关系图上的设定：人物只留已出场、没有退场的；组织、地点等不按出场筛选。index 为 null 时不筛选。
 * 整本书还没有任何出场的记录时（没有章节计划与长篇记忆）推算不出，人物照旧都显示。
 */
export function membersAt<M extends { readonly id: string; readonly kind: string }>(members: readonly M[], timelines: ReadonlyMap<string, CastTimeline>, index: number | null): M[] {
  if (index === null) return [...members];
  const known = [...timelines.values()].some((t) => t.first !== null);
  return members.filter((m) => m.kind !== 'character' || (known ? presentAt(timelines.get(m.id), index) : true));
}

export type Point = { readonly x: number; readonly y: number };

/** 关系图看到的那一块（SVG 的 viewBox），长宽比与 GRAPH_SIZE 相同。 */
export type GraphView = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export const FULL_VIEW: GraphView = { x: 0, y: 0, w: GRAPH_SIZE.width, h: GRAPH_SIZE.height };
/** 最多放大到 4 倍（看清人名与称谓），最多缩小到 2 倍大的范围（拖出去的人物也找得回来）。 */
const MIN_VIEW_W = GRAPH_SIZE.width / 4;
const MAX_VIEW_W = GRAPH_SIZE.width * 2;

/** 以 at 为中心缩放：factor 小于 1 放大、大于 1 缩小；at 那一点在屏幕上不动。 */
export function zoomView(view: GraphView, factor: number, at: Point): GraphView {
  const w = Math.min(MAX_VIEW_W, Math.max(MIN_VIEW_W, view.w * factor));
  const f = w / view.w;
  return { x: at.x - (at.x - view.x) * f, y: at.y - (at.y - view.y) * f, w, h: view.h * f };
}

/** 刚好装下这些点（留出人名的位置），长宽比不变；没有点时看全图。 */
export function fitView(points: readonly Point[], pad = 70): GraphView {
  if (points.length === 0) return FULL_VIEW;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const ratio = GRAPH_SIZE.height / GRAPH_SIZE.width;
  const width = Math.max(...xs) - Math.min(...xs) + pad * 2;
  const height = Math.max(...ys) - Math.min(...ys) + pad * 2;
  const w = Math.min(MAX_VIEW_W, Math.max(MIN_VIEW_W, width, height / ratio));
  const h = w * ratio;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * 力导向布局（Fruchterman–Reingold）：有关系的互相吸引，所有节点互相排斥，并向中心轻轻收拢。
 * 结果只由输入决定（起点按顺序排在圆上，迭代次数固定），同样的数据每次画出同样的图；拖定的节点不动。
 */
export function layoutGraph(ids: readonly string[], edges: readonly (readonly [string, string])[], pinned: ReadonlyMap<string, Point>, size: { readonly width: number; readonly height: number } = GRAPH_SIZE): Map<string, Point> {
  const out = new Map<string, Point>();
  // 还没有任何关系、也没有拖定位置的人物不参加排布，在画布底部排成一行。
  const linked = new Set(edges.flatMap(([a, b]) => (a === b ? [] : [a, b])));
  const loose = ids.filter((id) => !linked.has(id) && !pinned.has(id));
  const rowY = size.height - MARGIN + 10;
  loose.forEach((id, i) => out.set(id, { x: Math.min(size.width - MARGIN, MARGIN + i * 110), y: rowY }));
  const placed = layoutLinked(
    ids.filter((id) => !loose.includes(id)),
    edges,
    pinned,
    loose.length > 0 ? { width: size.width, height: size.height - 90 } : size,
  );
  for (const [id, p] of placed) out.set(id, p);
  return out;
}

function layoutLinked(ids: readonly string[], edges: readonly (readonly [string, string])[], pinned: ReadonlyMap<string, Point>, size: { readonly width: number; readonly height: number }): Map<string, Point> {
  const n = ids.length;
  const out = new Map<string, Point>();
  if (n === 0) return out;
  const cx = size.width / 2;
  const cy = size.height / 2;
  const pos = ids.map((id, i): { x: number; y: number } => {
    const p = pinned.get(id);
    if (p !== undefined) return { x: p.x, y: p.y };
    if (n === 1) return { x: cx, y: cy };
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    return { x: cx + Math.cos(angle) * size.width * 0.32, y: cy + Math.sin(angle) * size.height * 0.32 };
  });
  const fixed = ids.map((id) => pinned.has(id));
  const index = new Map(ids.map((id, i) => [id, i]));
  const links = edges.flatMap(([a, b]) => {
    const i = index.get(a);
    const j = index.get(b);
    return i === undefined || j === undefined || i === j ? [] : [[i, j] as const];
  });
  const k = Math.min(Math.sqrt((size.width * size.height) / n) * 0.75, 260);
  const kk = k * k;
  // 斥力只在一定距离内起作用：没有关系的人物不会被一路推到画布边上。按这个距离分格，只比较相邻格子里的人物。
  const cutoff = 2.5 * k;
  const cutoff2 = cutoff * cutoff;
  const cols = Math.max(1, Math.ceil(size.width / cutoff));
  const rows = Math.max(1, Math.ceil(size.height / cutoff));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  pos.forEach((p, i) => {
    xs[i] = p.x;
    ys[i] = p.y;
  });
  const dx_ = new Float64Array(n);
  const dy_ = new Float64Array(n);
  const cellOf = new Int32Array(n);
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  const iterations = 300;
  for (let step = 0; step < iterations; step++) {
    const temperature = (size.width / 8) * (1 - step / iterations) + 1;
    dx_.fill(0);
    dy_.fill(0);
    for (const c of cells) c.length = 0;
    for (let i = 0; i < n; i++) {
      const c = Math.min(cols - 1, Math.max(0, Math.floor(xs[i]! / cutoff))) + Math.min(rows - 1, Math.max(0, Math.floor(ys[i]! / cutoff))) * cols;
      cellOf[i] = c;
      cells[c]!.push(i);
    }
    for (let i = 0; i < n; i++) {
      const ci = cellOf[i]! % cols;
      const ri = Math.floor(cellOf[i]! / cols);
      for (let r = Math.max(0, ri - 1); r <= Math.min(rows - 1, ri + 1); r++) {
        for (let c = Math.max(0, ci - 1); c <= Math.min(cols - 1, ci + 1); c++) {
          for (const j of cells[c + r * cols]!) {
            if (j <= i) continue;
            let dx = xs[i]! - xs[j]!;
            let dy = ys[i]! - ys[j]!;
            // 两点重合时按下标错开一点，结果仍然确定。
            if (dx === 0 && dy === 0) {
              dx = (i - j) * 0.1;
              dy = 0.1;
            }
            const d2 = dx * dx + dy * dy;
            if (d2 > cutoff2) continue;
            const d = Math.max(Math.sqrt(d2), 0.01);
            const f = kk / d / d;
            dx_[i]! += dx * f;
            dy_[i]! += dy * f;
            dx_[j]! -= dx * f;
            dy_[j]! -= dy * f;
          }
        }
      }
    }
    for (const [i, j] of links) {
      const dx = xs[i]! - xs[j]!;
      const dy = ys[i]! - ys[j]!;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const f = d / k;
      dx_[i]! -= dx * f;
      dy_[i]! -= dy * f;
      dx_[j]! += dx * f;
      dy_[j]! += dy * f;
    }
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      // 向中心收拢，力度与距离成正比。
      const ddx = dx_[i]! + (cx - xs[i]!) * 0.6;
      const ddy = dy_[i]! + (cy - ys[i]!) * 0.6;
      const len = Math.max(Math.sqrt(ddx * ddx + ddy * ddy), 0.01);
      const move = Math.min(len, temperature);
      xs[i] = Math.min(size.width - MARGIN, Math.max(MARGIN, xs[i]! + (ddx / len) * move));
      ys[i] = Math.min(size.height - MARGIN, Math.max(MARGIN, ys[i]! + (ddy / len) * move));
    }
  }
  pos.forEach((p, i) => {
    p.x = xs[i]!;
    p.y = ys[i]!;
  });
  // 没有拖定的位置时，把整张图缩放到画布中间（最多放大 1.8 倍，人物少时不至于散得太开）。
  if (pinned.size === 0 && n > 1) {
    const xs = pos.map((p) => p.x);
    const ys = pos.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = Math.min((size.width - 2 * MARGIN) / Math.max(maxX - minX, 1), (size.height - 2 * MARGIN) / Math.max(maxY - minY, 1), 1.8);
    const mx = (minX + maxX) / 2;
    const my = (minY + maxY) / 2;
    for (const p of pos) {
      p.x = cx + (p.x - mx) * scale;
      p.y = cy + (p.y - my) * scale;
    }
  }
  ids.forEach((id, i) => out.set(id, { x: Math.round(pos[i]!.x * 10) / 10, y: Math.round(pos[i]!.y * 10) / 10 }));
  return out;
}

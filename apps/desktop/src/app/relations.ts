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
import { relationApplies } from '@fudiao/writing';
import type { AppError } from './errors';
import type { AppDeps } from './ports';

/** 关系页的数据：全部关系、可以作为一端的设定（人物、组织，以及已有关系涉及的其他设定）与作者拖定的位置。 */
export type RelationsView = {
  readonly relationships: readonly Relationship[];
  readonly members: readonly Entity[];
  readonly positions: readonly RelationPosition[];
};

const repo = (error: RepoError): AppError => ({ code: 'repo', error });

export function relationUseCases(deps: AppDeps, project: () => SqlPort | null) {
  const ctx = () => ({ now: deps.clock.now() });

  async function view(port: SqlPort): Promise<Result<RelationsView, AppError>> {
    const [relationships, entities, positions] = await Promise.all([listRelationships(port), listEntities(port), listRelationPositions(port)]);
    if (!relationships.ok) return err(repo(relationships.error));
    if (!entities.ok) return err(repo(entities.error));
    if (!positions.ok) return err(repo(positions.error));
    const linked = new Set(relationships.value.flatMap((r) => [r.fromId, r.toId]));
    return ok({
      relationships: relationships.value,
      members: entities.value.filter((e) => e.kind === 'character' || e.kind === 'organization' || linked.has(e.id)),
      positions: positions.value,
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

export type Point = { readonly x: number; readonly y: number };

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
  const iterations = 300;
  for (let step = 0; step < iterations; step++) {
    const temperature = (size.width / 8) * (1 - step / iterations) + 1;
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        // 两点重合时按下标错开一点，结果仍然确定。
        if (dx === 0 && dy === 0) {
          dx = (i - j) * 0.1;
          dy = 0.1;
        }
        const d = Math.max(Math.hypot(dx, dy), 0.01);
        // 斥力只在一定距离内起作用：没有关系的人物不会被一路推到画布边上。
        if (d > 2.5 * k) continue;
        const f = (k * k) / d;
        disp[i]!.x += (dx / d) * f;
        disp[i]!.y += (dy / d) * f;
        disp[j]!.x -= (dx / d) * f;
        disp[j]!.y -= (dy / d) * f;
      }
    }
    for (const [i, j] of links) {
      const dx = pos[i]!.x - pos[j]!.x;
      const dy = pos[i]!.y - pos[j]!.y;
      const d = Math.max(Math.hypot(dx, dy), 0.01);
      const f = (d * d) / k;
      disp[i]!.x -= (dx / d) * f;
      disp[i]!.y -= (dy / d) * f;
      disp[j]!.x += (dx / d) * f;
      disp[j]!.y += (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const p = pos[i]!;
      const d = disp[i]!;
      // 向中心收拢，力度与距离成正比。
      d.x += (cx - p.x) * 0.6;
      d.y += (cy - p.y) * 0.6;
      const len = Math.max(Math.hypot(d.x, d.y), 0.01);
      const move = Math.min(len, temperature);
      p.x = Math.min(size.width - MARGIN, Math.max(MARGIN, p.x + (d.x / len) * move));
      p.y = Math.min(size.height - MARGIN, Math.max(MARGIN, p.y + (d.y / len) * move));
    }
  }
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

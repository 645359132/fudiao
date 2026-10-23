import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { RELATION_CATEGORIES, type Entity, type RelationCategory, type Relationship, type RelationshipFields } from '@fudiao/store';
import { exitAt, type CastTimeline } from '@fudiao/writing';
import { ENTITY_KIND_LABEL, PRESENCE_KIND_LABEL, RELATION_CATEGORY_LABEL } from '../app/labels';
import { suggestionText } from '../app/relation-changes';
import { GRAPH_SIZE, layoutGraph, membersAt, presenceTimelines, relationsAt, type Point, type RelationsView } from '../app/relations';
import { Icon } from './Icon';
import { NO_CHAPTERS, useApp } from './store-context';

/** 侧栏显示的内容：选中的人物、选中的关系、新建关系（可带上一方），或什么都没选。 */
type Selection = { readonly kind: 'node'; readonly id: string } | { readonly kind: 'edge'; readonly id: string } | { readonly kind: 'new'; readonly fromId: string | null } | null;

const NODE_R = 24;

/** 关系读成一句话：“甲是乙的师父”，双向时“甲与乙：朋友”。 */
export function relationSentence(r: Pick<Relationship, 'fromId' | 'toId' | 'label' | 'mutual'>, nameOf: (id: string) => string): string {
  return r.mutual ? `${nameOf(r.fromId)}与${nameOf(r.toId)}：${r.label}` : `${nameOf(r.fromId)}是${nameOf(r.toId)}的${r.label}`;
}

type Edge = { readonly r: Relationship; readonly path: string; readonly mid: Point };

/** 同一对人物之间的几条关系画成错开的弧线；起止点退到节点边缘，箭头不被节点挡住。 */
function edgeGeometry(relationships: readonly Relationship[], pos: ReadonlyMap<string, Point>): Edge[] {
  const groups = new Map<string, Relationship[]>();
  for (const r of relationships) {
    const key = [r.fromId, r.toId].sort().join('|');
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: Edge[] = [];
  for (const group of groups.values()) {
    group.forEach((r, k) => {
      const a = pos.get(r.fromId);
      const b = pos.get(r.toId);
      if (a === undefined || b === undefined) return;
      // 弧线的偏移按排好序的一对计算，正反两个方向的关系不会叠在一起。
      const [first] = [r.fromId, r.toId].sort();
      const sign = first === r.fromId ? 1 : -1;
      const offset = (k - (group.length - 1) / 2) * 70 * sign;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.max(Math.hypot(dx, dy), 1);
      const c = { x: (a.x + b.x) / 2 - (dy / len) * offset, y: (a.y + b.y) / 2 + (dx / len) * offset };
      const toward = (p: Point, q: Point, d: number): Point => {
        const l = Math.max(Math.hypot(q.x - p.x, q.y - p.y), 1);
        return { x: p.x + ((q.x - p.x) / l) * d, y: p.y + ((q.y - p.y) / l) * d };
      };
      const start = toward(a, c, NODE_R + 2);
      const end = toward(b, c, NODE_R + (r.mutual ? 2 : 6));
      out.push({ r, path: `M ${start.x} ${start.y} Q ${c.x} ${c.y} ${end.x} ${end.y}`, mid: { x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y } });
    });
  }
  return out;
}

function RelationGraph({
  members,
  visible,
  exited,
  relationships,
  all,
  pinned,
  selection,
  onSelect,
  onPlace,
}: {
  /** 参加排布的全部设定：按章节查看时人物的位置不跟着跳动。 */
  readonly members: readonly Entity[];
  /** 这时显示的设定（按章节查看时只有已出场、没有退场的人物）。 */
  readonly visible: ReadonlySet<string>;
  /** 书写到最后仍在退场中的人物（画得淡一些）。 */
  readonly exited: ReadonlySet<string>;
  readonly relationships: readonly Relationship[];
  /** 排布用全部关系：按章节筛选时人物的位置不跟着跳动。 */
  readonly all: readonly Relationship[];
  readonly pinned: ReadonlyMap<string, Point>;
  readonly selection: Selection;
  readonly onSelect: (s: Selection) => void;
  readonly onPlace: (id: string, at: Point) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ readonly id: string; readonly at: Point; readonly moved: boolean } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // 排布只取决于有哪些人物、谁和谁之间有关系、哪些位置拖定过：改称谓、说明、类别等不重新排布。
  // 用这三样拼成的字符串做依赖，数据每次重新读取（数组换了新的）也不重算。
  const idsKey = members.map((m) => m.id).join('\n');
  const edgesKey = all.map((r) => `${r.fromId}\t${r.toId}`).join('\n');
  const pinnedKey = [...pinned].map(([id, p]) => `${id}\t${p.x}\t${p.y}`).join('\n');
  const layout = useMemo(() => {
    const lines = (key: string) => (key === '' ? [] : key.split('\n').map((l) => l.split('\t')));
    return layoutGraph(
      lines(idsKey).map(([id]) => id ?? ''),
      lines(edgesKey).map(([a, b]) => [a ?? '', b ?? ''] as const),
      new Map(lines(pinnedKey).map(([id, x, y]) => [id ?? '', { x: Number(x), y: Number(y) }])),
    );
  }, [idsKey, edgesKey, pinnedKey]);
  const pos = useMemo(() => (drag === null ? layout : new Map([...layout, [drag.id, drag.at]])), [layout, drag]);
  const edges = edgeGeometry(relationships, pos);
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const focus = hover ?? (selection?.kind === 'node' ? selection.id : null);
  const neighbors = new Set(focus === null ? [] : relationships.flatMap((r) => (r.fromId === focus ? [r.toId] : r.toId === focus ? [r.fromId] : [])));

  const toGraph = (e: ReactPointerEvent): Point | null => {
    const el = svg.current;
    const m = el?.getScreenCTM?.();
    if (el === null || m === null || m === undefined) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: Math.round(Math.min(GRAPH_SIZE.width - 20, Math.max(20, p.x))), y: Math.round(Math.min(GRAPH_SIZE.height - 20, Math.max(20, p.y))) };
  };

  return (
    <svg
      ref={svg}
      className="relation-graph"
      viewBox={`0 0 ${GRAPH_SIZE.width} ${GRAPH_SIZE.height}`}
      role="img"
      aria-label="人物关系图"
      onPointerDown={(e) => {
        if (e.target === svg.current) onSelect(null);
      }}
    >
      <defs>
        {RELATION_CATEGORIES.map((c) => (
          <marker key={c} id={`rel-arrow-${c}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={`rel-fill-${c}`} />
          </marker>
        ))}
      </defs>
      <g className="relation-edges">
        {edges.map(({ r, path, mid }) => {
          const dim = focus !== null && r.fromId !== focus && r.toId !== focus;
          const active = selection?.kind === 'edge' && selection.id === r.id;
          const label = relationSentence(r, (id) => nameOf.get(id) ?? '');
          const width = r.label.length * 14 + 14;
          return (
            <g
              key={r.id}
              className={`relation-edge rel-${r.category}${dim ? ' dim' : ''}${active ? ' active' : ''}${r.secret ? ' secret' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={label}
              onClick={() => onSelect({ kind: 'edge', id: r.id })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect({ kind: 'edge', id: r.id });
                }
              }}
            >
              <path d={path} className="edge-hit" />
              <path d={path} className="edge-line" markerEnd={r.mutual ? undefined : `url(#rel-arrow-${r.category})`} />
              <rect x={mid.x - width / 2} y={mid.y - 11} width={width} height={22} rx={11} className="edge-label-bg" />
              <text x={mid.x} y={mid.y + 4.5} textAnchor="middle" className="edge-label">
                {r.label}
              </text>
            </g>
          );
        })}
      </g>
      <g className="relation-nodes">
        {members.map((m) => {
          const p = pos.get(m.id);
          if (p === undefined || !visible.has(m.id)) return null;
          const selected = selection?.kind === 'node' && selection.id === m.id;
          const dim = focus !== null && focus !== m.id && !neighbors.has(m.id);
          return (
            <g
              key={m.id}
              className={`relation-node kind-${m.kind}${selected ? ' selected' : ''}${dim ? ' dim' : ''}${pinned.has(m.id) ? ' pinned' : ''}${exited.has(m.id) ? ' exited' : ''}`}
              transform={`translate(${p.x} ${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${m.name}（${ENTITY_KIND_LABEL[m.kind]}${exited.has(m.id) ? '，已退场' : ''}）`}
              aria-pressed={selected}
              onPointerEnter={() => setHover(m.id)}
              onPointerLeave={() => setHover(null)}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture?.(e.pointerId);
                setDrag({ id: m.id, at: p, moved: false });
              }}
              onPointerMove={(e) => {
                if (drag?.id !== m.id) return;
                const at = toGraph(e);
                if (at !== null && (Math.abs(at.x - drag.at.x) > 1 || Math.abs(at.y - drag.at.y) > 1)) setDrag({ id: m.id, at, moved: true });
              }}
              onPointerUp={() => {
                const d = drag;
                setDrag(null);
                if (d === null || d.id !== m.id) return;
                // 拖过就固定在那里；只是点了一下就选中这个人物。
                if (d.moved) onPlace(m.id, d.at);
                else onSelect({ kind: 'node', id: m.id });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect({ kind: 'node', id: m.id });
                }
              }}
            >
              {m.kind === 'character' ? <circle r={NODE_R} className="node-shape" /> : <rect x={-NODE_R} y={-NODE_R} width={NODE_R * 2} height={NODE_R * 2} rx={8} className="node-shape" />}
              <text y={5} textAnchor="middle" className="node-initial">
                {m.name.slice(0, 1)}
              </text>
              <text y={NODE_R + 17} textAnchor="middle" className="node-name">
                {m.name}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

const blank = (fromId: string | null, toId: string | null): RelationshipFields => ({
  fromId: fromId ?? '',
  toId: toId ?? '',
  category: 'ally',
  label: '',
  mutual: false,
  description: '',
  secret: false,
  validFromChapterId: null,
  validToChapterId: null,
});

function RelationForm({ relationship, initial, members, onDone }: { readonly relationship: Relationship | null; readonly initial: RelationshipFields; readonly members: readonly Entity[]; readonly onDone: (keep: Selection) => void }) {
  const chapters = useApp((s) => s.work?.chapters ?? NO_CHAPTERS);
  const save = useApp((s) => s.saveRelationship);
  const remove = useApp((s) => s.deleteRelationship);
  const busy = useApp((s) => s.busy);
  const [f, setF] = useState<RelationshipFields>(initial);
  const [confirming, setConfirming] = useState(false);
  const set = (patch: Partial<RelationshipFields>) => setF({ ...f, ...patch });
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? '……';
  const ready = f.fromId !== '' && f.toId !== '' && f.fromId !== f.toId && f.label.trim() !== '';
  const chapterSelect = (label: string, value: string | null, onChange: (v: string | null) => void, none: string) => (
    <label>
      {label}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
        <option value="">{none}</option>
        {chapters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
    </label>
  );
  const memberSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">选择……</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}（{ENTITY_KIND_LABEL[m.kind]}）
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form
      className="relation-form"
      aria-label={relationship === null ? '新建关系' : '修改关系'}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void save(relationship?.id ?? null, f).then((saved) => {
          if (saved) onDone(relationship === null ? null : { kind: 'edge', id: relationship.id });
        });
      }}
    >
      <h3>{relationship === null ? '新建关系' : '修改关系'}</h3>
      {memberSelect('一方', f.fromId, (fromId) => set({ fromId }))}
      {memberSelect('另一方', f.toId, (toId) => set({ toId }))}
      <div className="form-row">
        <label>
          类别
          <select value={f.category} onChange={(e) => set({ category: e.target.value as RelationCategory })}>
            {RELATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {RELATION_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          称谓
          <input value={f.label} placeholder="例如：师父、债主、恋人" onChange={(e) => set({ label: e.target.value })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.mutual} onChange={(e) => set({ mutual: e.target.checked })} />
        双方相同（例如朋友、同门）
      </label>
      <p className="relation-preview muted" aria-label="读作">
        {f.label.trim() === '' ? '填写称谓后在这里预览' : relationSentence({ ...f, label: f.label.trim() }, nameOf)}
      </p>
      <label>
        说明
        <textarea rows={3} value={f.description} placeholder="这层关系的来历、现在的状态" onChange={(e) => set({ description: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={f.secret} onChange={(e) => set({ secret: e.target.checked })} />
        隐秘：读者还不知道（写手只暗示，不点明）
      </label>
      <div className="form-row">
        {chapterSelect('从哪一章起', f.validFromChapterId, (validFromChapterId) => set({ validFromChapterId }), '从头起')}
        {chapterSelect('到哪一章止', f.validToChapterId, (validToChapterId) => set({ validToChapterId }), '一直有效')}
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !ready}>
          保存关系
        </button>
        <button type="button" onClick={() => onDone(null)}>
          取消
        </button>
        {relationship === null ? null : confirming ? (
          <span className="confirm" role="group" aria-label="确认删除">
            <span>删除这条关系？</span>
            <button
              type="button"
              className="primary danger"
              onClick={() =>
                void remove(relationship.id).then((done) => {
                  if (done) onDone(null);
                })
              }
            >
              确定删除
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              不删
            </button>
          </span>
        ) : (
          <button type="button" className="ghost danger-text" onClick={() => setConfirming(true)}>
            删除关系
          </button>
        )}
      </div>
    </form>
  );
}

/** 一条建议读成一句话，带上范围或说明。 */
function changeText(s: RelationsView['changes']['suggestions'][number], titleOf: ReadonlyMap<string, string>): string {
  const text = suggestionText(s);
  switch (s.kind) {
    case 'relation_add':
      return s.validToChapterId === null ? text : `${text}（到${titleOf.get(s.validToChapterId) ?? '后面某一章'}为止）`;
    case 'relation_change':
      return `${text}（原来的到上一章为止）`;
    case 'relation_end':
      return `${text}（到这一章为止）`;
    case 'cast_enter':
    case 'cast_exit':
    case 'cast_return':
      return s.description === '' ? text : `${text}——${s.description}`;
  }
}

/**
 * 关系与人物的变化（B73 补充）：模型从长篇记忆找出、待作者确认的建议，逐条采用、忽略或全部采用；从已写的章节补找；
 * 写完一章后是否自动找。
 */
function RelationChanges({ view }: { readonly view: RelationsView }) {
  const chapters = useApp((s) => s.work?.chapters ?? NO_CHAPTERS);
  const adopt = useApp((s) => s.adoptRelationSuggestion);
  const ignore = useApp((s) => s.ignoreRelationSuggestion);
  const adoptAll = useApp((s) => s.adoptAllRelationSuggestions);
  const scanBook = useApp((s) => s.findRelationChangesInBook);
  const stop = useApp((s) => s.stopRelationScan);
  const scanning = useApp((s) => s.relationScan);
  const auto = useApp((s) => s.library?.preferences.autoRelationChanges ?? true);
  const setAuto = useApp((s) => s.setAutoRelationChanges);
  const busy = useApp((s) => s.busy);
  const { suggestions, scan } = view.changes;
  const titleOf = chapterNames(chapters);
  return (
    <section className="relation-changes" aria-label="关系的变化">
      <div className="relation-changes-head">
        <h3>{suggestions.length > 0 ? `待确认的变化（${suggestions.length}）` : '关系的变化'}</h3>
        <label className="check" title="写手写完一章、整理完长篇记忆后，找出这一章带来的关系与人物进出的变化，等你确认">
          <input type="checkbox" checked={auto} onChange={(e) => void setAuto(e.target.checked)} />
          写完一章后自动找出关系变化
        </label>
        <span className="spacer" />
        {scanning !== null ? (
          <>
            <span className="muted" role="status">
              正在从已写的章节找{scanning.total > 0 ? `（第 ${Math.min(scanning.done + 1, scanning.total)} / ${scanning.total} 批）` : ''}……
            </span>
            <button type="button" onClick={stop}>
              停下
            </button>
          </>
        ) : (
          <button type="button" disabled={busy || scan.todo.length === 0} title="按书中顺序分批读各章的长篇记忆，只找还没找过的章节（长篇记忆重建过的再找一次）" onClick={() => void scanBook()}>
            从已写的章节找出变化{scan.todo.length > 0 ? `（${scan.todo.length} 章）` : ''}
          </button>
        )}
        {suggestions.length > 0 ? (
          <button type="button" className="primary" disabled={busy || scanning !== null} onClick={() => void adoptAll()}>
            全部采用
          </button>
        ) : null}
      </div>
      {scan.noMemory > 0 ? <p className="muted">有 {scan.noMemory} 章还没有有效的长篇记忆（没整理过，或正文改过），先在计划页整理或重建，才能从这些章里找。</p> : null}
      {suggestions.length === 0 ? (
        <p className="muted">
          {scan.todo.length > 0
            ? `还有 ${scan.todo.length} 章没有找过，可以点“从已写的章节找出变化”。`
            : auto
              ? '写手每写完一章，会找出这一章带来的关系与人物进出的变化，放在这里等你确认。'
              : '自动查找已关闭；可以点“从已写的章节找出变化”手动找。'}
        </p>
      ) : (
        <ul className="relation-change-list" aria-label="待确认的变化">
          {suggestions.map((s) => (
            <li key={s.id}>
              <div className="relation-change-text">
                <span className="relation-change-where">{titleOf.get(s.chapterId) ?? ''}</span>
                <span>{changeText(s, titleOf)}</span>
                {s.reason === '' ? null : <span className="muted relation-change-reason">依据：{s.reason}</span>}
              </div>
              <div className="relation-change-actions">
                <button type="button" disabled={busy} aria-label={`采用：${suggestionText(s)}`} onClick={() => void adopt(s.id)}>
                  采用
                </button>
                <button type="button" className="ghost" disabled={busy} aria-label={`忽略：${suggestionText(s)}`} onClick={() => void ignore(s.id)}>
                  忽略
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 章节的称呼：书名号里的章节名，没有章节名时写第几章。 */
function chapterNames(chapters: readonly { readonly id: string; readonly title: string }[]): Map<string, string> {
  return new Map(chapters.map((c, i) => [c.id, c.title.trim() === '' ? `第 ${i + 1} 章` : `《${c.title.trim()}》`]));
}

/** 一个人物的出场与退场，写在人物详情里。 */
function presenceLines(id: string, view: RelationsView, titleOf: ReadonlyMap<string, string>): string[] {
  const first = view.presence.firstChapter[id];
  const lines = first === undefined ? ['还没有出场的记录（章节计划、长篇记忆里都没有）'] : [`首次出场：${titleOf.get(first) ?? ''}`];
  for (const r of view.presence.records.filter((x) => x.entityId === id && x.kind !== 'enter')) lines.push(`${titleOf.get(r.chapterId) ?? ''}${PRESENCE_KIND_LABEL[r.kind]}${r.note === '' ? '' : `：${r.note}`}`);
  return lines;
}

/** 人物关系网（B73）：关系图、按章节查看、新建与修改关系。 */
export function RelationsPanel() {
  const view = useApp((s) => s.relations);
  const chapters = useApp((s) => s.work?.chapters ?? NO_CHAPTERS);
  const place = useApp((s) => s.placeRelationNode);
  const reset = useApp((s) => s.resetRelationLayout);
  const busy = useApp((s) => s.busy);
  const [chapterId, setChapterId] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const openSettings = useApp((s) => s.openSettings);
  const pinned = useMemo(() => new Map((view?.positions ?? []).map((p) => [p.entityId, { x: p.x, y: p.y }])), [view]);
  const timelines = useMemo(
    () =>
      view === null
        ? new Map<string, CastTimeline>()
        : presenceTimelines(
            view.presence,
            chapters.map((c) => c.id),
          ),
    [view, chapters],
  );

  if (view === null) return <p className="muted">正在载入……</p>;
  const found = chapterId === '' ? -1 : chapters.findIndex((c) => c.id === chapterId);
  const index = found === -1 ? null : found;
  // 按章节查看时只显示那一章已出场、没有退场的人物，关系也只画两端都在的。
  const visible = new Set(membersAt(view.members, timelines, index).map((m) => m.id));
  const shown = relationsAt(
    view.relationships,
    chapters.map((c) => c.id),
    index,
  ).filter((r) => visible.has(r.fromId) && visible.has(r.toId));
  const exited = new Set(view.members.filter((m) => exitAt(timelines.get(m.id), chapters.length) !== null).map((m) => m.id));
  const titleOf = chapterNames(chapters);
  const nameOf = (id: string) => view.members.find((m) => m.id === id)?.name ?? '';
  const editing = selection?.kind === 'edge' ? (view.relationships.find((r) => r.id === selection.id) ?? null) : null;
  const node = selection?.kind === 'node' ? (view.members.find((m) => m.id === selection.id) ?? null) : null;
  const relationItem = (r: Relationship) => (
    <li key={r.id}>
      <button type="button" className={`relation-item rel-${r.category}`} aria-pressed={editing?.id === r.id} onClick={() => setSelection({ kind: 'edge', id: r.id })}>
        <span className="rel-dot" aria-hidden="true" />
        <span>{relationSentence(r, nameOf)}</span>
        {r.secret ? <span className="badge">隐秘</span> : null}
      </button>
    </li>
  );

  return (
    <section aria-label="人物关系" className="relations-panel">
      <div className="relations-head">
        <h2>人物关系</h2>
        <label className="relations-chapter">
          查看
          <select aria-label="按章节查看" value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
            <option value="">全部关系</option>
            {chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} 时
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button type="button" className="ghost" disabled={busy || view.positions.length === 0} title="取消拖定的位置，重新自动排布" onClick={() => void reset()}>
          重新排布
        </button>
        <button type="button" className="primary" disabled={busy || view.members.length < 2} onClick={() => setSelection({ kind: 'new', fromId: node?.id ?? null })}>
          <Icon name="plus" />
          新建关系
        </button>
      </div>
      <ul className="relations-legend" aria-label="类别">
        {RELATION_CATEGORIES.map((c) => (
          <li key={c} className={`rel-${c}`}>
            <span className="rel-dot" aria-hidden="true" />
            {RELATION_CATEGORY_LABEL[c]}
          </li>
        ))}
        <li className="legend-note">虚线为隐秘关系，箭头指向“是谁的”</li>
      </ul>
      <RelationChanges view={view} />
      <div className="relations-body">
        <div className="relations-canvas">
          {view.members.length === 0 ? (
            <p className="muted relations-empty">还没有人物。先在“设定”里建人物卡片，或对 AI 助手说“根据大纲建主要人物和他们的关系”。</p>
          ) : (
            <RelationGraph
              members={view.members}
              visible={visible}
              exited={exited}
              relationships={shown}
              all={view.relationships}
              pinned={pinned}
              selection={selection}
              onSelect={setSelection}
              onPlace={(id, at) => void place(id, at)}
            />
          )}
        </div>
        <aside className="relations-side" aria-label="关系详情">
          {selection?.kind === 'new' ? (
            <RelationForm key={`new:${selection.fromId ?? ''}`} relationship={null} initial={blank(selection.fromId, null)} members={view.members} onDone={setSelection} />
          ) : editing !== null ? (
            <RelationForm key={`${editing.id}:${editing.version}`} relationship={editing} initial={editing} members={view.members} onDone={setSelection} />
          ) : node !== null ? (
            <div className="relation-node-detail">
              <h3>
                {node.name}
                <span className="muted">（{ENTITY_KIND_LABEL[node.kind]}）</span>
              </h3>
              {node.description.trim() === '' ? null : <p className="muted">{node.description}</p>}
              {node.kind === 'character' ? (
                <ul className="relation-presence" aria-label={`${node.name}的出场与退场`}>
                  {presenceLines(node.id, view, titleOf).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              <ul className="relation-list" aria-label={`${node.name}的关系`}>
                {view.relationships.filter((r) => r.fromId === node.id || r.toId === node.id).map(relationItem)}
              </ul>
              <div className="form-actions">
                <button type="button" onClick={() => setSelection({ kind: 'new', fromId: node.id })}>
                  与他人新建关系
                </button>
                {node.kind === 'character' ? (
                  <button type="button" className="ghost" onClick={() => void openSettings(node.id)}>
                    在设定里改出场与退场
                  </button>
                ) : null}
                {pinned.has(node.id) ? (
                  <button type="button" className="ghost" onClick={() => void place(node.id, null)}>
                    取消固定位置
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div>
              <h3>{index === null ? `全部关系（${view.relationships.length}）` : `这一章时成立的关系（${shown.length}）`}</h3>
              {index === null ? null : <p className="muted">只显示这一章时已出场、没有退场的人物。</p>}
              {shown.length === 0 ? (
                <p className="muted">还没有关系。点“新建关系”，或在图上选一个人物。拖动人物可以调整位置。</p>
              ) : (
                <ul className="relation-list" aria-label="关系列表">
                  {shown.map(relationItem)}
                </ul>
              )}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

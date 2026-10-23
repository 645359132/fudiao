import { useState } from 'react';
import { ENTITY_KINDS, PRESENCE_KINDS, type CastPresence, type Entity, type EntityKind, type PresenceKind } from '@fudiao/store';
import { ENTITY_KIND_LABEL, PRESENCE_KIND_LABEL } from '../app/labels';
import { NO_CHAPTERS, useApp } from './store-context';


/** 别名在输入框中用顿号、逗号或换行分隔。 */
const splitAliases = (text: string) => text.split(/[、，,\n]/);

function EntityForm({ entity }: { readonly entity: Entity }) {
  const save = useApp((s) => s.saveEntity);
  const setLocked = useApp((s) => s.setEntityLocked);
  const remove = useApp((s) => s.deleteEntity);
  const busy = useApp((s) => s.busy);
  const [kind, setKind] = useState<EntityKind>(entity.kind);
  const [name, setName] = useState(entity.name);
  const [aliases, setAliases] = useState(entity.aliases.join('、'));
  const [description, setDescription] = useState(entity.description);
  const [attributes, setAttributes] = useState(entity.attributes.map((a) => ({ ...a })));
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <form
      className="panel-form entity-form"
      aria-label="设定内容"
      onSubmit={(e) => {
        e.preventDefault();
        void save(entity.id, { kind, name, aliases: splitAliases(aliases), description, attributes });
      }}
    >
      <div className="entity-head">
        <h3>{entity.name}</h3>
        {entity.locked ? (
          <>
            <span className="lock-badge">已锁定</span>
            <button type="button" disabled={busy} onClick={() => void setLocked(entity.id, false)}>
              解锁
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} title="锁定后推演与生成都不能改动这条设定，作者也要先解锁才能修改" onClick={() => void setLocked(entity.id, true)}>
            锁定
          </button>
        )}
      </div>
      {entity.locked && <p className="muted">锁定设定不会被推演或生成结果改变；要修改请先解锁。</p>}
      {/* 锁定时整组字段只读。 */}
      <fieldset disabled={entity.locked || busy} className="plain">
        <label>
          名字
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          种类
          <select value={kind} onChange={(e) => setKind(e.target.value as EntityKind)}>
            {ENTITY_KINDS.map((k) => (
              <option key={k} value={k}>
                {ENTITY_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          别名（用顿号分隔）
          <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </label>
        <label>
          说明
          <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="attributes" role="group" aria-label="属性">
          <span>属性</span>
          {attributes.map((a, i) => (
            <div key={i} className="attribute">
              <input aria-label={`属性名 ${i + 1}`} placeholder="属性名" value={a.label} onChange={(e) => setAttributes(attributes.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <input aria-label={`属性值 ${i + 1}`} placeholder="内容" value={a.value} onChange={(e) => setAttributes(attributes.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <button type="button" aria-label={`删除属性 ${i + 1}`} onClick={() => setAttributes(attributes.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setAttributes([...attributes, { label: '', value: '' }])}>
            添加属性
          </button>
        </div>
        <div className="form-actions">
          <button type="submit">保存设定</button>
          {confirmingDelete ? (
            <span className="confirm" role="group" aria-label="确认删除">
              <span>删除后无法恢复，与它有关的人物关系也一并删除。</span>
              <button type="button" onClick={() => void remove(entity.id)}>
                确定删除
              </button>
              <button type="button" onClick={() => setConfirmingDelete(false)}>
                取消
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmingDelete(true)}>
              删除设定
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

/** 一条出场、退场或回归的记录：种类、章节与说明（没有标识的是新加的一条）。 */
function PresenceRow({ entityId, record }: { readonly entityId: string; readonly record: CastPresence | null }) {
  const chapters = useApp((s) => s.work?.chapters ?? NO_CHAPTERS);
  const save = useApp((s) => s.saveCastPresence);
  const remove = useApp((s) => s.deleteCastPresence);
  const busy = useApp((s) => s.busy);
  const [kind, setKind] = useState<PresenceKind>(record?.kind ?? 'exit');
  const [chapterId, setChapterId] = useState(record?.chapterId ?? '');
  const [note, setNote] = useState(record?.note ?? '');
  const which = record === null ? '新的一条' : `${PRESENCE_KIND_LABEL[record.kind]}记录`;
  const changed = record === null ? chapterId !== '' : kind !== record.kind || chapterId !== record.chapterId || note !== record.note;
  return (
    <form
      className="presence-row"
      aria-label={which}
      onSubmit={(e) => {
        e.preventDefault();
        if (chapterId === '') return;
        void save(record?.id ?? null, { entityId, chapterId, kind, note }).then((saved) => {
          if (saved && record === null) {
            setChapterId('');
            setNote('');
          }
        });
      }}
    >
      <select aria-label={`${which}的种类`} value={kind} onChange={(e) => setKind(e.target.value as PresenceKind)}>
        {PRESENCE_KINDS.map((k) => (
          <option key={k} value={k}>
            {PRESENCE_KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <select aria-label={`${which}的章节`} value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
        <option value="">选择章节……</option>
        {chapters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
      <input aria-label={`${which}的说明`} placeholder={kind === 'exit' ? '怎么退场的，例如：坠崖身亡' : '说明（可以不写）'} value={note} onChange={(e) => setNote(e.target.value)} />
      <button type="submit" disabled={busy || !changed || chapterId === ''}>
        {record === null ? '添加' : '保存'}
      </button>
      {record === null ? null : (
        <button type="button" className="ghost" disabled={busy} aria-label={`删除${which}`} onClick={() => void remove(record.id)}>
          删除
        </button>
      )}
    </form>
  );
}

/**
 * 人物的出场与退场（B73 补充）：第一次出场按章节计划与长篇记忆推算（这里记的出场也算），退场与回归记在这里；
 * 采用人物关系页的建议时也记在这里。人物关系页按章节查看时据此只显示在场的人物，规划时人物说明带上退场。
 */
function CastPresenceEditor({ entity }: { readonly entity: Entity }) {
  const presence = useApp((s) => s.castPresence);
  const chapters = useApp((s) => s.work?.chapters ?? NO_CHAPTERS);
  if (presence === null) return null;
  const first = presence.firstChapter[entity.id];
  const firstTitle = chapters.find((c) => c.id === first)?.title;
  const records = presence.records.filter((r) => r.entityId === entity.id);
  return (
    <section className="cast-presence" aria-label="出场与退场">
      <h4>出场与退场</h4>
      <p className="muted">
        {firstTitle === undefined ? '还没有出场的记录（章节计划、长篇记忆里都没有）。' : `首次出场：《${firstTitle}》（按章节计划与长篇记忆推算）。`}
        退场那一章人物还在，下一章起不在；回归那一章起又在。
      </p>
      {records.map((r) => (
        <PresenceRow key={`${r.id}:${r.version}`} entityId={entity.id} record={r} />
      ))}
      <PresenceRow key={`new:${records.length}`} entityId={entity.id} record={null} />
    </section>
  );
}

function NewEntity({ onDone }: { readonly onDone: () => void }) {
  const create = useApp((s) => s.createEntity);
  const [kind, setKind] = useState<EntityKind>('character');
  const [name, setName] = useState('');
  return (
    <form
      className="text-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() === '') return;
        void create(kind, name).then((ok) => ok && onDone());
      }}
    >
      <select aria-label="新设定的种类" value={kind} onChange={(e) => setKind(e.target.value as EntityKind)}>
        {ENTITY_KINDS.map((k) => (
          <option key={k} value={k}>
            {ENTITY_KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <input aria-label="新设定的名字" placeholder="名字" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      <button type="submit" disabled={name.trim() === ''}>
        创建
      </button>
      <button type="button" onClick={onDone}>
        取消
      </button>
    </form>
  );
}

/** 设定管理（需求 B09）：人物、地点、组织、物品与世界规则。 */
export function SettingsPanel() {
  const entities = useApp((s) => s.entities);
  const selectedId = useApp((s) => s.selectedEntityId);
  const select = useApp((s) => s.selectEntity);
  const showPanel = useApp((s) => s.showPanel);
  const [filter, setFilter] = useState<EntityKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const selected = entities.find((e) => e.id === selectedId) ?? null;
  const q = query.trim();
  const shown = entities.filter((e) => (filter === 'all' || e.kind === filter) && (q === '' || e.name.includes(q) || e.aliases.some((a) => a.includes(q))));

  return (
    <section aria-label="设定" className="settings">
      <div className="history-head">
        <h2>设定</h2>
        <button type="button" onClick={() => setAdding(true)}>
          新建设定
        </button>
        <button type="button" onClick={() => void showPanel('chapter')}>
          返回正文
        </button>
      </div>
      {adding && <NewEntity onDone={() => setAdding(false)} />}
      <div className="settings-body">
        <div>
          <div className="kind-tabs" role="tablist" aria-label="设定种类">
            {(['all', ...ENTITY_KINDS] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>
                {k === 'all' ? '全部' : ENTITY_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <input aria-label="查找设定" placeholder="按名字或别名查找" value={query} onChange={(e) => setQuery(e.target.value)} />
          {shown.length === 0 ? (
            <p className="muted">{entities.length === 0 ? '还没有设定。' : '没有符合的设定。'}</p>
          ) : (
            <ul className="entity-list" aria-label="设定列表">
              {shown.map((e) => (
                <li key={e.id}>
                  <button type="button" aria-current={e.id === selectedId ? 'true' : undefined} onClick={() => select(e.id)}>
                    <span>{e.name}</span>
                    <span className="muted">
                      {ENTITY_KIND_LABEL[e.kind]}
                      {e.locked ? ' · 已锁定' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected === null ? (
          <p className="muted">选择一条设定查看与修改。</p>
        ) : (
          <div>
            <EntityForm key={`${selected.id}:${selected.version}:${String(selected.locked)}`} entity={selected} />
            {selected.kind === 'character' ? <CastPresenceEditor entity={selected} /> : null}
          </div>
        )}
      </div>
    </section>
  );
}

/** 正文旁的设定卡片：Ctrl + 点击高亮的名字时打开，只读，可转到设定页修改。 */
export function EntityDrawer() {
  const entity = useApp((s) => {
    const drawer = s.drawer;
    return drawer?.kind === 'entity' ? (s.entities.find((e) => e.id === drawer.entityId) ?? null) : null;
  });
  const close = useApp((s) => s.openEntityDrawer);
  const openSettings = useApp((s) => s.openSettings);
  if (entity === null) return null;
  return (
    <aside className="entity-drawer" aria-label="设定卡片">
      <div className="entity-head">
        <h3>{entity.name}</h3>
        <span className="muted">{ENTITY_KIND_LABEL[entity.kind]}</span>
        {entity.locked && <span className="lock-badge">已锁定</span>}
        <button type="button" aria-label="关闭设定卡片" onClick={() => close(null)}>
          ×
        </button>
      </div>
      {entity.aliases.length > 0 && <p className="muted">别名：{entity.aliases.join('、')}</p>}
      {entity.description !== '' && <p className="entity-description">{entity.description}</p>}
      {entity.attributes.length > 0 && (
        <dl>
          {entity.attributes.map((a, i) => (
            <div key={i}>
              <dt>{a.label}</dt>
              <dd>{a.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <button type="button" onClick={() => void openSettings(entity.id)}>
        在设定中编辑
      </button>
    </aside>
  );
}

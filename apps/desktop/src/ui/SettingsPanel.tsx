import { useState } from 'react';
import { ENTITY_KINDS, type Entity, type EntityKind } from '@fudiao/store';
import { ENTITY_KIND_LABEL } from '../app/labels';
import { useApp } from './store-context';


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
          <EntityForm key={`${selected.id}:${selected.version}:${String(selected.locked)}`} entity={selected} />
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

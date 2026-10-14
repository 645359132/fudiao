import { useState } from 'react';
import type { SceneSpecInput } from '@fudiao/domain';
import type { SimSceneFields } from '@fudiao/store';
import { checkSceneConfig } from '../app/scene-editing';
import { useApp } from './store-context';
import { ZoneGraphEditor } from './ZoneGraphEditor';

type Config = SceneSpecInput;
type Actor = Config['actors'][number];
type Card = NonNullable<Actor['card']>;
type Knowledge = NonNullable<Card['initialKnowledge']>[number];
type Item = NonNullable<Config['items']>[number];
type Secret = NonNullable<Config['secrets']>[number];

const INJURY = { none: '没有受伤', light: '轻伤', severe: '重伤', incapacitated: '失去行动能力' } as const;
const MODALITY = { observed: '亲眼所见', heard: '听说', inferred: '推测' } as const;
const PROTOCOL = { simultaneous: '同时行动', turn_based: '轮流对话' } as const;
/** 首版原型每个角色最多五条初始认知（需求 I04）。 */
const MAX_KNOWLEDGE = 5;

const splitLines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
const splitKeys = (text: string) => text.split(/[,，、\s]+/).map((k) => k.trim()).filter((k) => k !== '');

function Text({ label, value, onChange, rows }: { readonly label: string; readonly value: string; readonly onChange: (v: string) => void; readonly rows?: number }) {
  return (
    <label>
      {label}
      {rows === undefined ? <input value={value} onChange={(e) => onChange(e.target.value)} /> : <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

/** 一组条目：多行文字每行一条，或用逗号、顿号、空格分开的键。输入框自己保留正在输入的文字（末尾的换行与分隔符不会被吃掉）。 */
function ListField({ label, value, onChange, lines }: { readonly label: string; readonly value: readonly string[]; readonly onChange: (v: string[]) => void; readonly lines?: number }) {
  const [text, setText] = useState(value.join(lines === undefined ? '、' : '\n'));
  const change = (next: string) => {
    setText(next);
    onChange(lines === undefined ? splitKeys(next) : splitLines(next));
  };
  return (
    <label>
      {label}
      {lines === undefined ? <input value={text} onChange={(e) => change(e.target.value)} /> : <textarea rows={lines} value={text} onChange={(e) => change(e.target.value)} />}
    </label>
  );
}

function KnowledgeForm({ item, others, onChange, onRemove }: { readonly item: Knowledge; readonly others: readonly Actor[]; readonly onChange: (k: Knowledge) => void; readonly onRemove: () => void }) {
  return (
    <fieldset>
      <legend>初始认知</legend>
      <Text label="内容" rows={2} value={item.text} onChange={(text) => onChange({ ...item, text })} />
      <label>
        来源方式
        <select value={item.modality ?? 'observed'} onChange={(e) => onChange({ ...item, modality: e.target.value as keyof typeof MODALITY })}>
          {Object.entries(MODALITY).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        相信程度（0 到 1；错误的信念也可以深信不疑）
        <input type="number" min={0} max={1} step={0.1} value={item.confidence ?? 1} onChange={(e) => onChange({ ...item, confidence: Number(e.target.value) })} />
      </label>
      <ListField label="涉及的对象（角色、区域、物品的键）" value={item.about ?? []} onChange={(about) => onChange({ ...item, about })} />
      <label>
        这是对谁的想法的推测（二阶认知）
        <select
          value={item.concerning ?? ''}
          onChange={(e) => {
            const { concerning: _dropped, ...rest } = item;
            onChange(e.target.value === '' ? { ...rest, order: 1 } : { ...rest, order: 2, concerning: e.target.value });
          }}
        >
          <option value="">不是，是他自己对事情的认知</option>
          {others.map((a) => (
            <option key={a.id} value={a.id}>
              他认为“{a.name}”是这样想的
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={onRemove}>
        删除这条认知
      </button>
    </fieldset>
  );
}

function ActorForm({ actor, config, onChange, onRemove }: { readonly actor: Actor; readonly config: Config; readonly onChange: (a: Actor) => void; readonly onRemove: () => void }) {
  const card: Card = actor.card ?? {};
  const knowledge = card.initialKnowledge ?? [];
  const setCard = (patch: Partial<Card>) => onChange({ ...actor, card: { ...card, ...patch } });
  const setKnowledge = (next: Knowledge[]) => setCard({ initialKnowledge: next });
  return (
    <li className="skill" aria-label={`角色 ${actor.name}`}>
      <details>
        <summary>
          {actor.name}
          <span className="muted">（{actor.id}）</span>
        </summary>
        <div className="panel-form">
          <Text label="键（场景内唯一，别处用它指代这个角色）" value={actor.id} onChange={(id) => onChange({ ...actor, id })} />
          <Text label="名字" value={actor.name} onChange={(name) => onChange({ ...actor, name })} />
          <label>
            所在区域
            <select value={actor.zone} onChange={(e) => onChange({ ...actor, zone: e.target.value })}>
              {config.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
              {config.zones.some((z) => z.id === actor.zone) ? null : <option value={actor.zone}>{actor.zone}（不存在）</option>}
            </select>
          </label>
          <label>
            伤势
            <select value={actor.injury ?? 'none'} onChange={(e) => onChange({ ...actor, injury: e.target.value as keyof typeof INJURY })}>
              {Object.entries(INJURY).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <Text label="目标" rows={2} value={card.goal ?? ''} onChange={(goal) => setCard({ goal })} />
          <Text label="底线" rows={2} value={card.bottomLine ?? ''} onChange={(bottomLine) => setCard({ bottomLine })} />
          <ListField label="性格倾向（每行一条）" lines={3} value={card.traits ?? []} onChange={(traits) => setCard({ traits })} />
          <Text label="风险偏好" value={card.riskPreference ?? ''} onChange={(riskPreference) => setCard({ riskPreference })} />
          <Text label="情绪阈值" value={card.emotionThreshold ?? ''} onChange={(emotionThreshold) => setCard({ emotionThreshold })} />
          <Text label="失控条件" value={card.lossOfControl ?? ''} onChange={(lossOfControl) => setCard({ lossOfControl })} />
          <Text label="说话风格" value={card.speechStyle ?? ''} onChange={(speechStyle) => setCard({ speechStyle })} />
          <p className="muted">初始认知只有这个角色自己知道。秘密与错误的信念都写在这里（最多 {MAX_KNOWLEDGE} 条）。</p>
          {knowledge.map((k, i) => (
            <KnowledgeForm
              key={i}
              item={k}
              others={config.actors.filter((a) => a.id !== actor.id)}
              onChange={(next) => setKnowledge(knowledge.map((x, j) => (j === i ? next : x)))}
              onRemove={() => setKnowledge(knowledge.filter((_, j) => j !== i))}
            />
          ))}
          <div className="skill-actions">
            <button type="button" disabled={knowledge.length >= MAX_KNOWLEDGE} onClick={() => setKnowledge([...knowledge, { text: '' }])}>
              添加初始认知
            </button>
            <button type="button" disabled={config.actors.length <= 1} onClick={onRemove}>
              删除这个角色
            </button>
          </div>
        </div>
      </details>
    </li>
  );
}

function SecretForm({ secret, actors, onChange, onRemove }: { readonly secret: Secret; readonly actors: readonly Actor[]; readonly onChange: (s: Secret) => void; readonly onRemove: () => void }) {
  const known = secret.knownBy ?? [];
  return (
    <li className="skill" aria-label={`秘密 ${secret.id}`}>
      <div className="panel-form">
        <Text label="键" value={secret.id} onChange={(id) => onChange({ ...secret, id })} />
        <Text label="秘密的内容（只有作者看得到，用来判断角色的推测有没有依据）" rows={2} value={secret.text} onChange={(text) => onChange({ ...secret, text })} />
        <ListField label="涉及的对象（角色、区域、物品的键，至少一个）" value={secret.subjects} onChange={(subjects) => onChange({ ...secret, subjects })} />
        <fieldset>
          <legend>本来就知道这个秘密的角色</legend>
          {actors.map((a) => (
            <label key={a.id}>
              <input type="checkbox" checked={known.includes(a.id)} onChange={(e) => onChange({ ...secret, knownBy: e.target.checked ? [...known, a.id] : known.filter((x) => x !== a.id) })} />
              {a.name}
            </label>
          ))}
        </fieldset>
        <button type="button" onClick={onRemove}>
          删除这个秘密
        </button>
      </div>
    </li>
  );
}

function ItemForm({ item, config, onChange, onRemove }: { readonly item: Item; readonly config: Config; readonly onChange: (i: Item) => void; readonly onRemove: () => void }) {
  const place = item.location.kind === 'actor' ? `actor:${item.location.actor}` : `zone:${item.location.zone}`;
  return (
    <li className="skill" aria-label={`物品 ${item.name}`}>
      <div className="panel-form">
        <Text label="键" value={item.id} onChange={(id) => onChange({ ...item, id })} />
        <Text label="名字" value={item.name} onChange={(name) => onChange({ ...item, name })} />
        <label>
          位置
          <select
            value={place}
            onChange={(e) => {
              const [kind, key = ''] = e.target.value.split(':');
              onChange({ ...item, location: kind === 'actor' ? { kind: 'actor', actor: key } : { kind: 'zone', zone: key } });
            }}
          >
            {config.actors.map((a) => (
              <option key={`a:${a.id}`} value={`actor:${a.id}`}>
                在{a.name}身上
              </option>
            ))}
            {config.zones.map((z) => (
              <option key={`z:${z.id}`} value={`zone:${z.id}`}>
                放在{z.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={item.concealed ?? false} onChange={(e) => onChange({ ...item, concealed: e.target.checked })} />
          藏着：被人带在身上时，旁人看不见
        </label>
        <Text
          label="上面写着的内容（例如信；持有者使用它时读到）"
          rows={2}
          value={item.content ?? ''}
          onChange={(content) => {
            const { content: _dropped, ...rest } = item;
            onChange(content === '' ? rest : { ...rest, content });
          }}
        />
        <button type="button" onClick={onRemove}>
          删除这件物品
        </button>
      </div>
    </li>
  );
}

const freshKey = (prefix: string, taken: readonly string[]) => {
  for (let n = taken.length + 1; ; n++) if (!taken.includes(`${prefix}_${n}`)) return `${prefix}_${n}`;
};

/**
 * 推演场景的编辑（需求 B22、B23）：基本信息、角色与角色卡、初始认知、秘密、物品与叙述规则。
 * 区域图在“区域”一节（ZoneGraphEditor）；机关、消耗规则等其余配置在“高级”里直接编辑。
 * 校验由领域内核完成，表单下方随时列出还不对的地方，全部改好才能保存。
 */
export function SceneEditor({ id, initial, notes }: { readonly id: string | null; readonly initial: SimSceneFields; readonly notes?: readonly string[] }) {
  const chapters = useApp((s) => s.work?.chapters ?? []);
  const save = useApp((s) => s.saveSimScene);
  const busy = useApp((s) => s.busy);
  const [title, setTitle] = useState(initial.title);
  const [chapterId, setChapterId] = useState(initial.chapterId);
  const [protocol, setProtocol] = useState(initial.protocol);
  const [maxRounds, setMaxRounds] = useState(String(initial.maxRounds));
  const [firstSpeaker, setFirstSpeaker] = useState(initial.firstSpeaker);
  const [config, setConfig] = useState<Config>(initial.config as Config);
  const [dirty, setDirty] = useState(id === null);
  // “高级”里整份替换配置后，各输入框要按新内容重建。
  const [revision, setRevision] = useState(0);
  const [json, setJson] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const change = (next: Config) => {
    setConfig(next);
    setDirty(true);
  };
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };
  const actors = config.actors;
  const items = config.items ?? [];
  const secrets = config.secrets ?? [];
  const meta = config.meta ?? {};
  const rules = config.rules ?? {};
  const rounds = Number(maxRounds);
  const problems = [
    ...(title.trim() === '' ? ['场景名：没有填写'] : []),
    ...(!Number.isInteger(rounds) || rounds < 1 ? ['回合上限：须为正整数'] : []),
    ...(firstSpeaker !== null && !actors.some((a) => a.id === firstSpeaker) ? ['第一个开口的角色：不在场景的角色里'] : []),
    ...checkSceneConfig(config),
  ];

  return (
    <form
      className="panel-form"
      aria-label={id === null ? '新场景' : `场景 ${initial.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save(id, { title, chapterId, protocol, maxRounds: rounds, firstSpeaker: protocol === 'turn_based' ? firstSpeaker : null, config: config }).then((saved) => {
          if (saved) setDirty(false);
        });
      }}
    >
      {notes !== undefined && notes.length > 0 ? (
        <div role="note" className="muted">
          草稿里有 {notes.length} 处需要你改一下才能保存，见表单下方的列表。
        </div>
      ) : null}
      <Text label="场景名" value={title} onChange={touch(setTitle)} />
      <label>
        所属章节
        <select value={chapterId ?? ''} onChange={(e) => touch(setChapterId)(e.target.value === '' ? null : e.target.value)}>
          <option value="">不属于某一章</option>
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        回合协议
        <select value={protocol} onChange={(e) => touch(setProtocol)(e.target.value as keyof typeof PROTOCOL)}>
          {Object.entries(PROTOCOL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        回合上限
        <input type="number" min={1} value={maxRounds} onChange={(e) => touch(setMaxRounds)(e.target.value)} />
      </label>
      {protocol === 'turn_based' ? (
        <label>
          第一个开口的角色
          <select value={firstSpeaker ?? ''} onChange={(e) => touch(setFirstSpeaker)(e.target.value === '' ? null : e.target.value)}>
            <option value="">场景里的第一个角色</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div key={revision} className="panel-form">
        <Text label="题材（只给作者看，角色看不到）" value={meta.genre ?? ''} onChange={(genre) => change({ ...config, meta: { ...meta, genre } })} />
        <ListField label="想通过这次推演弄清的问题（每行一条，角色看不到）" lines={2} value={meta.questions ?? []} onChange={(questions) => change({ ...config, meta: { ...meta, questions } })} />

        <ZoneGraphEditor config={config} onChange={change} />

        <section aria-label="角色">
          <h3>角色</h3>
          <ul className="skill-list">
            {actors.map((a, i) => (
              <ActorForm
                key={i}
                actor={a}
                config={config}
                onChange={(next) => change({ ...config, actors: actors.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => change({ ...config, actors: actors.filter((_, j) => j !== i) })}
              />
            ))}
          </ul>
          <button
            type="button"
            onClick={() => change({ ...config, actors: [...actors, { id: freshKey('actor', actors.map((a) => a.id)), name: '新角色', zone: config.zones[0]?.id ?? '', card: { traits: [], initialKnowledge: [] } }] })}
          >
            添加角色
          </button>
        </section>

        <section aria-label="秘密">
          <h3>秘密</h3>
          <p className="muted">作者标记的秘密不进入任何角色的视图。角色的推测碰到秘密时，系统会检查他有没有依据。</p>
          <ul className="skill-list">
            {secrets.map((s, i) => (
              <SecretForm
                key={i}
                secret={s}
                actors={actors}
                onChange={(next) => change({ ...config, secrets: secrets.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => change({ ...config, secrets: secrets.filter((_, j) => j !== i) })}
              />
            ))}
          </ul>
          <button type="button" onClick={() => change({ ...config, secrets: [...secrets, { id: freshKey('secret', secrets.map((s) => s.id)), text: '', subjects: [] }] })}>
            添加秘密
          </button>
        </section>

        <section aria-label="物品">
          <h3>物品</h3>
          <ul className="skill-list">
            {items.map((it, i) => (
              <ItemForm
                key={i}
                item={it}
                config={config}
                onChange={(next) => change({ ...config, items: items.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => change({ ...config, items: items.filter((_, j) => j !== i) })}
              />
            ))}
          </ul>
          <button
            type="button"
            onClick={() => change({ ...config, items: [...items, { id: freshKey('item', items.map((x) => x.id)), name: '新物品', location: { kind: 'zone', zone: config.zones[0]?.id ?? '' } }] })}
          >
            添加物品
          </button>
        </section>

        <ListField
          label="叙述规则（每行一条；内置规则表达不了的约定，交给裁决时参考，角色看不到）"
          lines={3}
          value={rules.narrativeRules ?? []}
          onChange={(narrativeRules) => change({ ...config, rules: { ...rules, narrativeRules } })}
        />
      </div>

      <details
        onToggle={(e) => {
          if (e.currentTarget.open) setJson(JSON.stringify(config, null, 2));
        }}
      >
        <summary>高级：直接编辑整份场景配置</summary>
        <p className="muted">机关、消耗规则、前提条件、伤势限制、标记、场景时钟与响度表都在这里。改完点“应用到表单”。</p>
        <label>
          场景配置（JSON）
          <textarea rows={16} value={json ?? ''} onChange={(e) => setJson(e.target.value)} />
        </label>
        {jsonError === null ? null : <p className="field-error">{jsonError}</p>}
        <button
          type="button"
          onClick={() => {
            try {
              const parsed: unknown = JSON.parse(json ?? '');
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('须是一个对象');
              const next = parsed as Partial<Config>;
              change({ ...next, zones: Array.isArray(next.zones) ? next.zones : [], actors: Array.isArray(next.actors) ? next.actors : [] });
              setRevision(revision + 1);
              setJsonError(null);
            } catch (error) {
              setJsonError(`不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
            }
          }}
        >
          应用到表单
        </button>
      </details>

      {problems.length > 0 ? (
        <ul className="field-error" aria-label="还不对的地方">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <button type="submit" disabled={busy || !dirty || problems.length > 0}>
        保存场景
      </button>
    </form>
  );
}

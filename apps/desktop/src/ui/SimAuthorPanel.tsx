import { useState } from 'react';
import type { ActionKind } from '@fudiao/domain';
import type { PendingRuling, SimRunDetail } from '../app/simulation';
import { useApp } from './store-context';

const ACTION_KINDS: readonly (readonly [ActionKind, string])[] = [
  ['wait', '等待'],
  ['observe', '观察'],
  ['speak', '说话'],
  ['move', '移动'],
  ['probe', '试探'],
  ['attack', '攻击'],
  ['defend', '防御'],
  ['use_item', '使用物品'],
  ['take', '拾取'],
  ['drop', '放下'],
  ['withdraw', '撤离'],
  ['other', '其他'],
];
const MODALITY = { observed: '亲眼所见', heard: '听说', inferred: '推测' } as const;
const VOLUME = { whisper: '低声', normal: '平常', shout: '喊' } as const;

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
const keys = (text: string) => text.split(/[,，、\s]+/).map((k) => k.trim()).filter((k) => k !== '');

/** 一条待核实的裁决（B26）：按原样接受，或修改后确认。 */
function RulingCard({ ruling, locked }: { readonly ruling: PendingRuling; readonly locked: boolean }) {
  const confirm = useApp((s) => s.confirmSimRuling);
  const [text, setText] = useState(ruling.editable);
  return (
    <li className="skill" aria-label="待核实的裁决">
      <p>{ruling.rationale}</p>
      {ruling.effects.length > 0 ? (
        <ul aria-label="效果">
          {ruling.effects.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">不改变局面。</p>
      )}
      <ul aria-label="发生的事">
        {ruling.occurrences.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>
      {ruling.uncertainties.length > 0 ? <p className="field-error">拿不准的地方：{ruling.uncertainties.join('；')}</p> : null}
      <div className="skill-actions">
        <button type="button" disabled={locked} onClick={() => void confirm(ruling.requestId)}>
          接受这条裁决
        </button>
      </div>
      <details>
        <summary>修改后确认</summary>
        <p className="muted">改效果与发生的事；改过的裁决仍要符合规则（只能改变这次行动涉及的人与物）。</p>
        <label>
          裁决内容（JSON）
          <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="button" disabled={locked} onClick={() => void confirm(ruling.requestId, text)}>
          按修改后的内容确认
        </button>
      </details>
    </li>
  );
}

/** 等作者处理的事：待核实的裁决与导演提议。 */
export function PendingPanel({ detail, locked }: { readonly detail: SimRunDetail; readonly locked: boolean }) {
  const decide = useApp((s) => s.decideSimDirector);
  const director = detail.pendingDirector;
  if (detail.pendingRulings.length === 0 && director === null) return null;
  return (
    <section aria-label="等你处理">
      <h4>等你处理</h4>
      <ul className="skill-list">
        {detail.pendingRulings.map((r) => (
          <RulingCard key={r.requestId} ruling={r} locked={locked} />
        ))}
      </ul>
      {director === null ? null : (
        <div className="skill" role="group" aria-label="导演提议">
          <p>导演提议：{director.rationale}</p>
          <ul>
            {[...director.occurrences, ...director.effects].map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <div className="skill-actions">
            <button type="button" disabled={locked} onClick={() => void decide(true)}>
              采用
            </button>
            <button type="button" disabled={locked} onClick={() => void decide(false)}>
              不采用
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

type Kind = 'edit_knowledge' | 'external_event' | 'replace_action';

/** 作者介入（B30）：改角色的认知、加入外部事件、替换一个角色的行动。介入前的局面会记成快照，可以从那里分支。 */
export function IntervenePanel({ detail, locked }: { readonly detail: SimRunDetail; readonly locked: boolean }) {
  const intervene = useApp((s) => s.interveneSimRun);
  const { actors, zones, items } = detail.cast;
  const [kind, setKind] = useState<Kind>('edit_knowledge');
  const [reason, setReason] = useState('');
  const [actor, setActor] = useState(actors[0]?.id ?? '');
  // 改认知
  const [text, setText] = useState('');
  const [modality, setModality] = useState<keyof typeof MODALITY>('heard');
  const [confidence, setConfidence] = useState('0.8');
  const [about, setAbout] = useState('');
  const [retract, setRetract] = useState<readonly string[]>([]);
  // 外部事件
  const [zone, setZone] = useState(zones[0]?.id ?? '');
  const [visible, setVisible] = useState(true);
  const [loudness, setLoudness] = useState('2');
  const [visual, setVisual] = useState('');
  const [sound, setSound] = useState('');
  // 替换行动
  const [action, setAction] = useState<ActionKind>('wait');
  const [target, setTarget] = useState('');
  const [item, setItem] = useState('');
  const [toZone, setToZone] = useState('');
  const [speech, setSpeech] = useState('');
  const [volume, setVolume] = useState<keyof typeof VOLUME>('normal');
  const [description, setDescription] = useState('');

  const submit = async () => {
    const done =
      kind === 'edit_knowledge'
        ? await intervene({
            kind,
            actor,
            add: text.trim() === '' ? [] : [{ text, modality, confidence: Number(confidence), about: keys(about) }],
            retract,
            reason,
          })
        : kind === 'external_event'
          ? await intervene({ kind, zone, visible, loudness: Math.max(0, Math.round(Number(loudness))), visual, sound, reason })
          : await intervene({ kind, actor, action: { kind: action, target, item, toZone, sentences: lines(speech), volume, description }, reason });
    if (done) {
      setReason('');
      setText('');
      setRetract([]);
      setVisual('');
      setSound('');
      setSpeech('');
      setDescription('');
    }
  };
  const actorSelect = (
    <label>
      角色
      <select
        value={actor}
        onChange={(e) => {
          setActor(e.target.value);
          setRetract([]);
        }}
      >
        {actors.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
  const known = detail.knowledge[actor] ?? [];

  return (
    <details>
      <summary>作者介入</summary>
      <div className="panel-form" role="form" aria-label="作者介入">
        <label>
          介入方式
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="edit_knowledge">改一个角色的认知</option>
            <option value="external_event">加入一件外部的事（只能在两个回合之间）</option>
            <option value="replace_action">替换一个角色这一回合的行动</option>
          </select>
        </label>
        {kind === 'edit_knowledge' ? (
          <>
            {actorSelect}
            <label>
              让他多知道一件事（可不填）
              <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <label>
              来源方式
              <select value={modality} onChange={(e) => setModality(e.target.value as keyof typeof MODALITY)}>
                {Object.entries(MODALITY).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              相信程度（0 到 1）
              <input type="number" min={0} max={1} step={0.1} value={confidence} onChange={(e) => setConfidence(e.target.value)} />
            </label>
            <label>
              涉及的对象（键，用顿号分开）
              <input value={about} onChange={(e) => setAbout(e.target.value)} />
            </label>
            <fieldset>
              <legend>让他不再相信（撤回）</legend>
              {known.length === 0 ? <span className="muted">他现在没有可撤回的认知。</span> : null}
              {known.map((k) => (
                <label key={k.id}>
                  <input type="checkbox" checked={retract.includes(k.id)} onChange={(e) => setRetract(e.target.checked ? [...retract, k.id] : retract.filter((x) => x !== k.id))} />
                  {k.text}
                </label>
              ))}
            </fieldset>
          </>
        ) : kind === 'external_event' ? (
          <>
            <label>
              发生在哪个区域
              <select value={zone} onChange={(e) => setZone(e.target.value)}>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
              看得见（看得见这个区域的人会看到）
            </label>
            <label>
              响度（0 为没有声音）
              <input type="number" min={0} step={1} value={loudness} onChange={(e) => setLoudness(e.target.value)} />
            </label>
            <label>
              看到的是什么
              <input value={visual} onChange={(e) => setVisual(e.target.value)} />
            </label>
            <label>
              听到的是什么
              <input value={sound} onChange={(e) => setSound(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            {actorSelect}
            <label>
              行动
              <select value={action} onChange={(e) => setAction(e.target.value as ActionKind)}>
                {ACTION_KINDS.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              对象（角色、区域、物品或机关的键，可不填）
              <input value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
            <label>
              用到的物品
              <select value={item} onChange={(e) => setItem(e.target.value)}>
                <option value="">不用物品</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              去哪个区域（移动时）
              <select value={toZone} onChange={(e) => setToZone(e.target.value)}>
                <option value="">不移动</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              台词（每行一句，可不填）
              <textarea rows={2} value={speech} onChange={(e) => setSpeech(e.target.value)} />
            </label>
            <label>
              音量
              <select value={volume} onChange={(e) => setVolume(e.target.value as keyof typeof VOLUME)}>
                {Object.entries(VOLUME).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              旁人看得见的动作（一句话，可不填）
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </>
        )}
        <label>
          介入的原因（会记在运行记录里）
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="button" disabled={locked || reason.trim() === ''} onClick={() => void submit()}>
          介入
        </button>
      </div>
    </details>
  );
}

/** 分支（B30）：从记有快照的时点分出一条新的推演，原来的不动。 */
export function ForkPanel({ detail, locked }: { readonly detail: SimRunDetail; readonly locked: boolean }) {
  const fork = useApp((s) => s.forkSimRun);
  if (detail.forkPoints.length === 0) return null;
  return (
    <details>
      <summary>分支</summary>
      <p className="muted">从下面的时点分出一条新的推演：新的推演带着到那一刻为止的全部记录，原来的这一次不变。</p>
      <ul aria-label="可以分支的时点">
        {detail.forkPoints.map((p) => (
          <li key={p.seq} className="skill-actions">
            <span>
              第 {p.round} 回合 · {p.label}
            </span>
            <button type="button" disabled={locked} aria-label={`从第 ${p.round} 回合${p.label}分出新的推演`} onClick={() => void fork(p.seq)}>
              从这里分出新的推演
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

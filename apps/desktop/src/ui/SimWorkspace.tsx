import { useState } from 'react';
import type { ViewerData, ViewerKnowledge, ViewerRound } from '@fudiao/engine';
import type { SimRun } from '@fudiao/store';
import { describeObservation } from '../app/sim-describe';
import type { SimRunDetail } from '../app/simulation';
import { EvaluationPanel } from './EvaluationPanel';
import { NarrationPanel } from './NarrationPanel';
import { ForkPanel, IntervenePanel, PendingPanel } from './SimAuthorPanel';
import { useApp } from './store-context';

const KIND: Readonly<Record<string, string>> = {
  observe: '观察',
  move: '移动',
  probe: '试探',
  attack: '攻击',
  defend: '防御',
  use_item: '使用物品',
  take: '拾取',
  drop: '放下',
  speak: '说话',
  withdraw: '撤离',
  wait: '等待',
  other: '其他',
  failed_attempt: '失败的尝试',
  trap_triggered: '触发机关',
  discovered: '发现',
  ruled: '裁决结果',
  external: '外部事件',
};
const MODALITY: Readonly<Record<string, string>> = { observed: '亲身经历', heard: '听到', inferred: '推测', claimed: '他人说法' };
const CHANNEL: Readonly<Record<string, string>> = { participant: '当事人', sight: '看见', sound: '听见' };
const INJURY: Readonly<Record<string, string>> = { none: '无伤', light: '轻伤', severe: '重伤', incapacitated: '失去行动能力' };
const PHASE: Readonly<Record<SimRunDetail['view']['phase'], string>> = {
  BuildingViews: '准备角色所见',
  Directing: '导演提议',
  AwaitingProposals: '等待角色行动',
  Adjudicating: '裁决',
  AwaitingAuthor: '等待作者',
  Committing: '提交结果',
  UpdatingBeliefs: '更新认知',
  CheckingEnd: '检查是否结束',
  Paused: '已暂停',
  Ended: '已结束',
};
const END: Readonly<Record<string, string>> = { max_rounds: '到达回合上限', actors_left: '角色都已离场', budget: '预算用完', author_stop: '作者停止', stalemate: '僵局' };
const PAUSE: Readonly<Record<string, string>> = {
  author: '作者暂停',
  proposal_invalid: '角色的行动多次不合规则',
  llm_error: '模型调用失败',
  refused: '模型拒绝了请求',
  truncated: '模型的输出被截断',
  invalid_output: '模型的输出格式不对',
  ruling_invalid: '裁决不合规则',
  stalemate: '僵局',
};
const RUN_STATUS: Readonly<Record<SimRun['status'], string>> = { created: '还没有开始', running: '进行中', awaiting_author: '等待作者', paused: '已暂停', ended: '已结束' };

const label = (map: Readonly<Record<string, string>>, key: string) => map[key] ?? key;
const usd = (v: number) => `$${v.toFixed(4)}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;


function Knowledge({ item, name }: { readonly item: ViewerKnowledge; readonly name: (id: string) => string }) {
  const body = item.text ?? (item.claim !== null ? `${name(item.claim.speaker)}说：“${item.claim.sentences.join('')}”` : item.observation !== null ? describeObservation(item.observation, name) : '');
  return (
    <li>
      <span className="muted">【{label(MODALITY, item.modality)}】</span>
      {item.order === 2 && item.concerning !== null ? `（猜${name(item.concerning)}怎么看自己）` : ''}
      {body}
      <span className="muted">
        {' '}
        第 {item.round} 回合 · 相信程度 {item.confidence === null ? '未评估' : item.confidence.toFixed(2)}
      </span>
    </li>
  );
}

/** 全局局面：这一回合各角色的行动与内心片段、裁决、发生的事与谁察觉到了、回合结束时的局面。 */
function GlobalView({ round }: { readonly round: ViewerRound }) {
  return (
    <div aria-label="全局局面">
      <h4>行动</h4>
      <ul className="skill-list">
        {round.proposals.map((p, i) => (
          <li key={i} className="skill" aria-label={`${p.actor}的行动`}>
            <div>
              <strong>{p.actor}</strong> {label(KIND, p.kind)}
              {p.target === null ? '' : ` → ${p.target}`}
              {p.item === null ? '' : `（${p.item}）`}
              {p.toZone === null ? '' : ` → ${p.toZone}`}
              <span className="muted"> {p.source}</span>
              {p.rejected === null ? null : <span className="field-error"> 被规则拒绝：{p.rejected}</span>}
            </div>
            {p.sentences.length > 0 ? <div>“{p.sentences.join('')}”</div> : null}
            {p.intent === null ? null : (
              <div className="muted">
                目标：{p.intent}
                {p.rationale === null ? '' : `；依据：${p.rationale}`}
              </div>
            )}
            {p.innerThought === null || p.innerThought === '' ? null : <div className="sim-thought">内心：{p.innerThought}</div>}
          </li>
        ))}
      </ul>
      {round.rulings.length > 0 ? (
        <>
          <h4>语义裁决</h4>
          <ul>
            {round.rulings.map((r) => (
              <li key={r.requestId}>
                {r.rationale}
                <span className="muted"> {r.by === null ? '等待确认' : r.by === 'auto' ? '自动接受' : '作者确认'}</span>
                {r.needsReview ? <span className="field-error"> 待复核</span> : null}
                {r.uncertainties.length > 0 ? <div className="muted">待核实：{r.uncertainties.join('；')}</div> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>发生的事与感知</h4>
      <ul>
        {round.occurrences.map((o) => (
          <li key={o.id}>
            {o.actor === null ? '' : `${o.actor} `}
            {label(KIND, o.kind)}
            {o.item === null ? '' : ` ${o.item}`}
            {o.target === null ? '' : ` → ${o.target}`}（{o.zones.join(' → ')}）{o.sentences.length > 0 ? `：“${o.sentences.join('')}”` : ''}
            {o.visual === null ? '' : `：${o.visual}`}
            {o.sound === null ? '' : `（${o.sound}）`}
            <div className="muted">{o.perceivedBy.length > 0 ? `察觉到的人：${o.perceivedBy.map((p) => `${p.actor}（${label(CHANNEL, p.channel)}）`).join('、')}` : '没有人察觉'}</div>
          </li>
        ))}
      </ul>
      <h4>回合结束时的局面</h4>
      <table className="source-table" aria-label="回合结束时的局面">
        <thead>
          <tr>
            <th scope="col">人物</th>
            <th scope="col">位置</th>
            <th scope="col">伤势</th>
            <th scope="col">状态</th>
          </tr>
        </thead>
        <tbody>
          {round.world.actors.map((a) => (
            <tr key={a.id}>
              <th scope="row">{a.name}</th>
              <td>{a.zone}</td>
              <td>{label(INJURY, a.injury)}</td>
              <td>{a.status === 'present' ? '在场' : '已离开'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul>
        {round.world.items.map((i) => (
          <li key={i.name}>
            {i.name}：{i.where}
            {Object.entries(i.counters)
              .map(([k, v]) => `（${k} ${v}）`)
              .join('')}
          </li>
        ))}
        {round.world.mechanisms.map((m) => (
          <li key={m.name}>
            {m.name}（{m.zone}）：{m.armed ? '还没有触发' : '已触发'}
          </li>
        ))}
      </ul>
      {round.notes.length > 0 ? (
        <>
          <h4>提示</h4>
          <ul aria-label="提示" className="field-error">
            {round.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** 一个角色在这一回合结束时所见：与发给这个角色代理的信息一致，可能与事实不符。 */
function ActorView({ round, actorId, data }: { readonly round: ViewerRound; readonly actorId: string; readonly data: ViewerData }) {
  const view = round.views[actorId];
  const name = (id: string) => data.names[id] ?? id;
  if (view === undefined) return <p className="muted">没有数据。</p>;
  return (
    <div aria-label={`${name(actorId)}所见`}>
      <p>
        在{view.zone}，{label(INJURY, view.injury)}
        {view.status === 'present' ? '' : '，已离开现场'}。身上：{view.items.join('、') || '没有东西'}
      </p>
      <h4>看得见的人与物</h4>
      <ul>
        {view.visibleActors.map((a) => (
          <li key={a.name}>
            {a.name}（{a.zone}）{a.holding.length > 0 ? `，手里拿着${a.holding.join('、')}` : ''}
          </li>
        ))}
        {view.visibleItems.map((i) => (
          <li key={i.name}>
            {i.name}（{i.zone}）
          </li>
        ))}
        {view.mechanisms.map((m) => (
          <li key={m}>知道有：{m}</li>
        ))}
      </ul>
      <h4>认知（可能与事实不符）</h4>
      <ul aria-label="认知">
        {view.knowledge.map((k) => (
          <Knowledge key={k.id} item={k} name={name} />
        ))}
      </ul>
    </div>
  );
}

function Timeline({ data }: { readonly data: ViewerData }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [tab, setTab] = useState('global');
  if (data.rounds.length === 0) return <p className="muted">还没有完成的回合。</p>;
  // 没有特意选回合时跟着最新的一回合。
  const round = data.rounds.find((r) => r.round === picked) ?? data.rounds.at(-1);
  if (round === undefined) return null;
  return (
    <section aria-label="时间线">
      <div className="skill-actions" role="group" aria-label="回合">
        {data.rounds.map((r) => (
          <button key={r.round} type="button" aria-pressed={r.round === round.round} onClick={() => setPicked(r.round)}>
            第 {r.round} 回合
          </button>
        ))}
      </div>
      <div className="skill-actions" role="tablist" aria-label="看谁所见">
        <button type="button" role="tab" aria-selected={tab === 'global'} onClick={() => setTab('global')}>
          全局局面
        </button>
        {data.actors.map((a) => (
          <button key={a.id} type="button" role="tab" aria-selected={tab === a.id} onClick={() => setTab(a.id)}>
            {a.name}所见
          </button>
        ))}
      </div>
      {tab === 'global' ? <GlobalView round={round} /> : <ActorView round={round} actorId={tab} data={data} />}
    </section>
  );
}

/** 一次推演的工作区（B28）：状态与费用、单步、继续、暂停、停止，时间线与等待时间。 */
function RunView({ detail }: { readonly detail: SimRunDetail }) {
  const advancing = useApp((s) => s.simAdvancing);
  const step = useApp((s) => s.stepSimRun);
  const proceed = useApp((s) => s.continueSimRun);
  const pause = useApp((s) => s.pauseSimRun);
  const stop = useApp((s) => s.stopSimRun);
  const verify = useApp((s) => s.verifySimRun);
  const verification = useApp((s) => (s.simVerification?.runId === detail.view.run.id ? s.simVerification : null));
  const [confirmStop, setConfirmStop] = useState(false);
  const { view, data, timing } = detail;
  const ended = view.phase === 'Ended';
  const waiting = view.phase === 'AwaitingAuthor';
  const state = ended
    ? `已结束：${label(END, view.endReason ?? '')}`
    : view.phase === 'Paused'
      ? `已暂停：${label(PAUSE, view.pause?.reason ?? '')}${view.pause?.detail === undefined ? '' : `（${view.pause.detail}）`}`
      : `${advancing ? '正在推进' : '可以继续'} · ${PHASE[view.phase]}`;
  const budget = view.run.budgetUsd;
  return (
    <section aria-label="推演工作区">
      <p role="status">
        第 {view.round} 回合 · {state}
        <span className="muted">
          {' '}
          已用 {usd(view.spentUsd)}
          {budget === null ? '' : ` / 预算 ${usd(budget)}`}
          {view.unknownCostCalls > 0 ? `（另有 ${view.unknownCostCalls} 次调用费用未知）` : ''}
        </span>
      </p>
      {waiting ? (
        <p className="field-error">
          {view.awaitingRulings > 0 ? `有 ${view.awaitingRulings} 条待核实的裁决等你确认。` : ''}
          {view.awaitingDirector ? '有一条导演提议等你决定。' : ''}
        </p>
      ) : null}
      <div className="skill-actions">
        <button type="button" disabled={advancing || ended || waiting} onClick={() => void step()}>
          单步
        </button>
        <button type="button" disabled={advancing || ended || waiting} onClick={() => void proceed()}>
          继续
        </button>
        <button type="button" disabled={ended || view.phase === 'Paused' || waiting} onClick={() => void pause()}>
          暂停
        </button>
        {confirmStop ? (
          <>
            <span>停止后这次推演就结束了，不能再继续；已有的记录保留。</span>
            <button type="button" onClick={() => void stop().then(() => setConfirmStop(false))}>
              确定停止
            </button>
            <button type="button" onClick={() => setConfirmStop(false)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" disabled={ended} onClick={() => setConfirmStop(true)}>
            停止
          </button>
        )}
      </div>
      <div className="skill-actions">
        <button type="button" disabled={advancing} title="只读运行记录重新算一遍，与当时记下的状态比较；不调用模型" onClick={() => void verify()}>
          校验回放
        </button>
        {verification === null ? null : (
          <span role="note" className={verification.mismatchedSeqs.length > 0 ? 'field-error' : 'muted'}>
            {verification.snapshots === 0
              ? '这次推演还没有记下快照，没有可校验的。'
              : verification.mismatchedSeqs.length === 0
                ? `回放一致：${verification.snapshots} 个快照处重算的状态都与当时记下的相同。`
                : `回放不一致：${verification.mismatchedSeqs.length} 个快照处（序号 ${verification.mismatchedSeqs.join('、')}）重算的状态与当时记下的不同，这次运行的记录不可信。`}
          </span>
        )}
      </div>
      <PendingPanel detail={detail} locked={advancing} />
      {ended ? null : <IntervenePanel detail={detail} locked={advancing} />}
      <ForkPanel detail={detail} locked={advancing} />
      <NarrationPanel detail={detail} />
      {ended ? <EvaluationPanel runId={detail.view.run.id} /> : null}
      {data === null ? null : <Timeline data={data} />}
      {timing.length > 0 ? (
        <details>
          <summary>等待时间</summary>
          <table className="source-table" aria-label="等待时间">
            <thead>
              <tr>
                <th scope="col">回合</th>
                <th scope="col">这一回合等了多久</th>
                <th scope="col">其中模型响应</th>
                <th scope="col">模型调用</th>
              </tr>
            </thead>
            <tbody>
              {timing.map((t) => (
                <tr key={t.round}>
                  <th scope="row">第 {t.round} 回合</th>
                  <td>{t.waitMs === null ? '还没有结束' : seconds(t.waitMs)}</td>
                  <td>{seconds(t.modelMs)}</td>
                  <td>{t.calls} 次</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">同一回合里各角色的行动是同时请求的，所以模型响应的合计可以比这一回合等的时间长。</p>
        </details>
      ) : null}
    </section>
  );
}

/** 一个场景的推演：开始新的推演，或打开以前的运行。 */
export function SimWorkspace() {
  const runs = useApp((s) => s.simRuns);
  const selected = useApp((s) => s.simRunId);
  const detail = useApp((s) => s.simRun);
  const advancing = useApp((s) => s.simAdvancing);
  const start = useApp((s) => s.startSimRun);
  const select = useApp((s) => s.selectSimRun);
  const [mode, setMode] = useState<'auto' | 'interactive'>('auto');
  const [budget, setBudget] = useState('');
  const limit = budget.trim() === '' ? undefined : Number(budget);
  return (
    <section aria-label="推演运行" className="panel-form">
      <div className="skill-actions" role="form" aria-label="开始推演">
        <label>
          模式
          <select value={mode} onChange={(e) => setMode(e.target.value as 'auto' | 'interactive')}>
            <option value="auto">自动：待核实的裁决自动接受并标为待复核</option>
            <option value="interactive">交互：待核实的裁决等我确认</option>
          </select>
        </label>
        <label>
          预算上限（美元，可不填）
          <input type="number" min={0} step={0.1} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <button type="button" disabled={advancing || (limit !== undefined && !(limit > 0))} onClick={() => void start({ mode, ...(limit !== undefined && { budgetUsd: limit }) })}>
          开始新的推演
        </button>
      </div>
      {runs.length > 0 ? (
        <nav aria-label="这个场景的推演" className="skill-actions">
          {runs.map((r, i) => (
            <button key={r.id} type="button" aria-current={r.id === selected} disabled={advancing && r.id !== selected} onClick={() => void select(r.id)}>
              第 {runs.length - i} 次 · {RUN_STATUS[r.status]}
              {r.status === 'ended' ? '' : ` · 第 ${r.round} 回合`}
              {r.parentRunId === null ? '' : ' · 分支'}
            </button>
          ))}
        </nav>
      ) : (
        <p className="muted">这个场景还没有推演过。</p>
      )}
      {detail === null ? null : <RunView key={detail.view.run.id} detail={detail} />}
    </section>
  );
}

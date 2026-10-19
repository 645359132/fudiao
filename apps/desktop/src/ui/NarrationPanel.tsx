import { useState } from 'react';
import type { BeatTreatment } from '@fudiao/store';
import type { BeatSheetView } from '../app/narration';
import type { SimRunDetail } from '../app/simulation';
import { useApp } from './store-context';

const TREATMENT: Readonly<Record<BeatTreatment, string>> = { expand: '展开', brief: '略写', omit: '省略', flashback: '倒叙', blank: '留白' };

/** 一张节拍表（B45）：作者为每个节拍选处理方式、写说明、标记暂不向读者揭示，再写成正文。 */
function SheetEditor({ view }: { readonly view: BeatSheetView }) {
  const save = useApp((s) => s.saveBeatSheet);
  const narrate = useApp((s) => s.narrateBeatSheet);
  const busy = useApp((s) => s.narrationBusy);
  const chapters = useApp((s) => s.work?.chapters ?? []);
  const [beats, setBeats] = useState(view.sheet.beats);
  const [style, setStyle] = useState(view.sheet.style);
  const [chapterId, setChapterId] = useState(chapters[0]?.id ?? '');
  const [dirty, setDirty] = useState(false);
  const set = (i: number, patch: Partial<(typeof beats)[number]>) => {
    setBeats(beats.map((b, j) => (j === i ? { ...b, ...patch } : b)));
    setDirty(true);
  };
  return (
    <div className="panel-form" role="form" aria-label={`${view.povName}视角的节拍表`}>
      <table className="source-table" aria-label="节拍">
        <thead>
          <tr>
            <th scope="col">回合</th>
            <th scope="col">{view.povName}的见闻</th>
            <th scope="col">处理</th>
            <th scope="col">说明</th>
            <th scope="col">暂不向读者揭示</th>
          </tr>
        </thead>
        <tbody>
          {view.beats.map((b, i) => (
            <tr key={b.ref} aria-label={`节拍 ${i + 1}`}>
              <td>{b.round}</td>
              <td>{b.text}</td>
              <td>
                <select aria-label="处理" value={beats[i]?.treatment ?? b.treatment} onChange={(e) => set(i, { treatment: e.target.value as BeatTreatment })}>
                  {Object.entries(TREATMENT).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input aria-label="说明" value={beats[i]?.note ?? ''} onChange={(e) => set(i, { note: e.target.value })} />
              </td>
              <td>
                <input type="checkbox" aria-label="暂不向读者揭示" checked={beats[i]?.withhold ?? false} onChange={(e) => set(i, { withhold: e.target.checked })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {beats.some((b) => b.treatment === 'omit') && (
        <p className="muted">标为省略的见闻不写进正文；省略的最早那一回合之后，{view.povName}的内心片段也不再作为素材，免得经心理描写带出来。</p>
      )}
      <label>
        文风（可不填）
        <input
          value={style}
          onChange={(e) => {
            setStyle(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <div className="skill-actions">
        <button type="button" disabled={busy || !dirty} onClick={() => void save(view.sheet.id, { beats, style }).then((ok) => ok && setDirty(false))}>
          保存节拍表
        </button>
        <label>
          写到哪一章的末尾
          <select value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
            {chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy || dirty || chapterId === ''} title={dirty ? '先保存节拍表' : '只用视角角色当时的认知，结果先成为候选稿'} onClick={() => void narrate(view.sheet.id, chapterId)}>
          按节拍表写成正文
        </button>
      </div>
      {chapters.length === 0 ? <p className="muted">作品里还没有章节：先在章节目录里新建一章。</p> : null}
    </div>
  );
}

/**
 * 推演写成正文（B29、B45、B62）：选视角角色与回合范围生成节拍表，作者修改后写成正文。
 * 只用视角角色在所选回合结束时的认知；结果先成为这一章末尾的候选稿，在章节的“AI 写作”里比较、修改与采纳。
 */
export function NarrationPanel({ detail }: { readonly detail: SimRunDetail }) {
  const sheets = useApp((s) => s.beatSheets);
  const busy = useApp((s) => s.narrationBusy);
  const note = useApp((s) => s.narrationNote);
  const draft = useApp((s) => s.draftBeatSheet);
  const openCandidate = useApp((s) => s.openNarratedChapter);
  const rounds = detail.data?.rounds.map((r) => r.round) ?? [];
  const [pov, setPov] = useState(detail.cast.actors[0]?.id ?? '');
  const [from, setFrom] = useState(rounds[0] ?? 1);
  const [to, setTo] = useState(rounds.at(-1) ?? 1);
  const [notes, setNotes] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const current = sheets.find((s) => s.sheet.id === picked) ?? sheets[0];

  return (
    <details>
      <summary>写成正文</summary>
      <div className="panel-form" role="form" aria-label="生成节拍表">
        <p className="muted">正文只用视角角色在所选回合结束时知道的事；别人心里想什么、他没看见没听见的事都不会写进去。</p>
        <label>
          视角角色
          <select value={pov} onChange={(e) => setPov(e.target.value)}>
            {detail.cast.actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {rounds.length === 0 ? (
          <p className="muted">还没有结束的回合，推演结束一回合后才能写。</p>
        ) : (
          <div className="skill-actions">
            <label>
              从第
              <select aria-label="从第几回合" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
                {rounds.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              回合
            </label>
            <label>
              到第
              <select aria-label="到第几回合" value={to} onChange={(e) => setTo(Number(e.target.value))}>
                {rounds.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              回合
            </label>
          </div>
        )}
        <label>
          给节拍表的说明（可不填，例如“对峙展开，奔走略写”）
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={busy || rounds.length === 0}
          onClick={() =>
            void draft({ pov, fromRound: Math.min(from, to), toRound: Math.max(from, to), notes }).then((id) => {
              if (id !== null) setPicked(id);
            })
          }
        >
          {busy ? '正在生成…' : '生成节拍表'}
        </button>
      </div>
      {sheets.length > 0 ? (
        <nav className="skill-actions" aria-label="节拍表">
          {sheets.map((s, i) => (
            <button key={s.sheet.id} type="button" aria-current={s.sheet.id === current?.sheet.id} onClick={() => setPicked(s.sheet.id)}>
              节拍表 {sheets.length - i} · {s.povName} · 第 {s.sheet.fromRound}–{s.sheet.toRound} 回合
            </button>
          ))}
        </nav>
      ) : null}
      {current === undefined ? null : <SheetEditor key={`${current.sheet.id}:${current.sheet.version}`} view={current} />}
      {note === null ? null : (
        <p role="note" className="skill-actions">
          <span>{note.text}</span>
          <button type="button" onClick={() => void openCandidate(note.chapterId)}>
            打开这一章看候选稿
          </button>
        </p>
      )}
    </details>
  );
}

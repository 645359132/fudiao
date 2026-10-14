import { useState } from 'react';
import type { SceneSpecInput } from '@fudiao/domain';
import { removeZone, renameZone, setZoneEdge, zonePairs } from '../app/scene-editing';

/** 声音经过一条关系时的衰减量可选的档位；“传不过去”为 null。 */
const SOUND_LEVELS = [0, 1, 2, 3, 4] as const;

const freshZone = (taken: readonly string[]) => {
  for (let n = taken.length + 1; ; n++) if (!taken.includes(`zone_${n}`)) return `zone_${n}`;
};

/** 区域的键：输入时只改输入框里的字，离开输入框（或按回车）才改名，引用它的地方随之一并改过来。 */
function ZoneKeyInput({ id, onRename }: { readonly id: string; readonly onRename: (to: string) => void }) {
  const [text, setText] = useState(id);
  const commit = () => {
    const next = text.trim();
    if (next === '') setText(id);
    else if (next !== id) onRename(next);
  };
  return (
    <input
      aria-label="区域的键"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        commit();
      }}
    />
  );
}

/**
 * 区域图的表格编辑（需求 B41，施工文档 M4-03）：区域列表，区域两两之间能不能走过去、看不看得见、声音传不传得过去。
 * 首版不做画布。改区域的键时，引用它的地方（角色与物品的位置、机关、出口）一并改过来。
 */
export function ZoneGraphEditor({ config, onChange }: { readonly config: SceneSpecInput; readonly onChange: (next: SceneSpecInput) => void }) {
  const zones = config.zones;
  const exits = config.exits ?? [];
  const nameOf = (id: string) => zones.find((z) => z.id === id)?.name ?? id;
  return (
    <section aria-label="区域">
      <h3>区域</h3>
      <table className="source-table" aria-label="区域列表">
        <thead>
          <tr>
            <th scope="col">键</th>
            <th scope="col">名字</th>
            <th scope="col">可以从这里撤离</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {zones.map((z, i) => (
            <tr key={i} aria-label={`区域 ${z.name}`}>
              <td>
                <ZoneKeyInput key={z.id} id={z.id} onRename={(to) => onChange(renameZone(config, z.id, to))} />
              </td>
              <td>
                <input aria-label="区域的名字" value={z.name} onChange={(e) => onChange({ ...config, zones: zones.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`可以从${z.name}撤离`}
                  checked={exits.includes(z.id)}
                  onChange={(e) => onChange({ ...config, exits: e.target.checked ? [...exits, z.id] : exits.filter((x) => x !== z.id) })}
                />
              </td>
              <td>
                <button type="button" disabled={zones.length <= 1} aria-label={`删除区域 ${z.name}`} onClick={() => onChange(removeZone(config, z.id))}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">{exits.length === 0 ? '没有指定出口：角色可以从任何区域撤离。' : '只能从勾选的区域撤离。'}</p>
      <button type="button" onClick={() => onChange({ ...config, zones: [...zones, { id: freshZone(zones.map((z) => z.id)), name: '新区域' }] })}>
        添加区域
      </button>

      {zones.length > 1 ? (
        <>
          <h4>区域之间的关系</h4>
          <p className="muted">相邻：一回合内可以走过去。看得见：两边互相看得见（视线不传递）。声音每经过一条关系减弱一些，减到 0 就听不见了。</p>
          <table className="source-table" aria-label="区域之间的关系">
            <thead>
              <tr>
                <th scope="col">两个区域</th>
                <th scope="col">相邻</th>
                <th scope="col">看得见</th>
                <th scope="col">声音</th>
                <th scope="col">通行所需的标记</th>
              </tr>
            </thead>
            <tbody>
              {zonePairs(config).map(({ a, b, edge }, index) => {
                const pair = `${nameOf(a)}与${nameOf(b)}`;
                return (
                  // 按位置而不是按键标识这一行：区域改名时这一行原地更新，正在点的勾选框不会被换掉。
                  <tr key={index} aria-label={pair}>
                    <th scope="row">
                      {nameOf(a)} ↔ {nameOf(b)}
                    </th>
                    <td>
                      <input type="checkbox" aria-label={`${pair}相邻`} checked={edge?.adjacent ?? false} onChange={(e) => onChange(setZoneEdge(config, a, b, { adjacent: e.target.checked }))} />
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`${pair}互相看得见`} checked={edge?.visible ?? false} onChange={(e) => onChange(setZoneEdge(config, a, b, { visible: e.target.checked }))} />
                    </td>
                    <td>
                      <select
                        aria-label={`${pair}之间的声音`}
                        value={edge === null || edge.sound === null ? '' : String(edge.sound)}
                        onChange={(e) => onChange(setZoneEdge(config, a, b, { sound: e.target.value === '' ? null : Number(e.target.value) }))}
                      >
                        <option value="">传不过去</option>
                        {SOUND_LEVELS.map((n) => (
                          <option key={n} value={n}>
                            {n === 0 ? '不减弱' : `减弱 ${n}`}
                          </option>
                        ))}
                        {edge !== null && edge.sound !== null && !SOUND_LEVELS.includes(edge.sound as (typeof SOUND_LEVELS)[number]) ? <option value={edge.sound}>减弱 {edge.sound}</option> : null}
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label={`${pair}通行所需的标记`}
                        placeholder="例如 door_open"
                        value={edge?.requiresFlag ?? ''}
                        onChange={(e) => onChange(setZoneEdge(config, a, b, { requiresFlag: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

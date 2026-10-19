import type { BookSeed } from '../app/quick-book';

/** 作品骨架的各项（作品名、类型、简介、大纲、人物与关系），成书页与写作工作流共用；改动经 onChange 交出。 */
export function BookSeedFields({ seed, onChange }: { readonly seed: BookSeed; readonly onChange: (seed: BookSeed) => void }) {
  const patch = (p: Partial<BookSeed>) => onChange({ ...seed, ...p });
  const setCharacter = (i: number, p: Partial<BookSeed['characters'][number]>) => patch({ characters: seed.characters.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  return (
    <>
      <label>
        作品名
        <input value={seed.title} onChange={(e) => patch({ title: e.currentTarget.value })} />
      </label>
      <label>
        类型
        <input value={seed.genre} onChange={(e) => patch({ genre: e.currentTarget.value })} />
      </label>
      <label>
        简介
        <textarea rows={2} value={seed.synopsis} onChange={(e) => patch({ synopsis: e.currentTarget.value })} />
      </label>
      <label>
        大纲
        <textarea rows={10} value={seed.outline} onChange={(e) => patch({ outline: e.currentTarget.value })} />
      </label>
      <fieldset>
        <legend>主要人物</legend>
        {seed.characters.map((c, i) => (
          <div key={i} className="book-character">
            <input aria-label={`人物 ${i + 1} 的名字`} value={c.name} onChange={(e) => setCharacter(i, { name: e.currentTarget.value })} />
            <input aria-label={`人物 ${i + 1} 的说明`} value={c.description} onChange={(e) => setCharacter(i, { description: e.currentTarget.value })} />
            <button type="button" aria-label={`删去人物 ${c.name}`} onClick={() => patch({ characters: seed.characters.filter((_, j) => j !== i) })}>
              删去
            </button>
          </div>
        ))}
        <button type="button" onClick={() => patch({ characters: [...seed.characters, { name: '', description: '' }] })}>
          添加人物
        </button>
      </fieldset>
      {(seed.relationships ?? []).length === 0 ? null : (
        <fieldset>
          <legend>人物关系</legend>
          <p className="muted">采用后建进“人物关系”，之后可以在关系图上修改。</p>
          <ul className="relation-list" aria-label="骨架里的人物关系">
            {(seed.relationships ?? []).map((r, i) => (
              <li key={i} className={`book-relation rel-${r.category}`}>
                <span className="rel-dot" aria-hidden="true" />
                <span>
                  {r.mutual ? `${r.from}与${r.to}：${r.label}` : `${r.from}是${r.to}的${r.label}`}
                  {r.secret ? '（隐秘）' : ''}
                  {r.description.trim() === '' ? null : <span className="muted"> · {r.description}</span>}
                </span>
                <button type="button" className="ghost" aria-label={`删去关系 ${r.from}与${r.to}`} onClick={() => patch({ relationships: (seed.relationships ?? []).filter((_, j) => j !== i) })}>
                  删去
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </>
  );
}

import { useState } from 'react';
import type { SearchHit } from '@fudiao/store';
import { useApp } from './store-context';

/** 按章节分组，保持结果的顺序。 */
function byChapter(hits: readonly SearchHit[]): { chapterId: string; title: string; hits: SearchHit[] }[] {
  const groups: { chapterId: string; title: string; hits: SearchHit[] }[] = [];
  for (const h of hits) {
    const last = groups.at(-1);
    if (last?.chapterId === h.chapterId) last.hits.push(h);
    else groups.push({ chapterId: h.chapterId, title: h.chapterTitle, hits: [h] });
  }
  return groups;
}

/** 全文查找（需求 B04）：查回收站以外的全部章节，点击结果打开章节并选中该处。 */
export function SearchPanel() {
  const query = useApp((s) => s.searchQuery);
  const result = useApp((s) => s.searchResult);
  const runSearch = useApp((s) => s.runSearch);
  const revealHit = useApp((s) => s.revealHit);
  const showPanel = useApp((s) => s.showPanel);
  const busy = useApp((s) => s.busy);
  const [value, setValue] = useState(query);

  return (
    <section aria-label="全文查找" className="search">
      <div className="history-head">
        <h2>全文查找</h2>
        <button type="button" onClick={() => void showPanel('chapter')}>
          返回正文
        </button>
      </div>
      <form
        className="text-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(value);
        }}
      >
        <input type="search" aria-label="查找内容" placeholder="查找内容" value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
        <button type="submit" disabled={busy || value.trim() === ''}>
          查找
        </button>
      </form>
      {result !== null && (
        <>
          <p className="muted" role="status">
            {result.hits.length === 0
              ? `没有找到“${result.query}”。`
              : result.truncated
                ? `超过 ${result.hits.length.toLocaleString('zh-CN')} 处，只显示前 ${result.hits.length.toLocaleString('zh-CN')} 处。可以输入更长的词缩小范围。`
                : `共 ${result.hits.length.toLocaleString('zh-CN')} 处。`}
          </p>
          {byChapter(result.hits).map((g) => (
            <section key={g.chapterId} className="search-group" aria-label={`${g.title}（${g.hits.length} 处）`}>
              <h3>
                {g.title}
                <span className="muted">（{g.hits.length} 处）</span>
              </h3>
              <ul className="search-hits">
                {g.hits.map((h) => (
                  <li key={`${h.paragraphId}:${h.start}`}>
                    <button type="button" onClick={() => void revealHit(h)}>
                      {h.before}
                      <mark>{h.match}</mark>
                      {h.after}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </section>
  );
}

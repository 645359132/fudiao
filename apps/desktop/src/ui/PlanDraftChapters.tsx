import type { PlanDraft } from '../app/planning';

/**
 * 计划草稿中的章节，按卷分组（B68）：每卷第一章之前写卷名与本卷梗概；不分卷的草稿就是一个章节列表。
 * withBeats 为 true 时列出每章的情节点（计划页），否则只有章名与目标（成书页）。
 */
export function PlanDraftChapters({ draft, withBeats }: { readonly draft: PlanDraft; readonly withBeats: boolean }) {
  const summaryOf = new Map((draft.volumes ?? []).map((v) => [v.title.trim(), v.summary]));
  const volumes = new Set(draft.chapters.map((c) => (c.volume ?? '').trim()).filter((v) => v !== '')).size;
  return (
    <>
      {volumes > 0 ? (
        <p className="muted">
          共 {draft.chapters.length} 章，分 {volumes} 卷。
        </p>
      ) : null}
      <ol aria-label="草稿中的章节">
        {draft.chapters.map((c, i) => {
          const volume = (c.volume ?? '').trim();
          const starts = volume !== '' && volume !== (draft.chapters[i - 1]?.volume ?? '').trim();
          return (
            <li key={i}>
              {starts ? (
                <div className="draft-volume">
                  <strong>{volume}</strong>
                  {summaryOf.get(volume) ? <span className="muted">：{summaryOf.get(volume)}</span> : null}
                </div>
              ) : null}
              <strong>{c.title}</strong>：{c.goal}
              {withBeats ? (
                <ul>
                  {c.beats.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

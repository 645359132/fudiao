import { CHAPTER_TYPE_LABEL, ENDING_STYLE_LABEL, parseChapterRhythm } from '@fudiao/shared';
import { planVariety } from '@fudiao/writing';
import type { PlanDraft } from '../app/planning';

/**
 * 计划草稿中的章节，按卷分组（B68）：每卷第一章之前写卷名与本卷梗概；不分卷的草稿就是一个章节列表。
 * withBeats 为 true 时列出每章的情节点（计划页），否则只有章名与目标（成书页）。
 */
export function PlanDraftChapters({ draft, withBeats }: { readonly draft: PlanDraft; readonly withBeats: boolean }) {
  const summaryOf = new Map((draft.volumes ?? []).map((v) => [v.title.trim(), v.summary]));
  const volumes = new Set(draft.chapters.map((c) => (c.volume ?? '').trim()).filter((v) => v !== '')).size;
  // 草稿的均一之处（B87）：章名长短、字数、章尾收法与过渡章。
  const variety = planVariety(draft.chapters.map((c) => ({ title: c.title, targetWords: c.targetWords, rhythm: parseChapterRhythm(c.rhythm ?? null) })));
  const rhythmNote = (c: PlanDraft['chapters'][number]) => {
    const r = parseChapterRhythm(c.rhythm ?? null);
    if (r === null) return null;
    return `（${CHAPTER_TYPE_LABEL[r.type]}，${ENDING_STYLE_LABEL[r.ending]}收尾${c.targetWords === null ? '' : `，约 ${c.targetWords} 字`}）`;
  };
  return (
    <>
      {variety.length > 0 ? (
        <ul className="muted" aria-label="草稿的均一之处">
          {variety.map((v) => (
            <li key={v.kind}>{v.description}</li>
          ))}
        </ul>
      ) : null}
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
              {rhythmNote(c) === null ? null : <span className="muted">{rhythmNote(c)}</span>}
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

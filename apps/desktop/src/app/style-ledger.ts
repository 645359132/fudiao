// 风格账本（需求 B87，M8-01）：最近几章的正文算出的文风数字——每章一行、用得太多的说法、最近几章的章尾。写手每章带上它
// （“这些说法不要再用”“最近几章都这样收尾”），审核的文风检查按它量。读最近 STYLE_WINDOW 章的段落（约几万字），纯函数在 packages/writing。
import { DIALOGUE_TARGET, CHAPTER_TYPE_LABEL, ENDING_STYLE_HINT, ENDING_STYLE_LABEL, err, ok, type ChapterRhythm, type Result } from '@fudiao/shared';
import { listParagraphs, type Chapter, type RepoError, type SqlPort } from '@fudiao/store';
import { describeLedger, percent, STYLE_WINDOW, styleLedger, type LedgerChapter, type LedgerText, type StyleLedger } from '@fudiao/writing';

export type RecentStyle = { readonly ledger: StyleLedger; readonly text: LedgerText };

/**
 * 第 index 章之前最近几章的账本。skip：跳过的章（写手正在写、正文还不完整）；names：设定的名字与别名，不算进高频词。
 */
export async function recentStyle(
  port: SqlPort,
  chapters: readonly Chapter[],
  index: number,
  { names, skip }: { readonly names: readonly string[]; readonly skip?: (chapterId: string) => boolean },
): Promise<Result<RecentStyle, RepoError>> {
  const recent = chapters.slice(Math.max(0, index - STYLE_WINDOW), Math.max(0, index)).filter((c) => skip?.(c.id) !== true);
  const items: LedgerChapter[] = [];
  for (const c of recent) {
    const paragraphs = await listParagraphs(port, c.id);
    if (!paragraphs.ok) return err(paragraphs.error);
    const texts = paragraphs.value.map((p) => p.text).filter((t) => t.trim() !== '');
    if (texts.length > 0) items.push({ title: c.title, paragraphs: texts });
  }
  const ledger = styleLedger(items, names);
  return ok({ ledger, text: describeLedger(ledger) });
}

/** 本章对话占比的目标：计划里定了对话多少就按它，没有定按“中”。 */
export const dialogueTargetOf = (rhythm: ChapterRhythm | null): number => DIALOGUE_TARGET[rhythm?.dialogue ?? 'mid'];

/** 节奏目标写成给写手看的中文；没有节奏时为 undefined（写手按技能里的一般要求写）。 */
export function rhythmText(rhythm: ChapterRhythm | null): { readonly type: string; readonly dialogueTarget: string; readonly endingStyle: string; readonly endingHint: string } | undefined {
  if (rhythm === null) return undefined;
  return {
    type: CHAPTER_TYPE_LABEL[rhythm.type],
    dialogueTarget: percent(DIALOGUE_TARGET[rhythm.dialogue]),
    endingStyle: ENDING_STYLE_LABEL[rhythm.ending],
    endingHint: ENDING_STYLE_HINT[rhythm.ending],
  };
}

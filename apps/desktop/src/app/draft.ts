import type { CurrentParagraph, SavedParagraph } from '@fudiao/store';
import { z } from 'zod';

/** 草稿文件：意外退出时尚未保存的章节内容（需求第八章“意外退出”）。 */
export const DraftFile = z.object({
  version: z.literal(1),
  chapterId: z.string(),
  /** 写草稿的时间（UTC ISO），恢复提示中显示。 */
  writtenAt: z.string(),
  paragraphs: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      source: z.enum(['handwritten', 'ai_generated', 'ai_modified', 'mixed']),
    }),
  ),
});
export type DraftFile = z.infer<typeof DraftFile>;

export function parseDraft(text: string, chapterId: string): DraftFile | null {
  try {
    const parsed = DraftFile.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.chapterId === chapterId ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 草稿与库中内容是否不同（只比较段落顺序、标识与文字）。 */
export function draftDiffers(draft: DraftFile, saved: readonly SavedParagraph[]): boolean {
  const a = draft.paragraphs.filter((p) => p.text !== '' || draft.paragraphs.length > 1);
  if (a.length !== saved.length) return true;
  return a.some((p, i) => p.id !== saved[i]?.id || p.text !== saved[i]?.text);
}

export const draftJson = (chapterId: string, writtenAt: string, paragraphs: readonly CurrentParagraph[]): string =>
  JSON.stringify({ version: 1, chapterId, writtenAt, paragraphs: [...paragraphs] } satisfies DraftFile);

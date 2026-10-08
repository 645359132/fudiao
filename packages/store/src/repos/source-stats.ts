// 段落来源统计（需求 B33）：每章与全书的 AI 参与比例与各来源的字数。不含回收站中的章节。
import { countWords, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { queryAll, type RepoError } from './common';
import { SourceKindColumn, SourceSpansColumn } from './paragraph';
import { aiCharacters, type SourceKind } from './paragraph-source';

/** 各来源段落的字数。 */
export type WordsBySource = Readonly<Record<SourceKind, number>>;

export type SourceTally = {
  readonly words: number;
  /** AI 区间内的字数；AI 参与比例 = aiWords ÷ words。 */
  readonly aiWords: number;
  readonly bySource: WordsBySource;
};

export type ChapterSourceStats = SourceTally & { readonly chapterId: string; readonly title: string };
export type SourceStats = { readonly chapters: readonly ChapterSourceStats[]; readonly total: SourceTally };

const Row = z.object({
  chapter_id: z.string(),
  title: z.string(),
  text: z.string().nullable(),
  source_kind: SourceKindColumn.nullable(),
  source_spans: SourceSpansColumn.nullable(),
});

const empty = (): { words: number; aiWords: number; bySource: Record<SourceKind, number> } => ({
  words: 0,
  aiWords: 0,
  bySource: { handwritten: 0, ai_generated: 0, ai_modified: 0, mixed: 0 },
});

export async function sourceStats(port: SqlPort): Promise<Result<SourceStats, RepoError>> {
  const rows = await queryAll(
    port,
    Row,
    `SELECT c.id AS chapter_id, c.title, p.text, p.source_kind, p.source_spans
       FROM chapter c LEFT JOIN paragraph p ON p.chapter_id = c.id
      WHERE c.status = 'normal'
      ORDER BY c.order_key, c.id, p.order_key`,
  );
  if (!rows.ok) return rows;
  const chapters: (ChapterSourceStats & ReturnType<typeof empty>)[] = [];
  const total = empty();
  for (const r of rows.value) {
    let chapter = chapters.at(-1);
    if (chapter?.chapterId !== r.chapter_id) {
      chapter = { chapterId: r.chapter_id, title: r.title, ...empty() };
      chapters.push(chapter);
    }
    if (r.text === null || r.source_kind === null) continue;
    const words = countWords(r.text);
    const ai = Math.min(words, aiCharacters(r.text, r.source_spans ?? []));
    for (const t of [chapter, total]) {
      t.words += words;
      t.aiWords += ai;
      t.bySource[r.source_kind] += words;
    }
  }
  return ok({ chapters, total });
}

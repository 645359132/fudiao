// 全文查找（需求 B04、施工文档第二章）：3 字及以上走 FTS5 trigram 索引；1 至 2 字 trigram 索引不到，退化为扫描段落。
// 只查回收站以外的章节，结果按章节与段落顺序排列。
import { ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { queryAll, type RepoError } from './common';

/** 一处匹配。start、end 是段内字符串下标（与编辑器的段内位置一致）。 */
export type SearchHit = {
  readonly chapterId: string;
  readonly chapterTitle: string;
  readonly paragraphId: string;
  readonly start: number;
  readonly end: number;
  /** 匹配前后的上下文，用于结果列表。 */
  readonly before: string;
  readonly match: string;
  readonly after: string;
};

export type SearchResult = {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  /** 匹配超过上限，只返回了前 limit 处。 */
  readonly truncated: boolean;
  /** index：走全文索引；scan：短查询，扫描段落。 */
  readonly mode: 'index' | 'scan';
};

/** trigram 索引的最短查询长度（按字符计）。 */
export const MIN_INDEXED_LENGTH = 3;
export const DEFAULT_HIT_LIMIT = 500;
const CONTEXT = 20;

const Row = z.object({ id: z.string(), chapter_id: z.string(), title: z.string(), text: z.string() });

const ORDER = 'ORDER BY c.order_key, c.id, p.order_key';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** FTS5 短语查询：整个查询作为一个短语，双引号写两遍。 */
const phrase = (q: string) => `"${q.replaceAll('"', '""')}"`;

export async function searchParagraphs(port: SqlPort, rawQuery: string, limit = DEFAULT_HIT_LIMIT): Promise<Result<SearchResult, RepoError>> {
  const query = rawQuery.trim();
  if (query === '') return ok({ query, hits: [], truncated: false, mode: 'index' });
  const mode = [...query].length >= MIN_INDEXED_LENGTH ? 'index' : 'scan';
  // 每段至少一处匹配，多取一段即可判断是否超过上限。
  const rows =
    mode === 'index'
      ? await queryAll(
          port,
          Row,
          `SELECT p.id, p.chapter_id, c.title, p.text
             FROM paragraph_fts f
             JOIN paragraph_search_key k ON k.id = f.rowid
             JOIN paragraph p ON p.id = k.paragraph_id
             JOIN chapter c ON c.id = p.chapter_id
            WHERE paragraph_fts MATCH ? AND c.status = 'normal'
            ${ORDER} LIMIT ?`,
          [phrase(query), limit + 1],
        )
      : await queryAll(
          port,
          Row,
          `SELECT p.id, p.chapter_id, c.title, p.text
             FROM paragraph p JOIN chapter c ON c.id = p.chapter_id
            WHERE c.status = 'normal' AND instr(lower(p.text), lower(?)) > 0
            ${ORDER} LIMIT ?`,
          [query, limit + 1],
        );
  if (!rows.ok) return rows;

  // 段内位置在这里计算：与 trigram 一样不区分大小写。
  const pattern = new RegExp(escapeRegExp(query), 'giu');
  const hits: SearchHit[] = [];
  let truncated = false;
  for (const r of rows.value) {
    for (const m of r.text.matchAll(pattern)) {
      if (hits.length === limit) {
        truncated = true;
        break;
      }
      const start = m.index;
      const end = start + m[0].length;
      hits.push({
        chapterId: r.chapter_id,
        chapterTitle: r.title,
        paragraphId: r.id,
        start,
        end,
        before: r.text.slice(Math.max(0, start - CONTEXT), start),
        match: m[0],
        after: r.text.slice(end, end + CONTEXT),
      });
    }
    if (truncated) break;
  }
  return ok({ query, hits, truncated, mode });
}

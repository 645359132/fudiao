import { err, keysBetween, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, Statement } from '../sql';
import { queryOne, type RepoError, type WriteContext } from './common';

export type ImportChapter = { readonly title: string; readonly paragraphs: readonly string[] };

const LastKey = z.object({ order_key: z.string() });

/**
 * 导入的章节追加到目录末尾（需求 B07），在一个事务中写入章节与段落；任一失败整体回滚。
 * 标识由调用方的标识端口生成；排序键批量生成，避免逐个追加时键长增长。
 */
export async function importChapters(
  port: SqlPort,
  chapters: readonly ImportChapter[],
  ctx: WriteContext,
  newId: () => string,
): Promise<Result<{ readonly chapterIds: string[]; readonly paragraphs: number }, RepoError>> {
  if (chapters.some((c) => c.title.trim() === '')) return err({ code: 'invalid', detail: '章节名不能为空' });
  const last = await queryOne(port, LastKey, "SELECT order_key FROM chapter WHERE status = 'normal' ORDER BY order_key DESC LIMIT 1");
  if (!last.ok) return last;
  const chapterKeys = keysBetween(last.value?.order_key ?? null, null, chapters.length);
  const statements: Statement[] = [];
  const chapterIds: string[] = [];
  let paragraphs = 0;
  chapters.forEach((chapter, i) => {
    const id = newId();
    chapterIds.push(id);
    statements.push({
      sql: 'INSERT INTO chapter (id, order_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      params: [id, chapterKeys[i] ?? '', chapter.title.trim(), ctx.now, ctx.now],
    });
    const keys = keysBetween(null, null, chapter.paragraphs.length);
    chapter.paragraphs.forEach((text, j) => {
      statements.push({
        sql: 'INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        params: [newId(), id, keys[j] ?? '', text, ctx.now, ctx.now],
      });
    });
    paragraphs += chapter.paragraphs.length;
  });
  if (statements.length === 0) return ok({ chapterIds, paragraphs });
  const done = await port.transaction(statements);
  return done.ok ? ok({ chapterIds, paragraphs }) : err({ code: 'sql', error: done.error });
}

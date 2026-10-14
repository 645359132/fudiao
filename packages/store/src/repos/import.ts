import { err, keyBetween, keysBetween, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, Statement } from '../sql';
import { queryAll, queryOne, type RepoError, type WriteContext } from './common';

/** 导入的一章；volume 为所在卷的卷名（文本里识别出的“第一卷 ……”），没有时追加到全书末尾。 */
export type ImportChapter = { readonly title: string; readonly paragraphs: readonly string[]; readonly volume?: string };

const LastKey = z.object({ order_key: z.string() });

/**
 * 导入的章节追加到目录末尾（需求 B07），在一个事务中写入章节与段落；任一失败整体回滚。
 * 标识由调用方的标识端口生成；排序键批量生成，避免逐个追加时键长增长。
 * 带卷名的章节（B68）：作品里已有同名的卷时接在那一卷末尾，没有时在最后新建这一卷；不带卷名的接在全书末尾。
 */
export async function importChapters(
  port: SqlPort,
  chapters: readonly ImportChapter[],
  ctx: WriteContext,
  newId: () => string,
): Promise<Result<{ readonly chapterIds: string[]; readonly paragraphs: number }, RepoError>> {
  if (chapters.some((c) => c.title.trim() === '')) return err({ code: 'invalid', detail: '章节名不能为空' });
  const volumes = await queryAll(port, z.object({ id: z.string(), title: z.string(), order_key: z.string() }), 'SELECT id, title, order_key FROM volume ORDER BY order_key, id');
  if (!volumes.ok) return volumes;
  const statements: Statement[] = [];
  // 每一章的卷：沿用同名的卷，没有的在最后新建；不带卷名的接在全书末尾（最后一卷，或未分卷）。
  const byTitle = new Map(volumes.value.map((v) => [v.title.trim(), v.id]));
  let lastVolumeKey = volumes.value.at(-1)?.order_key ?? null;
  const tail = volumes.value.at(-1)?.id ?? null;
  const volumeOf = chapters.map((c) => {
    const name = c.volume?.trim() ?? '';
    if (name === '') return tail;
    const known = byTitle.get(name);
    if (known !== undefined) return known;
    const id = newId();
    lastVolumeKey = keyBetween(lastVolumeKey, null);
    statements.push({ sql: 'INSERT INTO volume (id, order_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', params: [id, lastVolumeKey, name, ctx.now, ctx.now] });
    byTitle.set(name, id);
    return id;
  });
  // 每一卷各自接在卷末：同一卷的章节批量生成排序键。
  const keyOf = new Map<number, string>();
  for (const volumeId of new Set(volumeOf)) {
    const last = await queryOne(port, LastKey, "SELECT order_key FROM chapter WHERE status = 'normal' AND volume_id IS ? ORDER BY order_key DESC LIMIT 1", [volumeId]);
    if (!last.ok) return last;
    const members = volumeOf.flatMap((v, i) => (v === volumeId ? [i] : []));
    const keys = keysBetween(last.value?.order_key ?? null, null, members.length);
    members.forEach((i, j) => keyOf.set(i, keys[j] ?? ''));
  }
  const chapterIds: string[] = [];
  let paragraphs = 0;
  chapters.forEach((chapter, i) => {
    const id = newId();
    chapterIds.push(id);
    statements.push({
      sql: 'INSERT INTO chapter (id, order_key, title, volume_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      params: [id, keyOf.get(i) ?? '', chapter.title.trim(), volumeOf[i] ?? null, ctx.now, ctx.now],
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

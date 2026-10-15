// 作品封面（需求 B76）：每部作品一张，图片以 data URL 存放（作品库的列只有文字与数字）。
// 读封面时分开读：作品列表只要缩略图，不必把整张封面读出来。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { queryOne, type RepoError, type WriteContext } from './common';

/** 封面图片的上限（data URL 的字符数），与迁移 0015 的约束一致。 */
export const MAX_COVER_CHARS = 3_000_000;
export const MAX_THUMBNAIL_CHARS = 200_000;

const DATA_URL = /^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/]+=*$/;

const CoverRow = z
  .object({
    project_id: z.string(),
    image: z.string(),
    width: z.number().int(),
    height: z.number().int(),
    version: z.number().int(),
    updated_at: z.string(),
  })
  .transform((r) => ({ projectId: r.project_id, image: r.image, width: r.width, height: r.height, version: r.version, updatedAt: r.updated_at }));
export type Cover = z.output<typeof CoverRow>;

export type CoverImage = { readonly image: string; readonly thumbnail: string; readonly width: number; readonly height: number };

export function getCover(port: SqlPort): Promise<Result<Cover | null, RepoError>> {
  return queryOne(port, CoverRow, 'SELECT project_id, image, width, height, version, updated_at FROM cover LIMIT 1');
}

/** 作品列表用的缩略图；没有封面时为 null。 */
export async function getCoverThumbnail(port: SqlPort): Promise<Result<string | null, RepoError>> {
  const row = await queryOne(port, z.object({ thumbnail: z.string() }), 'SELECT thumbnail FROM cover LIMIT 1');
  return row.ok ? ok(row.value?.thumbnail ?? null) : row;
}

/** 设定或更换封面：图片须是 base64 的 data URL，尺寸为正，不超过上限。 */
export async function saveCover(port: SqlPort, projectId: string, cover: CoverImage, ctx: WriteContext): Promise<Result<Cover, RepoError>> {
  if (!DATA_URL.test(cover.image) || !DATA_URL.test(cover.thumbnail)) return err({ code: 'invalid', detail: '封面须是图片' });
  if (cover.image.length > MAX_COVER_CHARS || cover.thumbnail.length > MAX_THUMBNAIL_CHARS) return err({ code: 'invalid', detail: '封面图片太大' });
  if (!Number.isInteger(cover.width) || !Number.isInteger(cover.height) || cover.width <= 0 || cover.height <= 0) return err({ code: 'invalid', detail: '封面的尺寸无效' });
  const result = await port.transaction([
    {
      sql: `INSERT INTO cover (project_id, image, thumbnail, width, height, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (project_id) DO UPDATE SET image = excluded.image, thumbnail = excluded.thumbnail, width = excluded.width,
              height = excluded.height, version = cover.version + 1, updated_at = excluded.updated_at`,
      params: [projectId, cover.image, cover.thumbnail, cover.width, cover.height, ctx.now, ctx.now],
    },
  ]);
  if (!result.ok) return err({ code: 'sql', error: result.error });
  const saved = await getCover(port);
  if (!saved.ok) return saved;
  return saved.value === null ? err({ code: 'not_found' }) : ok(saved.value);
}

/** 去掉封面，回到按书名排出的文字封面。 */
export async function removeCover(port: SqlPort): Promise<Result<void, RepoError>> {
  const result = await port.transaction([{ sql: 'DELETE FROM cover', params: [] }]);
  return result.ok ? ok(undefined) : err({ code: 'sql', error: result.error });
}

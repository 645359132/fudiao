// 故事层（需求 B55、I07）的读取：故事事件与它们关联的正文段落。写入在采纳推演草案时进行（adoption.ts）。
import type { Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { jsonColumn, queryAll, type RepoError } from './common';

const EventRow = z
  .object({
    id: z.string(),
    summary: z.string(),
    participants: jsonColumn(z.array(z.string())),
    location_id: z.string().nullable(),
    perceptions: jsonColumn(z.array(z.object({ entity: z.string(), channel: z.string() }))),
    origin_run_id: z.string().nullable(),
    origin_seq: z.number().int().nullable(),
    created_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    summary: r.summary,
    participants: r.participants,
    locationId: r.location_id,
    perceptions: r.perceptions,
    originRunId: r.origin_run_id,
    originSeq: r.origin_seq,
    createdAt: r.created_at,
  }));
export type StoryEvent = z.output<typeof EventRow>;

/** 全部故事事件，按建立的先后。 */
export function listStoryEvents(port: SqlPort): Promise<Result<StoryEvent[], RepoError>> {
  return queryAll(
    port,
    EventRow,
    'SELECT id, summary, participants, location_id, perceptions, origin_run_id, origin_seq, created_at FROM story_event ORDER BY created_at, origin_seq, id',
  );
}

const LinkRow = z.object({ event_id: z.string(), paragraph_id: z.string(), mode: z.string() }).transform((r) => ({ eventId: r.event_id, paragraphId: r.paragraph_id, mode: r.mode }));
export type EventLink = z.output<typeof LinkRow>;

/** 一章正文段落与故事事件的关联。 */
export function listChapterEventLinks(port: SqlPort, chapterId: string): Promise<Result<EventLink[], RepoError>> {
  return queryAll(
    port,
    LinkRow,
    `SELECT l.event_id, l.paragraph_id, l.mode FROM event_paragraph_link l JOIN paragraph p ON p.id = l.paragraph_id
     WHERE p.chapter_id = ? ORDER BY p.order_key, l.event_id`,
    [chapterId],
  );
}

import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, SqlValue } from '../sql';
import { guardedUpdate, insertReturning, jsonColumn, queryOne, type RepoError, type WriteContext } from './common';

/** 写作目标（B01）。 */
export const WorkGoals = z.object({
  totalWords: z.number().int().positive().nullable(),
  note: z.string(),
});
export type WorkGoals = z.infer<typeof WorkGoals>;

export const DEFAULT_GOALS: WorkGoals = { totalWords: null, note: '' };

const goalsColumn = z.string().transform((text, ctx): WorkGoals => {
  try {
    const parsed = WorkGoals.partial().safeParse(JSON.parse(text));
    if (parsed.success) return { ...DEFAULT_GOALS, ...parsed.data };
  } catch {
    // 落到下面的错误
  }
  ctx.addIssue({ code: 'custom', message: '写作目标格式无效' });
  return z.NEVER;
});

const ProjectRow = z
  .object({
    id: z.string(),
    title: z.string(),
    genre: z.string(),
    synopsis: z.string(),
    outline: z.string(),
    goals: goalsColumn,
    avoid_phrases: jsonColumn(z.array(z.string())).nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    title: r.title,
    genre: r.genre,
    synopsis: r.synopsis,
    outline: r.outline,
    goals: r.goals,
    /** 规避表达词表（B37）；null 表示使用默认词表。 */
    avoidPhrases: r.avoid_phrases,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type Project = z.output<typeof ProjectRow>;

export type ProjectPatch = Partial<Pick<Project, 'title' | 'genre' | 'synopsis' | 'outline' | 'goals' | 'avoidPhrases'>>;

const COLUMNS = 'id, title, genre, synopsis, outline, goals, avoid_phrases, version, created_at, updated_at';

export function getProject(port: SqlPort): Promise<Result<Project | null, RepoError>> {
  return queryOne(port, ProjectRow, `SELECT ${COLUMNS} FROM project`);
}

export function createProject(port: SqlPort, input: { readonly id: string; readonly title: string }, ctx: WriteContext): Promise<Result<Project, RepoError>> {
  return insertReturning(port, ProjectRow, {
    sql: `INSERT INTO project (id, title, goals, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [input.id, input.title, JSON.stringify(DEFAULT_GOALS), ctx.now, ctx.now],
  });
}

export async function updateProject(
  port: SqlPort,
  id: string,
  expectedVersion: number,
  patch: ProjectPatch,
  ctx: WriteContext,
): Promise<Result<Project, RepoError>> {
  if (patch.title !== undefined && patch.title.trim() === '') return err({ code: 'invalid', detail: '作品名不能为空' });
  if (patch.goals !== undefined && !WorkGoals.safeParse(patch.goals).success) return err({ code: 'invalid', detail: '写作目标格式无效' });
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const key of ['title', 'genre', 'synopsis', 'outline'] as const) {
    const value = patch[key];
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      params.push(key === 'title' ? value.trim() : value);
    }
  }
  if (patch.goals !== undefined) {
    sets.push('goals = ?');
    params.push(JSON.stringify(patch.goals));
  }
  if (patch.avoidPhrases !== undefined) {
    sets.push('avoid_phrases = ?');
    params.push(patch.avoidPhrases === null ? null : JSON.stringify(patch.avoidPhrases.map((p) => p.trim()).filter((p) => p !== '')));
  }
  if (sets.length === 0) {
    const current = await getProject(port);
    if (!current.ok) return current;
    return current.value === null ? err({ code: 'not_found' }) : ok(current.value);
  }
  return guardedUpdate(port, ProjectRow, 'project', id, {
    sql: `UPDATE project SET ${sets.join(', ')}, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [...params, ctx.now, id, expectedVersion],
  });
}

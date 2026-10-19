// 人物小传与关系网补全（需求 B83，施工文档 M6-06）：从各章的长篇记忆找出要补的人物与关系，生成小传与关系的草稿；
// 作者逐项勾选、修改后采用。只增不改：锁定的设定不动，已有的说明不覆盖、只在后面补充，同样的关系不重复建。
import type { CallOptions } from '@fudiao/llm';
import { CastCompletionOutput, renderCastCompletion } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  createEntity,
  createRelationship,
  getProject,
  listChapterMemories,
  listChapters,
  listChaptersWithText,
  listEntities,
  listRelationships,
  updateEntity,
  RELATION_CATEGORIES,
  type RepoError,
  type SqlPort,
} from '@fudiao/store';
import { castGaps, type CastGap } from '@fudiao/writing';
import { z } from 'zod';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';

/** 带给模型的各章梗概最多多少字：超出时保留开头几章与最近的章节。 */
const CAST_SUMMARY_CHARS = 30_000;
const CAST_OUTPUT_TOKENS = 6_000 + THINKING_ALLOWANCE;

/** 草稿里的一个人物：entityId 为已有的人物卡片（新人物为 null）；selected 为作者勾选要采用的。 */
export const CastCharacterDraft = z.object({
  name: z.string(),
  entityId: z.string().nullable(),
  identity: z.string(),
  look: z.string(),
  personality: z.string(),
  motive: z.string(),
  voice: z.string(),
  firstChapterId: z.string().nullable(),
  basis: z.array(z.string()),
  selected: z.boolean(),
});
export const CastRelationDraft = z.object({
  from: z.string(),
  to: z.string(),
  category: z.enum(RELATION_CATEGORIES),
  label: z.string(),
  mutual: z.boolean(),
  description: z.string(),
  secret: z.boolean(),
  fromChapterId: z.string().nullable(),
  basis: z.array(z.string()),
  selected: z.boolean(),
});
export const CastDraft = z.object({ characters: z.array(CastCharacterDraft), relationships: z.array(CastRelationDraft), dropped: z.number().int() });
export type CastDraft = z.infer<typeof CastDraft>;

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

/** 小传读成一段说明（正文没有交代的项略去）。 */
export function bioText(c: Pick<z.infer<typeof CastCharacterDraft>, 'identity' | 'look' | 'personality' | 'motive' | 'voice'>, firstChapter: string | null): string {
  const unknown = (x: string) => x.trim() === '' || x.includes('正文未交代');
  const parts = [
    ['身份', c.identity],
    ['外貌', c.look],
    ['性格', c.personality],
    ['动机与目标', c.motive],
    ['说话方式', c.voice],
  ].flatMap(([label, value]) => (unknown(value ?? '') ? [] : [`${label}：${(value ?? '').trim()}`]));
  if (firstChapter !== null) parts.push(`首次出场：《${firstChapter}》`);
  return parts.join('；');
}

export function castCompletionUseCases(deps: AppDeps, project: () => SqlPort | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });

  async function material(port: SqlPort) {
    const [chapters, withText, memories, entities, relations] = await Promise.all([
      listChapters(port, 'normal'),
      listChaptersWithText(port),
      listChapterMemories(port),
      listEntities(port),
      listRelationships(port),
    ]);
    if (!chapters.ok) return err(repo(chapters.error));
    if (!withText.ok) return err(repo(withText.error));
    if (!memories.ok) return err(repo(memories.error));
    if (!entities.ok) return err(repo(entities.error));
    if (!relations.ok) return err(repo(relations.error));
    return ok({ chapters: chapters.value, withText: new Set(withText.value), memories: memories.value, entities: entities.value, relations: relations.value });
  }

  return {
    /** 人物卡片的缺口：说明为空、出场过却没有任何关系（按长篇记忆）。 */
    async castSurvey(): Promise<Result<readonly CastGap[], AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const m = await material(port);
      if (!m.ok) return m;
      const { chapters, memories, entities, relations } = m.value;
      return ok(
        castGaps({
          characters: entities.filter((e) => e.kind === 'character'),
          relations,
          appearances: new Map(memories.map((x) => [x.chapterId, Object.keys(x.castState)])),
          order: new Map(chapters.map((c, i) => [c.id, i])),
        }),
      );
    },

    /** 生成人物小传与关系的草稿（不写入作品）。章节标签、人物名字对不上的丢弃，丢弃的条数一并返回。 */
    async draftCastCompletion(gaps: readonly CastGap[], stepKey: string, options: CallOptions = {}): Promise<Result<CastDraft, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const work = await getProject(port);
      if (!work.ok) return err(repo(work.error));
      const m = await material(port);
      if (!m.ok) return m;
      const { chapters, withText, memories, entities, relations } = m.value;
      const memoryOf = new Map(memories.map((x) => [x.chapterId, x]));
      const characters = entities.filter((e) => e.kind === 'character');
      const nameOf = new Map(entities.map((e) => [e.id, e.name]));
      const written = chapters.filter((c) => withText.has(c.id));
      if (written.length === 0) return err(settings('还没有写好的章节：人物补全要从正文的长篇记忆里找'));
      // 梗概超出字数时保留开头几章与最近的章节（人物多在开头出场，最近的章节变化最多）。
      let rows = written.map((c, i) => ({ chapter: c, label: `C${i + 1}`, summary: (memoryOf.get(c.id)?.summary ?? c.summary).trim(), cast: Object.keys(memoryOf.get(c.id)?.castState ?? {}).flatMap((id) => nameOf.get(id) ?? []) }));
      const size = (r: typeof rows) => r.reduce((n, x) => n + x.summary.length + 20, 0);
      while (rows.length > 6 && size(rows) > CAST_SUMMARY_CHARS) rows = [...rows.slice(0, 3), ...rows.slice(4)];
      const gapOf = new Map(gaps.map((g) => [g.id, [g.noDescription ? '说明为空' : '', g.noRelation ? '没有任何关系' : ''].filter((x) => x !== '').join('、')]));
      const prompt = renderCastCompletion({
        title: work.value?.title ?? '',
        genre: work.value?.genre ?? '',
        characters: characters.map((c) => ({ name: c.name, aliases: c.aliases, description: c.description, gap: gapOf.get(c.id) ?? '' })),
        relations: relations.map((r) => (r.mutual ? `${nameOf.get(r.fromId) ?? ''}与${nameOf.get(r.toId) ?? ''}：${r.label}` : `${nameOf.get(r.fromId) ?? ''}是${nameOf.get(r.toId) ?? ''}的${r.label}`)),
        chapters: rows.map((r) => ({ label: r.label, title: r.chapter.title, summary: r.summary, cast: r.cast })),
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: CAST_OUTPUT_TOKENS, effort: 'medium', stepKey }, CastCompletionOutput, options);
      if (!result.ok) return result;
      const chapterOf = new Map(rows.map((r) => [r.label, r.chapter.id]));
      const label = (l: string) => chapterOf.get(l.trim().toUpperCase()) ?? null;
      const known = new Map(characters.flatMap((c) => [c.name, ...c.aliases].map((n) => [n.trim(), c] as const)));
      let dropped = 0;
      const drafted: z.infer<typeof CastCharacterDraft>[] = [];
      for (const c of result.value.value.characters) {
        const name = c.name.trim();
        const basis = c.basis.flatMap((b) => label(b) ?? []);
        const entity = known.get(name);
        if (name === '' || basis.length === 0 || drafted.some((d) => d.name === name) || entity?.locked === true) {
          dropped += 1;
          continue;
        }
        drafted.push({ name: entity?.name ?? name, entityId: entity?.id ?? null, identity: c.identity, look: c.look, personality: c.personality, motive: c.motive, voice: c.voice, firstChapterId: label(c.firstChapter), basis, selected: true });
      }
      const people = new Set([...known.keys(), ...drafted.map((d) => d.name)]);
      const existing = new Set(relations.map((r) => `${nameOf.get(r.fromId) ?? ''}|${nameOf.get(r.toId) ?? ''}|${r.label}`));
      const links: z.infer<typeof CastRelationDraft>[] = [];
      for (const r of result.value.value.relationships) {
        const from = known.get(r.from.trim())?.name ?? r.from.trim();
        const to = known.get(r.to.trim())?.name ?? r.to.trim();
        const basis = r.basis.flatMap((b) => label(b) ?? []);
        const key = `${from}|${to}|${r.label.trim()}`;
        if (!people.has(from) || !people.has(to) || from === to || r.label.trim() === '' || basis.length === 0 || existing.has(key) || links.some((l) => `${l.from}|${l.to}|${l.label}` === key)) {
          dropped += 1;
          continue;
        }
        links.push({ from, to, category: r.category, label: r.label.trim(), mutual: r.mutual, description: r.description.trim(), secret: r.secret, fromChapterId: label(r.fromChapter), basis, selected: true });
      }
      return ok({ characters: drafted, relationships: links, dropped });
    },

    /**
     * 采用勾选的人物与关系：新人物建卡片并写上小传；已有的人物说明为空时写上，不为空时在后面补充一段；锁定的不动。
     * 关系按名字建立，同样的不重复建。返回建了、补了几项。
     */
    async applyCastCompletion(draft: CastDraft): Promise<Result<{ readonly created: number; readonly updated: number; readonly relations: number; readonly skipped: readonly string[] }, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const m = await material(port);
      if (!m.ok) return m;
      const titleOf = new Map(m.value.chapters.map((c) => [c.id, c.title]));
      const byName = new Map(m.value.entities.filter((e) => e.kind === 'character').flatMap((e) => [e.name, ...e.aliases].map((n) => [n.trim(), e] as const)));
      let created = 0;
      let updated = 0;
      const skipped: string[] = [];
      for (const c of draft.characters.filter((x) => x.selected)) {
        const bio = bioText(c, c.firstChapterId === null ? null : (titleOf.get(c.firstChapterId) ?? null));
        const entity = byName.get(c.name.trim());
        if (entity === undefined) {
          const made = await createEntity(port, { id: deps.ids.next(), kind: 'character', name: c.name.trim() }, ctx());
          if (!made.ok) return err(repo(made.error));
          const described = bio === '' ? ok(made.value) : await updateEntity(port, made.value.id, made.value.version, { description: bio }, ctx());
          if (!described.ok) return err(repo(described.error));
          byName.set(c.name.trim(), described.value);
          created += 1;
          continue;
        }
        if (entity.locked) {
          skipped.push(`${entity.name}是锁定设定，没有改`);
          continue;
        }
        if (bio === '' || entity.description.includes(bio)) continue;
        const description = entity.description.trim() === '' ? bio : `${entity.description.trim()}\n补充（人物补全）：${bio}`;
        const changed = await updateEntity(port, entity.id, entity.version, { description }, ctx());
        if (!changed.ok) return err(repo(changed.error));
        byName.set(c.name.trim(), changed.value);
        updated += 1;
      }
      const existing = await listRelationships(port);
      if (!existing.ok) return err(repo(existing.error));
      const seen = new Set(existing.value.map((r) => `${r.fromId}|${r.toId}|${r.label}`));
      let made = 0;
      for (const r of draft.relationships.filter((x) => x.selected)) {
        const from = byName.get(r.from.trim());
        const to = byName.get(r.to.trim());
        if (from === undefined || to === undefined) {
          skipped.push(`${r.from}与${r.to}的关系：有一方没有人物卡片（没有勾选这个人物）`);
          continue;
        }
        const key = `${from.id}|${to.id}|${r.label}`;
        if (from.id === to.id || seen.has(key)) continue;
        seen.add(key);
        const rel = await createRelationship(
          port,
          { id: deps.ids.next(), fromId: from.id, toId: to.id, category: r.category, label: r.label, mutual: r.mutual, description: r.description, secret: r.secret, validFromChapterId: r.fromChapterId, validToChapterId: null },
          ctx(),
        );
        if (!rel.ok) return err(repo(rel.error));
        made += 1;
      }
      return ok({ created, updated, relations: made, skipped });
    },
  };
}

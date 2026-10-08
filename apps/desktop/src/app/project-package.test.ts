import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChapter, createProject, exportData, importData, saveChapterParagraphs, TABLES, trashChapter, type ExportedData } from '@fudiao/store';
import { loadMigrations, openProjectDb, type ProjectDb } from '@fudiao/store/node';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPackage, parsePackage, withProjectId } from './project-package';

const ctx = { now: '2026-10-08T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-package-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fresh(): ProjectDb {
  const r = openProjectDb(join(root, `p${opened.length}`), { migrations: loadMigrations(), now: ctx.now });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  opened.push(r.value.db);
  return r.value.db;
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** 一部覆盖各张表的样本作品。 */
async function sample(): Promise<ProjectDb> {
  const db = fresh();
  value(await createProject(db, { id: 'P1', title: '雨夜/归来' }, ctx));
  value(await createChapter(db, { id: 'c1', title: '第一章 雨夜' }, ctx));
  value(await createChapter(db, { id: 'c2', title: '第二章：当铺?' }, ctx));
  value(await createChapter(db, { id: 'c3', title: '废稿' }, ctx));
  value(await trashChapter(db, 'c3', 1, ctx));
  value(await saveChapterParagraphs(db, 'c1', [], [{ id: 'a', text: '雨下得更紧了。', source: 'handwritten' }, { id: 'b', text: '他没有回头。', source: 'ai_modified' }], { splits: [], merges: [] }, ctx));
  value(
    await db.transaction([
      { sql: "INSERT INTO chapter_snapshot VALUES ('s1', 'c1', 'manual', '第一章 雨夜', '[]', ?)", params: [ctx.now] },
      { sql: "INSERT INTO entity (id, kind, name, aliases, created_at, updated_at) VALUES ('e1', 'character', '沈砚', '[\"沈先生\"]', ?, ?)", params: [ctx.now, ctx.now] },
      { sql: "INSERT INTO fact (id, kind, content, status, created_at, updated_at) VALUES ('f1', 'world', '沈砚欠下赌债', 'confirmed', ?, ?)", params: [ctx.now, ctx.now] },
      { sql: "INSERT INTO fact (id, kind, holder_id, content, modality, created_at, updated_at) VALUES ('f2', 'belief', 'e1', '掌柜认得那块玉', 'inferred', ?, ?)", params: [ctx.now, ctx.now] },
      { sql: "INSERT INTO source_ref (id, from_type, from_id, to_type, to_id, created_at) VALUES ('r1', 'fact', 'f1', 'paragraph', 'a', ?)", params: [ctx.now] },
      { sql: "INSERT INTO story_event (id, summary, origin_run_id, origin_seq, created_at, updated_at) VALUES ('v1', '对峙', 'RUN', 7, ?, ?)", params: [ctx.now, ctx.now] },
      { sql: "INSERT INTO event_paragraph_link VALUES ('v1', 'a', 'direct', ?)", params: [ctx.now] },
    ]),
  );
  return db;
}

describe('作品包', () => {
  it('包含 manifest、每个正常章节一个 Markdown、每张表一个 JSONL', async () => {
    const files = value(await buildPackage(await sample(), ctx.now));
    const paths = files.map((f) => f.path);
    expect(paths[0]).toBe('manifest.json');
    expect(paths.filter((p) => p.startsWith('chapters/'))).toEqual(['chapters/0001-第一章 雨夜.md', 'chapters/0002-第二章：当铺.md']);
    expect(paths.filter((p) => p.startsWith('data/'))).toEqual(TABLES.map((t) => `data/${t.name}.jsonl`));
    expect(files.find((f) => f.path === 'chapters/0001-第一章 雨夜.md')?.content).toBe('# 第一章 雨夜\n\n雨下得更紧了。\n\n他没有回头。\n\n');
    expect(JSON.parse(files[0]?.content ?? '')).toMatchObject({ format: 'fudiao-project', formatVersion: 1, schemaVersion: loadMigrations().at(-1)?.version, title: '雨夜/归来', chapters: 2 });
  });

  it('导出再导入为新作品：正文、章节顺序、回收站、快照、设定、事实、来源关系、故事事件与关联逐表一致（数据迁移验收）', async () => {
    const source = await sample();
    const parsed = value(parsePackage(value(await buildPackage(source, ctx.now))));
    const target = fresh();
    value(await importData(target, parsed.data));
    expect(value(await exportData(target))).toEqual(value(await exportData(source)));
  });

  it('换新作品标识后仍能导入，其余数据不变', async () => {
    const source = await sample();
    const parsed = value(parsePackage(value(await buildPackage(source, ctx.now))));
    const target = fresh();
    value(await importData(target, withProjectId(parsed.data, 'P2')));
    const before = value(await exportData(source));
    const after: ExportedData = value(await exportData(target));
    expect(after.tables['project']?.[0]?.['id']).toBe('P2');
    expect({ ...after.tables, project: [] }).toEqual({ ...before.tables, project: [] });
  });

  it('拒绝不是复调作品包的文件、更新的格式版本与坏行', () => {
    expect(parsePackage([])).toEqual({ ok: false, error: '作品包缺少 manifest.json' });
    expect(parsePackage([{ path: 'manifest.json', content: '{"format":"other"}' }])).toEqual({ ok: false, error: '这不是复调的作品包' });
    const manifest = { format: 'fudiao-project', formatVersion: 1, schemaVersion: 1, exportedAt: ctx.now, title: '雨夜', chapters: 0 };
    expect(parsePackage([{ path: 'manifest.json', content: JSON.stringify({ ...manifest, formatVersion: 2 }) }]).ok).toBe(false);
    expect(parsePackage([{ path: 'manifest.json', content: JSON.stringify(manifest) }, { path: 'data/project.jsonl', content: '{坏\n' }])).toEqual({
      ok: false,
      error: 'data/project.jsonl 第 1 行无效',
    });
    expect(parsePackage([{ path: 'manifest.json', content: JSON.stringify(manifest) }])).toEqual({ ok: false, error: '作品包中没有作品信息' });
  });
});

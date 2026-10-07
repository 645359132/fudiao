import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportData, fromJsonl, importData, toJsonl, type ExportedData } from './data-export';
import { loadMigrations, openProjectDb, type ProjectDb } from './node/sqlite';
import { TABLES } from './schema';
import type { Statement } from './sql';

const NOW = '2026-10-07T00:00:00.000Z';
const root = mkdtempSync(join(tmpdir(), 'novel-writer-schema-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function fresh(): ProjectDb {
  const result = openProjectDb(join(root, `p${n++}`), { migrations: loadMigrations(), now: NOW });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  opened.push(result.value.db);
  return result.value.db;
}

const s = (sql: string, ...params: (string | number | null)[]): Statement => ({ sql, params });
const T = [NOW, NOW] as const;

/** 覆盖每张表与各种取值的样本作品。 */
const sample: Statement[] = [
  s("INSERT INTO project (id, title, genre, goals, created_at, updated_at) VALUES ('01P', '雨夜', '武侠', '{\"words\":300000}', ?, ?)", ...T),
  s("INSERT INTO chapter (id, order_key, title, summary, created_at, updated_at) VALUES ('01C1', 'a0', '第一章 雨夜', '两人在当铺重逢', ?, ?)", ...T),
  s("INSERT INTO chapter (id, order_key, title, status, trashed_at, created_at, updated_at) VALUES ('01C2', 'a1', '废稿', 'trashed', ?, ?, ?)", NOW, ...T),
  s("INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES ('01G1', '01C1', 'a0', '雨下得更紧了。', ?, ?)", ...T),
  s(
    "INSERT INTO paragraph (id, chapter_id, order_key, text, source_kind, source_spans, ai_origin_text, split_from, version, created_at, updated_at) VALUES ('01G2', '01C1', 'a1', '他没有回头。', 'ai_modified', '[{\"start\":0,\"end\":6,\"kind\":\"ai_generated\"}]', '他始终没有回头。', '01G1', 3, ?, ?)",
    ...T,
  ),
  s("INSERT INTO chapter_snapshot (id, chapter_id, reason, title, paragraphs, created_at) VALUES ('01S1', '01C1', 'manual', '第一章 雨夜', '[{\"id\":\"01G1\",\"text\":\"雨下得更紧了。\"}]', ?)", NOW),
  s("INSERT INTO entity (id, kind, name, aliases, data, locked, created_at, updated_at) VALUES ('01E1', 'character', '沈砚', '[\"沈先生\"]', '{\"age\":28}', 1, ?, ?)", ...T),
  s("INSERT INTO entity (id, kind, name, created_at, updated_at) VALUES ('01E2', 'location', '当铺', ?, ?)", ...T),
  s("INSERT INTO fact (id, kind, subject_ids, content, status, created_at, updated_at) VALUES ('01F1', 'world', '[\"01E1\"]', '沈砚欠下赌债', 'confirmed', ?, ?)", ...T),
  s(
    "INSERT INTO fact (id, kind, holder_id, content, modality, confidence, valid_from_chapter_id, valid_from_label, valid_from_order, valid_to_label, status, review_reason, created_at, updated_at) VALUES ('01F2', 'belief', '01E1', '掌柜认得那块玉', 'inferred', 0.6, '01C1', '第三年春', 3.5, '入冬以前', 'needs_review', '设定条目“当铺”已修改', ?, ?)",
    ...T,
  ),
  s("INSERT INTO fact (id, kind, holder_id, content, modality, created_at, updated_at) VALUES ('01F3', 'claim', '01E1', '我从没来过这里', 'claimed', ?, ?)", ...T),
  s("INSERT INTO source_ref (id, from_type, from_id, to_type, to_id, to_version, anchor, created_at) VALUES ('01R1', 'fact', '01F1', 'paragraph', '01G1', 1, '{\"paragraphId\":\"01G1\",\"paragraphVersion\":1,\"start\":0,\"end\":4,\"quote\":\"雨下得更\"}', ?)", NOW),
  s("INSERT INTO source_ref (id, from_type, from_id, to_type, to_id, created_at) VALUES ('01R2', 'fact', '01F2', 'entity', '01E2', ?)", NOW),
  s(
    "INSERT INTO story_event (id, story_time_label, story_time_order, summary, participants, location_id, perceptions, origin_run_id, origin_seq, created_at, updated_at) VALUES ('01V1', '雨夜二更', 3.5, '两人对峙', '[\"01E1\"]', '01E2', '[{\"actor\":\"01E1\",\"channel\":\"sight\"}]', '01RUN', 42, ?, ?)",
    ...T,
  ),
  s("INSERT INTO story_event (id, summary, created_at, updated_at) VALUES ('01V2', '多年前的旧事', ?, ?)", ...T),
  s("INSERT INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) VALUES ('01V1', '01G1', 'direct', ?)", NOW),
  s("INSERT INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) VALUES ('01V1', '01G2', 'implied', ?)", NOW),
  s("INSERT INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) VALUES ('01V2', '01G1', 'flashback', ?)", NOW),
  s("INSERT INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) VALUES ('01V2', '01G2', 'retold', ?)", NOW),
];

async function seeded(): Promise<ProjectDb> {
  const db = fresh();
  const result = await db.transaction(sample);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return db;
}

async function rejects(db: ProjectDb, sql: string, ...params: (string | number | null)[]) {
  const result = await db.transaction([s(sql, ...params)]);
  expect(result.ok, sql).toBe(false);
  return result.ok ? null : result.error;
}

describe('第一版迁移的约束', () => {
  it('样本作品满足全部约束', async () => {
    await seeded();
  });

  it('每个作品库只有一部作品', async () => {
    const db = await seeded();
    expect(await rejects(db, "INSERT INTO project (id, title, created_at, updated_at) VALUES ('01P2', '另一部', ?, ?)", ...T)).toMatchObject({ code: 'constraint' });
  });

  it('枚举、JSON 与类型约束', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO chapter (id, order_key, title, status, created_at, updated_at) VALUES ('x', 'b', 't', 'deleted', ?, ?)", ...T);
    await rejects(db, "INSERT INTO entity (id, kind, name, aliases, created_at, updated_at) VALUES ('x', 'character', 'n', '沈先生', ?, ?)", ...T);
    await rejects(db, "INSERT INTO entity (id, kind, name, aliases, created_at, updated_at) VALUES ('x', 'character', 'n', '{}', ?, ?)", ...T);
    // STRICT 表拒绝类型不符的值。
    await rejects(db, "INSERT INTO entity (id, kind, name, locked, created_at, updated_at) VALUES ('x', 'character', 'n', 'yes', ?, ?)", ...T);
    await rejects(db, "INSERT INTO fact (id, kind, content, confidence, created_at, updated_at) VALUES ('x', 'world', 'c', 1.5, ?, ?)", ...T);
    await rejects(db, "INSERT INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) VALUES ('01V2', '01G1', 'quoted', ?)", NOW);
  });

  it('回收站章节必须有移入时间，正常章节不能有', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO chapter (id, order_key, title, status, created_at, updated_at) VALUES ('x', 'b', 't', 'trashed', ?, ?)", ...T);
    await rejects(db, "UPDATE chapter SET trashed_at = ? WHERE id = '01C1'", NOW);
  });

  it('章内排序键唯一', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES ('x', '01C1', 'a0', '重复', ?, ?)", ...T);
  });

  it('世界事实没有持有者，认知与说法必须有', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO fact (id, kind, holder_id, content, created_at, updated_at) VALUES ('x', 'world', '01E1', 'c', ?, ?)", ...T);
    await rejects(db, "INSERT INTO fact (id, kind, content, created_at, updated_at) VALUES ('x', 'belief', 'c', ?, ?)", ...T);
    await rejects(db, "INSERT INTO fact (id, kind, holder_id, content, created_at, updated_at) VALUES ('x', 'claim', 'nobody', 'c', ?, ?)", ...T);
  });

  it('故事时间的排序键只能与标签一同出现', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO story_event (id, story_time_order, summary, created_at, updated_at) VALUES ('x', 1, 's', ?, ?)", ...T);
    await rejects(db, "INSERT INTO fact (id, kind, content, valid_to_order, created_at, updated_at) VALUES ('x', 'world', 'c', 2, ?, ?)", ...T);
  });

  it('推演来源的运行与序号同空或同不为空', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO story_event (id, summary, origin_run_id, created_at, updated_at) VALUES ('x', 's', '01RUN', ?, ?)", ...T);
  });

  it('删除章节时段落、快照与事件关联级联删除，事实的适用章节置空', async () => {
    const db = await seeded();
    expect((await db.transaction([s("DELETE FROM chapter WHERE id = '01C1'")])).ok).toBe(true);
    const counts = await db.query(
      "SELECT (SELECT count(*) FROM paragraph) AS p, (SELECT count(*) FROM chapter_snapshot) AS s, (SELECT count(*) FROM event_paragraph_link) AS l, (SELECT valid_from_chapter_id FROM fact WHERE id = '01F2') AS c, (SELECT count(*) FROM story_event) AS e",
    );
    expect(counts).toEqual({ ok: true, value: [{ p: 0, s: 0, l: 0, c: null, e: 2 }] });
  });

  it('仍有认知或说法的人物不能删除', async () => {
    const db = await seeded();
    expect(await rejects(db, "DELETE FROM entity WHERE id = '01E1'")).toMatchObject({ code: 'constraint' });
  });
});

describe('表结构清单', () => {
  it('与迁移后的实际结构一致，库中没有清单以外的表', async () => {
    const db = fresh();
    const tables = await db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    expect(tables.ok && tables.value.map((r) => r['name'])).toEqual([...TABLES.map((t) => t.name), 'schema_migrations'].sort());
    for (const t of TABLES) {
      const info = await db.query(`SELECT name, pk FROM pragma_table_info('${t.name}') ORDER BY cid`);
      if (!info.ok) throw new Error(t.name);
      expect(info.value.map((r) => r['name']), t.name).toEqual(t.columns);
      const pk = info.value.filter((r) => Number(r['pk']) > 0).sort((a, b) => Number(a['pk']) - Number(b['pk']));
      expect(pk.map((r) => r['name']), t.name).toEqual(t.primaryKey);
    }
  });
});

describe('数据层导出导入（硬性规则 20）', () => {
  async function exported(db: ProjectDb): Promise<ExportedData> {
    const result = await exportData(db);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  }

  it('导出 → JSONL → 导入新库 → 再导出，逐表一致', async () => {
    const first = await exported(await seeded());
    expect(first.schemaVersion).toBe(1);
    for (const t of TABLES) expect(first.tables[t.name]?.length, `样本缺少 ${t.name}`).toBeGreaterThan(0);
    // JSON 列导出为对象，便于阅读。
    expect(first.tables['entity']?.[0]?.['aliases']).toEqual(['沈先生']);

    const files = Object.fromEntries(Object.entries(first.tables).map(([name, rows]) => [name, toJsonl(rows)]));
    const parsed: Record<string, unknown[]> = {};
    for (const [name, text] of Object.entries(files)) {
      const rows = fromJsonl(name, text);
      if (!rows.ok) throw new Error(JSON.stringify(rows.error));
      parsed[name] = rows.value;
    }
    const target = fresh();
    const imported = await importData(target, { schemaVersion: first.schemaVersion, tables: parsed as ExportedData['tables'] });
    expect(imported.ok).toBe(true);
    expect(await exported(target)).toEqual(first);
  });

  it('只导入到空库', async () => {
    const data = await exported(await seeded());
    expect(await importData(await seeded(), data)).toEqual({ ok: false, error: { code: 'not_empty', table: 'project' } });
  });

  it('版本不符时拒绝导入', async () => {
    const data = await exported(await seeded());
    expect(await importData(fresh(), { ...data, schemaVersion: 2 })).toEqual({ ok: false, error: { code: 'schema_mismatch', expected: 1, actual: 2 } });
  });

  it('拒绝未知的表与列；约束失败时整体回滚', async () => {
    const data = await exported(await seeded());
    expect(await importData(fresh(), { ...data, tables: { ...data.tables, secrets: [] } })).toMatchObject({ ok: false, error: { code: 'invalid', table: 'secrets' } });
    const project = data.tables['project']?.[0] ?? {};
    expect(await importData(fresh(), { ...data, tables: { ...data.tables, project: [{ ...project, extra: 1 }] } })).toMatchObject({
      ok: false,
      error: { code: 'invalid', table: 'project' },
    });
    const target = fresh();
    const broken = { ...data, tables: { ...data.tables, paragraph: [...(data.tables['paragraph'] ?? []), { id: 'x', chapter_id: 'missing', order_key: 'z', text: '', created_at: NOW, updated_at: NOW }] } };
    expect(await importData(target, broken)).toMatchObject({ ok: false, error: { code: 'sql' } });
    expect(await target.query('SELECT count(*) AS c FROM chapter')).toEqual({ ok: true, value: [{ c: 0 }] });
  });

  it('JSONL 的坏行给出行号', () => {
    expect(fromJsonl('chapter', '{"id":"a"}\n{坏行\n')).toMatchObject({ ok: false, error: { code: 'invalid', table: 'chapter', row: 1 } });
    expect(fromJsonl('chapter', '[1]\n')).toMatchObject({ ok: false, error: { code: 'invalid', row: 0 } });
  });
});

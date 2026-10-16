import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportData, fromJsonl, importData, toJsonl, UPGRADES, type ExportedData } from './data-export';
import { loadMigrations, openProjectDb, type ProjectDb } from './node/sqlite';
import { DERIVED_TABLES, TABLES } from './schema';
import type { Statement } from './sql';

const NOW = '2026-10-07T00:00:00.000Z';
const root = mkdtempSync(join(tmpdir(), 'fudiao-schema-'));
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
  s("INSERT INTO project (id, title, genre, goals, avoid_phrases, created_at, updated_at) VALUES ('01P', '雨夜', '武侠', '{\"words\":300000}', '[\"不禁\",\"仿佛\"]', ?, ?)", ...T),
  s("INSERT INTO chapter (id, order_key, title, summary, created_at, updated_at) VALUES ('01C1', 'a0', '第一章 雨夜', '两人在当铺重逢', ?, ?)", ...T),
  s("INSERT INTO chapter (id, order_key, title, status, trashed_at, created_at, updated_at) VALUES ('01C2', 'a1', '废稿', 'trashed', ?, ?, ?)", NOW, ...T),
  s("INSERT INTO volume (id, order_key, title, summary, version, created_at, updated_at) VALUES ('01O1', 'a0', '第一卷 雨夜', '两人重逢', 2, ?, ?)", ...T),
  s("INSERT INTO assistant_message (id, seq, role, payload, created_at) VALUES ('01Q1', 1, 'user', '{\"text\":\"新建一卷\"}', ?)", NOW),
  s("INSERT INTO assistant_message (id, seq, role, payload, created_at) VALUES ('01Q2', 2, 'assistant', '{\"output\":{\"message\":\"好\",\"actions\":[],\"done\":true}}', ?)", NOW),
  s("INSERT INTO assistant_message (id, seq, role, payload, created_at) VALUES ('01Q3', 3, 'changes', '{\"tool\":\"create_volume\",\"entries\":[{\"kind\":\"volume\",\"id\":\"01V1\",\"before\":null,\"after\":{\"title\":\"第一卷\",\"summary\":\"\",\"after\":null}}],\"kept\":false}', ?)", NOW),
  s("INSERT INTO assistant_message (id, seq, role, payload, created_at) VALUES ('01Q4', 4, 'undo', '{\"undid\":[\"01Q3\"],\"report\":\"已撤销\",\"ok\":true,\"source\":\"button\"}', ?)", NOW),
  s("INSERT INTO chapter (id, order_key, title, volume_id, created_at, updated_at) VALUES ('01C3', 'a0', '第二章 当铺', '01O1', ?, ?)", ...T),
  s("INSERT INTO paragraph (id, chapter_id, order_key, text, created_at, updated_at) VALUES ('01G1', '01C1', 'a0', '雨下得更紧了。', ?, ?)", ...T),
  s(
    "INSERT INTO paragraph (id, chapter_id, order_key, text, source_kind, source_spans, ai_origin_text, split_from, version, created_at, updated_at) VALUES ('01G2', '01C1', 'a1', '他没有回头。', 'ai_modified', '[{\"start\":0,\"end\":6}]', '他始终没有回头。', '01G1', 3, ?, ?)",
    ...T,
  ),
  s("INSERT INTO chapter_snapshot (id, chapter_id, reason, title, paragraphs, created_at) VALUES ('01S1', '01C1', 'manual', '第一章 雨夜', '[{\"id\":\"01G1\",\"text\":\"雨下得更紧了。\"}]', ?)", NOW),
  s("INSERT INTO entity (id, kind, name, aliases, data, locked, created_at, updated_at) VALUES ('01E1', 'character', '沈砚', '[\"沈先生\"]', '{\"age\":28}', 1, ?, ?)", ...T),
  s("INSERT INTO entity (id, kind, name, created_at, updated_at) VALUES ('01E2', 'location', '当铺', ?, ?)", ...T),
  s("INSERT INTO entity (id, kind, name, created_at, updated_at) VALUES ('01E3', 'character', '钱四', ?, ?)", ...T),
  s(
    "INSERT INTO relationship (id, from_id, to_id, category, label, mutual, description, secret, valid_from_chapter_id, valid_to_chapter_id, version, created_at, updated_at) VALUES ('01R1', '01E3', '01E1', 'enemy', '债主', 0, '沈砚欠他赌债', 1, '01C1', NULL, 2, ?, ?)",
    ...T,
  ),
  s("INSERT INTO relationship (id, from_id, to_id, category, label, mutual, created_at, updated_at) VALUES ('01R2', '01E1', '01E3', 'ally', '旧识', 1, ?, ?)", ...T),
  s("INSERT INTO relation_position (entity_id, x, y, updated_at) VALUES ('01E1', 120.5, -40, ?)", NOW),
  s("INSERT INTO fact (id, kind, subject_ids, content, status, created_at, updated_at) VALUES ('01F1', 'world', '[\"01E1\"]', '沈砚欠下赌债', 'confirmed', ?, ?)", ...T),
  s(
    "INSERT INTO fact (id, kind, holder_id, content, modality, confidence, valid_from_chapter_id, valid_from_label, valid_from_order, valid_to_label, status, review_reason, created_at, updated_at) VALUES ('01F2', 'belief', '01E1', '掌柜认得那块玉', 'inferred', 0.6, '01C1', '第三年春', 3.5, '入冬以前', 'needs_review', '设定条目“当铺”已修改', ?, ?)",
    ...T,
  ),
  s("INSERT INTO fact (id, kind, holder_id, content, modality, created_at, updated_at) VALUES ('01F3', 'claim', '01E1', '我从没来过这里', 'claimed', ?, ?)", ...T),
  s(
    "INSERT INTO llm_call (id, step_key, task_kind, provider, model, served_model, params, template_id, template_version, request_hash, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, response, error, started_at, finished_at) VALUES ('01L1', 'run1:1:action:shen:0', 'character_action', 'p1', 'm1', 'm1', '{\"maxOutputTokens\":1000}', 'character_action', '3', 'h1', 'completed', 100, 20, 30, 0, 0.0012, '{\"text\":\"{}\"}', NULL, ?, ?)",
    ...T,
  ),
  s(
    "INSERT INTO llm_call (id, step_key, task_kind, provider, model, served_model, params, template_id, template_version, request_hash, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, response, error, started_at, finished_at) VALUES ('01L2', NULL, 'selection_edit', 'p1', 'm1', NULL, '{}', 'selection_edit', '1', 'h2', 'error', NULL, NULL, NULL, NULL, NULL, NULL, '{\"code\":\"network\"}', ?, ?)",
    ...T,
  ),
  s(
    "INSERT INTO candidate (id, chapter_id, operation, target, base_text, base_versions, generated, content, status, status_reason, llm_call_id, version, created_at, updated_at) VALUES ('01K1', '01C1', 'rewrite', '{\"from\":{\"paragraphId\":\"01G1\",\"offset\":0},\"to\":{\"paragraphId\":\"01G1\",\"offset\":2}}', '雨下', '{\"01G1\":1}', '风起', '风起了', 'pending', NULL, '01L1', 2, ?, ?)",
    ...T,
  ),
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
  s("INSERT INTO chapter_snapshot (id, chapter_id, reason, title, paragraphs, created_at) VALUES ('01S2', '01C1', 'writer', '第一章 雨夜', '[]', ?)", NOW),
  s(
    "INSERT INTO foreshadow (id, title, content, reveal, plant_chapter_id, plant_anchor, payoff_chapter_id, payoff_anchor, status, version, created_at, updated_at) VALUES ('01H1', '玉佩的来历', '掌柜多看了玉佩一眼', '玉佩是王家失物的仿品', '01C1', '{\"paragraphId\":\"01G1\",\"paragraphVersion\":1,\"start\":0,\"end\":2,\"quote\":\"雨下\"}', '01C2', NULL, 'planted', 2, ?, ?)",
    ...T,
  ),
  s("INSERT INTO foreshadow (id, title, created_at, updated_at) VALUES ('01H2', '赌债的债主', ?, ?)", ...T),
  s(
    "INSERT INTO chapter_plan (chapter_id, goal, cast_ids, beats, foreshadow_plant, foreshadow_payoff, treatment, target_words, status, version, created_at, updated_at) VALUES ('01C1', '林舟当出玉佩', '[\"01E1\"]', '[\"讨价还价\",\"掌柜起疑\"]', '[\"01H1\"]', '[]', '讨价略写，起疑展开', 3000, 'written', 3, ?, ?)",
    ...T,
  ),
  s("INSERT INTO chapter_plan (chapter_id, created_at, updated_at) VALUES ('01C2', ?, ?)", ...T),
  s("INSERT INTO writing_skill (id, key, name, instruction, enabled, builtin_version, created_at, updated_at) VALUES ('01W1', 'foreshadow', '伏笔埋设与回收', '', 1, '1', ?, ?)", ...T),
  s("INSERT INTO writing_skill (id, key, name, description, instruction, enabled, builtin_version, created_at, updated_at) VALUES ('01W2', 'my_cliffhanger', '我的章末钩子', '写每一章的结尾时使用', '每章结尾停在一个未解的问题上', 0, NULL, ?, ?)", ...T),
  s("INSERT INTO cover (project_id, image, thumbnail, width, height, created_at, updated_at) VALUES ('01P', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', 'data:image/jpeg;base64,/9j/4AAQ', 600, 800, ?, ?)", ...T),
  s("INSERT INTO writing_skill (id, key, name, description, instruction, builtin_version, stages, created_at, updated_at) VALUES ('01W3', 'snowflake', '雪花写作法', '', '', '1', 'planning', ?, ?)", ...T),
  s("INSERT INTO writing_skill (id, key, name, description, instruction, builtin_version, stages, created_at, updated_at) VALUES ('01W4', 'author-preferences', '作者偏好', '作者说过的偏好', '- 对白要短', NULL, 'planning writing', ?, ?)", ...T),
  s(
    "INSERT INTO chapter_memory (chapter_id, summary, cast_state, foreshadow_progress, based_on, status, llm_call_id, created_at, updated_at, open_threads) VALUES ('01C1', '林舟深夜当玉，掌柜起疑', '{\"01E1\":\"急需用钱\"}', '{\"01H1\":\"planted\"}', '{\"01G1\":1,\"01G2\":3}', 'stale', '01L1', ?, ?, '[\"林舟答应三天后再来\"]')",
    ...T,
  ),
  s(
    "INSERT INTO review_issue (id, chapter_id, kind, severity, anchor, evidence, description, suggestion, status, source, llm_call_id, created_at, updated_at) VALUES ('01I1', '01C1', 'setting_conflict', 'high', '{\"paragraphId\":\"01G2\",\"paragraphVersion\":3,\"start\":0,\"end\":3,\"quote\":\"他没有\"}', '[{\"type\":\"entity\",\"id\":\"01E1\"}]', '沈砚的年龄与设定不符', '改为二十八岁', 'pending', 'model', '01L1', ?, ?)",
    ...T,
  ),
  s("INSERT INTO review_issue (id, chapter_id, kind, severity, anchor, description, source, created_at, updated_at) VALUES ('01I2', '01C1', 'ai_tone', 'low', '{\"paragraphId\":\"01G1\",\"paragraphVersion\":1,\"start\":0,\"end\":2,\"quote\":\"雨下\"}', '命中规避词', 'program', ?, ?)", ...T),
  s(
    "INSERT INTO sim_scene (id, chapter_id, title, config, config_version, protocol, max_rounds, first_speaker, version, created_at, updated_at) VALUES ('01N1', '01C1', '当铺谈判', '{\"zones\":[{\"id\":\"shop\",\"name\":\"当铺\"}]}', 2, 'turn_based', 8, 'lin_zhou', 3, ?, ?)",
    ...T,
  ),
  s("INSERT INTO sim_scene (id, title, config, protocol, max_rounds, created_at, updated_at) VALUES ('01N2', '仓库', '{}', 'simultaneous', 6, ?, ?)", ...T),
  s(
    "INSERT INTO sim_run (id, scene_id, scene_config, scene_config_version, mode, status, end_reason, round, last_seq, created_at, updated_at) VALUES ('01U1', '01N1', '{\"zones\":[]}', 1, 'auto', 'ended', 'max_rounds', 8, 3, ?, ?)",
    ...T,
  ),
  s(
    "INSERT INTO sim_run (id, scene_id, scene_config, scene_config_version, mode, batch_id, parent_run_id, branch_from_seq, budget_usd, status, pause_reason, round, last_seq, created_at, updated_at) VALUES ('01U2', '01N1', '{\"zones\":[]}', 1, 'interactive', '01B1', '01U1', 2, 1.5, 'paused', 'author', 1, 2, ?, ?)",
    ...T,
  ),
  s("INSERT INTO sim_event (run_id, seq, batch_first, batch_index, batch_size, type, payload, created_at) VALUES ('01U1', 1, 1, 0, 1, 'RunStarted', '{\"type\":\"RunStarted\",\"sceneHash\":\"h\"}', ?)", NOW),
  s("INSERT INTO sim_event (run_id, seq, batch_first, batch_index, batch_size, type, actor, payload, created_at) VALUES ('01U1', 2, 2, 0, 2, 'ProposalSubmitted', 'lin_zhou', '{\"type\":\"ProposalSubmitted\",\"actor\":\"lin_zhou\"}', ?)", NOW),
  s("INSERT INTO sim_event (run_id, seq, batch_first, batch_index, batch_size, payload, created_at) VALUES ('01U1', 3, 2, 1, 2, '[1,\"无类型的内容\"]', ?)", NOW),
  s("INSERT INTO sim_snapshot (run_id, seq, state, state_hash, created_at) VALUES ('01U1', 3, '{\"round\":8}', 'abc123', ?)", NOW),
  s(
    "INSERT INTO beat_sheet (id, run_id, pov_actor, from_round, to_round, up_to_seq, beats, style, llm_call_id, version, created_at, updated_at) VALUES ('01B1', '01U1', 'lin_zhou', 1, 8, 3, '[{\"ref\":\"k1\",\"treatment\":\"expand\",\"note\":\"对峙展开\",\"withhold\":false}]', '冷峻', '01L1', 2, ?, ?)",
    ...T,
  ),
  s("INSERT INTO beat_sheet (id, run_id, pov_actor, from_round, to_round, up_to_seq, beats, created_at, updated_at) VALUES ('01B2', '01U1', 'qian_si', 2, 2, 2, '[]', ?, ?)", ...T),
  s(
    "INSERT INTO evaluation (id, run_id, answers, version, created_at, updated_at) VALUES ('01V1', '01U1', '{\"scores\":{\"characters\":4,\"intel\":null,\"twist\":3,\"adopt\":4,\"edits\":1},\"twistNote\":\"弩箭\",\"note\":\"\",\"measured\":{\"runIds\":[\"01U1\"],\"adoptedEventIds\":[],\"calls\":3,\"costUsd\":0.02,\"unknownCostCalls\":0,\"modelMs\":1200}}', 2, ?, ?)",
    ...T,
  ),
  s("INSERT INTO evaluation (id, batch_id, answers, created_at, updated_at) VALUES ('01V2', '01B1', '{}', ?, ?)", ...T),
  s(
    "INSERT INTO candidate (id, chapter_id, operation, target, base_text, base_versions, generated, content, beat_sheet_id, created_at, updated_at) VALUES ('01K2', '01C1', 'narrate', '{\"from\":{\"paragraphId\":\"01G2\",\"offset\":6},\"to\":{\"paragraphId\":\"01G2\",\"offset\":6}}', '', '{\"01G2\":3}', '林舟推开了门。', '林舟推开了门。', '01B1', ?, ?)",
    ...T,
  ),
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

describe('写手与审核的约束（迁移 0005）', () => {
  it('快照可以记为写手写入；写手写入之前的旧原因仍然有效', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO chapter_snapshot (id, chapter_id, reason, title, paragraphs, created_at) VALUES ('x', '01C1', 'robot', 't', '[]', ?)", NOW);
  });

  it('枚举、JSON 数组与依据约束', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO foreshadow (id, title, status, created_at, updated_at) VALUES ('x', 't', 'forgotten', ?, ?)", ...T);
    await rejects(db, "INSERT INTO chapter_plan (chapter_id, cast_ids, created_at, updated_at) VALUES ('01C2', '{}', ?, ?)", ...T);
    await rejects(db, "UPDATE chapter_plan SET target_words = 0 WHERE chapter_id = '01C1'");
    await rejects(db, "INSERT INTO review_issue (id, chapter_id, kind, severity, anchor, description, source, created_at, updated_at) VALUES ('x', '01C1', 'typo', 'low', '{}', 'd', 'program', ?, ?)", ...T);
    // 程序检查出的问题没有模型调用。
    await rejects(db, "INSERT INTO review_issue (id, chapter_id, kind, severity, anchor, description, source, llm_call_id, created_at, updated_at) VALUES ('x', '01C1', 'pacing', 'low', '{}', 'd', 'program', '01L1', ?, ?)", ...T);
    await rejects(db, "INSERT INTO chapter_memory (chapter_id, summary, based_on, created_at, updated_at) VALUES ('01C2', 's', '[]', ?, ?)", ...T);
  });

  it('作者自定义的技能必须写明说明，技能键唯一', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO writing_skill (id, key, name, created_at, updated_at) VALUES ('x', 'empty', '空技能', ?, ?)", ...T);
    await rejects(db, "INSERT INTO writing_skill (id, key, name, builtin_version, created_at, updated_at) VALUES ('x', 'foreshadow', '重复', '1', ?, ?)", ...T);
    // 封面须是图片的 data URL，尺寸为正；每部作品只有一张。
    await rejects(db, "UPDATE cover SET image = 'https://example.com/a.jpg'");
    await rejects(db, "UPDATE cover SET width = 0");
    await rejects(db, "INSERT INTO cover (project_id, image, thumbnail, width, height, created_at, updated_at) VALUES ('01P', 'data:image/png;base64,AA==', 'data:image/png;base64,AA==', 1, 1, ?, ?)", ...T);
    // 阶段只能是规划、写章节或两者（按固定顺序写）。
    await rejects(db, "INSERT INTO writing_skill (id, key, name, builtin_version, stages, created_at, updated_at) VALUES ('x', 'review-only', '审核', '1', 'review', ?, ?)", ...T);
    await rejects(db, "INSERT INTO writing_skill (id, key, name, builtin_version, stages, created_at, updated_at) VALUES ('x', 'both', '两者', '1', 'writing planning', ?, ?)", ...T);
  });

  it('删除章节时计划、记忆与审核问题级联删除，伏笔的章节置空', async () => {
    const db = await seeded();
    const result = await db.transaction([s("DELETE FROM chapter WHERE id = '01C1'")]);
    expect(result.ok).toBe(true);
    for (const table of ['chapter_plan', 'chapter_memory', 'review_issue']) {
      const rows = await db.query(`SELECT count(*) AS n FROM ${table} WHERE chapter_id = '01C1'`);
      expect(rows.ok && rows.value[0]).toEqual({ n: 0 });
    }
    const f = await db.query("SELECT plant_chapter_id, payoff_chapter_id FROM foreshadow WHERE id = '01H1'");
    expect(f.ok && f.value[0]).toEqual({ plant_chapter_id: null, payoff_chapter_id: '01C2' });
  });
});

describe('角色推演的约束（迁移 0006）', () => {
  it('推演事件只追加：不能修改，也不能删除', async () => {
    const db = await seeded();
    expect(await rejects(db, "UPDATE sim_event SET payload = '{}' WHERE run_id = '01U1' AND seq = 1")).toMatchObject({ detail: expect.stringContaining('只追加') });
    expect(await rejects(db, "DELETE FROM sim_event WHERE run_id = '01U1' AND seq = 3")).toMatchObject({ detail: expect.stringContaining('只追加') });
    const rows = await db.query("SELECT count(*) AS n FROM sim_event WHERE run_id = '01U1'");
    expect(rows.ok && rows.value[0]).toEqual({ n: 3 });
  });

  it('事件必须属于已有的运行，序号从 1 起，批次信息与序号一致，内容是合法的 JSON', async () => {
    const db = await seeded();
    const insert = "INSERT INTO sim_event (run_id, seq, batch_first, batch_index, batch_size, payload, created_at) VALUES";
    await rejects(db, `${insert} ('none', 1, 1, 0, 1, '{}', ?)`, NOW);
    await rejects(db, `${insert} ('01U2', 0, 0, 0, 1, '{}', ?)`, NOW);
    await rejects(db, `${insert} ('01U2', 1, 1, 1, 1, '{}', ?)`, NOW);
    await rejects(db, `${insert} ('01U2', 2, 1, 0, 2, '{}', ?)`, NOW);
    await rejects(db, `${insert} ('01U2', 1, 1, 0, 1, '不是 JSON', ?)`, NOW);
    // 同一序号不能写两次。
    await rejects(db, `${insert} ('01U1', 3, 3, 0, 1, '{}', ?)`, NOW);
  });

  it('运行的状态、结束原因与分支来源互相一致；有运行的场景不能删除', async () => {
    const db = await seeded();
    const run = "INSERT INTO sim_run (id, scene_id, scene_config, scene_config_version, mode, status, end_reason, pause_reason, parent_run_id, branch_from_seq, created_at, updated_at) VALUES";
    await rejects(db, `${run} ('x', '01N1', '{}', 1, 'auto', 'ended', NULL, NULL, NULL, NULL, ?, ?)`, ...T);
    await rejects(db, `${run} ('x', '01N1', '{}', 1, 'auto', 'running', 'max_rounds', NULL, NULL, NULL, ?, ?)`, ...T);
    await rejects(db, `${run} ('x', '01N1', '{}', 1, 'auto', 'running', NULL, 'author', NULL, NULL, ?, ?)`, ...T);
    await rejects(db, `${run} ('x', '01N1', '{}', 1, 'auto', 'created', NULL, NULL, '01U1', NULL, ?, ?)`, ...T);
    await rejects(db, `${run} ('x', '01N1', '{}', 1, 'batch', 'created', NULL, NULL, NULL, NULL, ?, ?)`, ...T);
    await rejects(db, `${run} ('x', 'none', '{}', 1, 'auto', 'created', NULL, NULL, NULL, NULL, ?, ?)`, ...T);
    await rejects(db, "DELETE FROM sim_scene WHERE id = '01N1'");
    await rejects(db, "DELETE FROM sim_run WHERE id = '01U1'");
  });

  it('快照必须对应一条已有的事件；场景的配置是 JSON 对象；删除章节后场景保留', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO sim_snapshot (run_id, seq, state, state_hash, created_at) VALUES ('01U1', 9, '{}', 'h', ?)", NOW);
    await rejects(db, "INSERT INTO sim_scene (id, title, config, protocol, max_rounds, created_at, updated_at) VALUES ('x', 't', '[]', 'turn_based', 3, ?, ?)", ...T);
    await rejects(db, "INSERT INTO sim_scene (id, title, config, protocol, max_rounds, created_at, updated_at) VALUES ('x', 't', '{}', 'turn_based', 0, ?, ?)", ...T);
    expect((await db.transaction([s("DELETE FROM chapter WHERE id = '01C1'")])).ok).toBe(true);
    const scene = await db.query("SELECT chapter_id FROM sim_scene WHERE id = '01N1'");
    expect(scene.ok && scene.value[0]).toEqual({ chapter_id: null });
  });
});

describe('节拍表与推演写成的候选稿（迁移 0007）', () => {
  it('节拍表必须属于已有的运行，事件序号须是这次运行已有的事件，回合范围不能倒着', async () => {
    const db = await seeded();
    const sheet = "INSERT INTO beat_sheet (id, run_id, pov_actor, from_round, to_round, up_to_seq, beats, created_at, updated_at) VALUES";
    await rejects(db, `${sheet} ('x', 'none', 'a', 1, 1, 1, '[]', ?, ?)`, ...T);
    await rejects(db, `${sheet} ('x', '01U1', 'a', 1, 1, 9, '[]', ?, ?)`, ...T);
    await rejects(db, `${sheet} ('x', '01U1', 'a', 3, 2, 1, '[]', ?, ?)`, ...T);
    await rejects(db, `${sheet} ('x', '01U1', 'a', 0, 2, 1, '[]', ?, ?)`, ...T);
    await rejects(db, `${sheet} ('x', '01U1', 'a', 1, 1, 1, '{}', ?, ?)`, ...T);
  });

  it('只有“推演写成正文”的候选稿可以带节拍表；原有的操作照旧', async () => {
    const db = await seeded();
    const candidate =
      "INSERT INTO candidate (id, chapter_id, operation, target, base_text, base_versions, generated, content, beat_sheet_id, created_at, updated_at) VALUES ('x', '01C1', ?, '{}', '', '{}', 'g', 'g', ?, ?, ?)";
    await rejects(db, candidate, 'continue', '01B1', ...T);
    await rejects(db, candidate, 'narrate', 'none', ...T);
    await rejects(db, candidate, 'summarize', null, ...T);
    expect((await db.transaction([s(candidate, 'narrate', null, ...T)])).ok).toBe(true);
    const kept = await db.query("SELECT operation, beat_sheet_id FROM candidate WHERE id = '01K1'");
    expect(kept.ok && kept.value[0]).toEqual({ operation: 'rewrite', beat_sheet_id: null });
  });
});

describe('分卷（迁移 0010）', () => {
  it('卷名不能为空；章节的卷须存在；删除卷后其中的章节变为未分卷', async () => {
    const db = await seeded();
    await rejects(db, "INSERT INTO volume (id, order_key, title, created_at, updated_at) VALUES ('x', 'a1', '  ', ?, ?)", ...T);
    await rejects(db, "INSERT INTO chapter (id, order_key, title, volume_id, created_at, updated_at) VALUES ('x', 'a0', '章', 'none', ?, ?)", ...T);
    expect((await db.transaction([s("DELETE FROM volume WHERE id = '01O1'")])).ok).toBe(true);
    const chapter = await db.query("SELECT volume_id FROM chapter WHERE id = '01C3'");
    expect(chapter.ok && chapter.value[0]).toEqual({ volume_id: null });
  });

  it('书中顺序：未分卷的在前，再按卷的顺序，卷内按章节的顺序（卷的键与章节的键各自独立）', async () => {
    const db = fresh();
    const done = await db.transaction([
      s("INSERT INTO volume (id, order_key, title, created_at, updated_at) VALUES ('v2', 'a1', '第二卷', ?, ?)", ...T),
      s("INSERT INTO volume (id, order_key, title, created_at, updated_at) VALUES ('v1', 'a0', '第一卷', ?, ?)", ...T),
      s("INSERT INTO chapter (id, order_key, title, volume_id, created_at, updated_at) VALUES ('c4', 'a0', '二卷一章', 'v2', ?, ?)", ...T),
      s("INSERT INTO chapter (id, order_key, title, volume_id, created_at, updated_at) VALUES ('c3', 'a1', '一卷二章', 'v1', ?, ?)", ...T),
      s("INSERT INTO chapter (id, order_key, title, volume_id, created_at, updated_at) VALUES ('c2', 'a0', '一卷一章', 'v1', ?, ?)", ...T),
      s("INSERT INTO chapter (id, order_key, title, created_at, updated_at) VALUES ('c1', 'a5', '楔子', ?, ?)", ...T),
    ]);
    expect(done.ok).toBe(true);
    const order = await db.query('SELECT chapter_id FROM chapter_book_order ORDER BY position');
    expect(order.ok && order.value.map((r) => r['chapter_id'])).toEqual(['c1', 'c2', 'c3', 'c4']);
  });
});

describe('推演评价（迁移 0008）', () => {
  it('评价一次运行或一个批次，恰有其一；同一次运行、同一批次只有一份；内容须是对象', async () => {
    const db = await seeded();
    const evaluation = 'INSERT INTO evaluation (id, run_id, batch_id, answers, created_at, updated_at) VALUES';
    await rejects(db, `${evaluation} ('x', '01U2', '01B9', '{}', ?, ?)`, ...T);
    await rejects(db, `${evaluation} ('x', NULL, NULL, '{}', ?, ?)`, ...T);
    await rejects(db, `${evaluation} ('x', 'none', NULL, '{}', ?, ?)`, ...T);
    await rejects(db, `${evaluation} ('x', '01U1', NULL, '{}', ?, ?)`, ...T);
    await rejects(db, `${evaluation} ('x', NULL, '01B1', '{}', ?, ?)`, ...T);
    await rejects(db, `${evaluation} ('x', '01U2', NULL, '[]', ?, ?)`, ...T);
    expect((await db.transaction([s(`${evaluation} ('x', '01U2', NULL, '{}', ?, ?)`, ...T)])).ok).toBe(true);
  });
});

describe('表结构清单', () => {
  it('与迁移后的实际结构一致，库中没有清单以外的表', async () => {
    const db = fresh();
    const tables = await db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    expect(tables.ok && tables.value.map((r) => r['name'])).toEqual([...TABLES.map((t) => t.name), ...DERIVED_TABLES, 'schema_migrations'].sort());
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
    expect(first.schemaVersion).toBe(loadMigrations().at(-1)?.version);
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

  it('比本程序新的结构版本拒绝导入', async () => {
    const data = await exported(await seeded());
    const latest = data.schemaVersion;
    expect(await importData(fresh(), { ...data, schemaVersion: latest + 1 })).toEqual({ ok: false, error: { code: 'schema_mismatch', expected: latest, actual: latest + 1 } });
  });

  it('较旧结构版本导出的数据经各迁移的转换后导入（版本 1 的作品包）', async () => {
    const data = await exported(await seeded());
    const target = fresh();
    expect((await importData(target, { ...data, schemaVersion: 1 })).ok).toBe(true);
    expect((await exported(target)).tables).toEqual(data.tables);
  });

  it('结构版本 6 导出的数据（没有节拍表，候选稿没有 beat_sheet_id 列）经转换后导入', async () => {
    const data = await exported(await seeded());
    const tables = Object.fromEntries(Object.entries(data.tables).filter(([name]) => name !== 'beat_sheet'));
    tables['candidate'] = (data.tables['candidate'] ?? [])
      .filter((row) => row['operation'] !== 'narrate')
      .map(({ beat_sheet_id: _dropped, ...row }) => row);
    const target = fresh();
    expect(await importData(target, { schemaVersion: 6, tables })).toMatchObject({ ok: true });
    const after = await exported(target);
    expect(after.tables['beat_sheet']).toEqual([]);
    expect(after.tables['candidate']).toEqual((data.tables['candidate'] ?? []).filter((row) => row['operation'] !== 'narrate'));
  });

  it('结构版本 7 导出的数据（没有推演评价）导入后评价为空', async () => {
    const data = await exported(await seeded());
    const tables = Object.fromEntries(Object.entries(data.tables).filter(([name]) => name !== 'evaluation'));
    const target = fresh();
    expect(await importData(target, { schemaVersion: 7, tables })).toMatchObject({ ok: true });
    const after = await exported(target);
    expect(after.tables).toEqual({ ...data.tables, evaluation: [] });
  });

  it('结构版本 14 导出的数据（没有封面）导入后封面为空', async () => {
    const data = await exported(await seeded());
    const tables = Object.fromEntries(Object.entries(data.tables).filter(([name]) => name !== 'cover'));
    const target = fresh();
    expect(await importData(target, { schemaVersion: 14, tables })).toMatchObject({ ok: true });
    expect((await exported(target)).tables).toEqual({ ...data.tables, cover: [] });
  });

  it('结构版本 13 导出的数据（写作技能没有 stages 列）经转换后导入：都是写章节用的，“作者偏好”在规划时也遵守', async () => {
    const data = await exported(await seeded());
    const skills = (data.tables['writing_skill'] ?? []).map(({ stages: _dropped, ...row }) => row);
    const target = fresh();
    expect(await importData(target, { schemaVersion: 13, tables: { ...data.tables, writing_skill: skills } })).toMatchObject({ ok: true });
    const after = (await exported(target)).tables['writing_skill'] ?? [];
    expect(after.map((row) => [row['key'], row['stages']])).toEqual(skills.map((row) => [row['key'], row['key'] === 'author-preferences' ? 'planning writing' : 'writing']));
    expect(after.map(({ stages: _x, ...row }) => row)).toEqual(skills);
  });

  it('结构版本 12 导出的数据（长篇记忆没有 open_threads 列）经转换后导入，章尾留下的事为空', async () => {
    const data = await exported(await seeded());
    const memories = (data.tables['chapter_memory'] ?? []).map(({ open_threads: _dropped, ...row }) => row);
    const target = fresh();
    expect(await importData(target, { schemaVersion: 12, tables: { ...data.tables, chapter_memory: memories } })).toMatchObject({ ok: true });
    const after = (await exported(target)).tables['chapter_memory'] ?? [];
    expect(after.map((row) => row['open_threads'])).toEqual(memories.map(() => []));
    expect(after.map(({ open_threads: _x, ...row }) => row)).toEqual(memories);
  });

  it('结构版本 11 导出的数据（没有人物关系）导入后关系与位置为空', async () => {
    const data = await exported(await seeded());
    const tables = Object.fromEntries(Object.entries(data.tables).filter(([name]) => name !== 'relationship' && name !== 'relation_position'));
    const target = fresh();
    expect(await importData(target, { schemaVersion: 11, tables })).toMatchObject({ ok: true });
    expect((await exported(target)).tables).toEqual({ ...data.tables, relationship: [], relation_position: [] });
  });

  it('结构版本 10 导出的数据（没有助手的对话）导入后对话为空', async () => {
    const data = await exported(await seeded());
    const tables = Object.fromEntries(Object.entries(data.tables).filter(([name]) => name !== 'assistant_message'));
    const target = fresh();
    expect(await importData(target, { schemaVersion: 10, tables })).toMatchObject({ ok: true });
    expect((await exported(target)).tables).toEqual({ ...data.tables, assistant_message: [] });
  });

  it('结构版本 9 导出的数据（没有卷，章节没有 volume_id 列）经转换后导入，章节都是未分卷', async () => {
    const data = await exported(await seeded());
    const chapters = (data.tables['chapter'] ?? []).filter((row) => row['volume_id'] === null);
    const tables = Object.fromEntries(
      Object.entries({ ...data.tables, chapter: chapters.map(({ volume_id: _dropped, ...row }) => row) }).filter(([name]) => name !== 'volume'),
    );
    // 样本中归属卷的章节没有正文与其他引用，去掉后其余各表照旧。
    const target = fresh();
    expect(await importData(target, { schemaVersion: 9, tables })).toMatchObject({ ok: true });
    const after = await exported(target);
    expect(after.tables['volume']).toEqual([]);
    expect(after.tables['chapter']).toEqual(chapters);
  });

  it('结构版本 8 导出的数据（写作技能没有 description 列）经转换后导入，说明为空', async () => {
    const data = await exported(await seeded());
    const tables = { ...data.tables, writing_skill: (data.tables['writing_skill'] ?? []).map(({ description: _dropped, ...row }) => row) };
    const target = fresh();
    expect(await importData(target, { schemaVersion: 8, tables })).toMatchObject({ ok: true });
    const after = await exported(target);
    expect(after.tables['writing_skill']).toEqual((data.tables['writing_skill'] ?? []).map((row) => ({ ...row, description: '' })));
  });

  it('每个迁移都登记了导出数据的转换', () => {
    const versions = loadMigrations()
      .map((m) => m.version)
      .filter((v) => v > 1);
    expect(versions.filter((v) => UPGRADES[v] === undefined)).toEqual([]);
  });

  it('全文索引随段落的插入、修改、删除与章节删除维护；导入后可查', async () => {
    const db = await seeded();
    const indexed = async () => {
      const rows = await db.query(
        'SELECT k.paragraph_id AS id, f.text FROM paragraph_fts f JOIN paragraph_search_key k ON k.id = f.rowid ORDER BY k.paragraph_id',
      );
      const paragraphs = await db.query('SELECT id, text FROM paragraph ORDER BY id');
      return { rows: rows.ok ? rows.value : null, paragraphs: paragraphs.ok ? paragraphs.value : null };
    };
    let state = await indexed();
    expect(state.rows).toEqual(state.paragraphs);
    await db.transaction([s("UPDATE paragraph SET text = '当铺的门开了。' WHERE id = '01G1'")]);
    state = await indexed();
    expect(state.rows).toEqual(state.paragraphs);
    const hit = await db.query("SELECT rowid FROM paragraph_fts WHERE paragraph_fts MATCH '\"门开了\"'");
    expect(hit.ok && hit.value.length).toBe(1);
    await db.transaction([s("DELETE FROM chapter WHERE id = '01C1'")]);
    state = await indexed();
    expect(state.rows).toEqual(state.paragraphs);
    const keys = await db.query('SELECT count(*) AS n FROM paragraph_search_key');
    const left = await db.query('SELECT count(*) AS n FROM paragraph');
    expect(keys.ok && keys.value).toEqual(left.ok && left.value);
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

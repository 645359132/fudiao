-- 写手与审核（需求 B59 至 B66，施工文档第四章）：章节计划、伏笔账本、写作技能、长篇记忆、审核问题；
-- 章节快照增加“写手写入”（writer）原因：写手写入草稿章节前保存快照，作者可一键回退（B60）。

-- SQLite 不能修改 CHECK 约束，快照表按原结构重建；没有其他表引用它。
CREATE TABLE chapter_snapshot_new (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter (id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'before_restore', 'accept_candidate', 'import', 'writer')),
  title TEXT NOT NULL,
  paragraphs TEXT NOT NULL CHECK (json_valid(paragraphs)),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO chapter_snapshot_new (id, chapter_id, reason, title, paragraphs, created_at)
  SELECT id, chapter_id, reason, title, paragraphs, created_at FROM chapter_snapshot;
DROP TABLE chapter_snapshot;
ALTER TABLE chapter_snapshot_new RENAME TO chapter_snapshot;
CREATE INDEX chapter_snapshot_by_chapter ON chapter_snapshot (chapter_id, created_at);

-- 伏笔账本（B63）：揭晓前不得说破 reveal 中的内容；埋设与回收的位置用段落锚点（JSON）。
CREATE TABLE foreshadow (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reveal TEXT NOT NULL DEFAULT '',
  plant_chapter_id TEXT REFERENCES chapter (id) ON DELETE SET NULL,
  plant_anchor TEXT CHECK (plant_anchor IS NULL OR (json_valid(plant_anchor) AND json_type(plant_anchor) = 'object')),
  payoff_chapter_id TEXT REFERENCES chapter (id) ON DELETE SET NULL,
  payoff_anchor TEXT CHECK (payoff_anchor IS NULL OR (json_valid(payoff_anchor) AND json_type(payoff_anchor) = 'object')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'planted', 'paid_off', 'dropped')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- 章节计划（B65）：每章一行。cast_ids 为出场人物的设定标识，beats 为要写的情节点，伏笔为 foreshadow 的标识（均为 JSON 数组）。
CREATE TABLE chapter_plan (
  chapter_id TEXT PRIMARY KEY REFERENCES chapter (id) ON DELETE CASCADE,
  goal TEXT NOT NULL DEFAULT '',
  cast_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cast_ids) AND json_type(cast_ids) = 'array'),
  beats TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(beats) AND json_type(beats) = 'array'),
  foreshadow_plant TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(foreshadow_plant) AND json_type(foreshadow_plant) = 'array'),
  foreshadow_payoff TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(foreshadow_payoff) AND json_type(foreshadow_payoff) = 'array'),
  treatment TEXT NOT NULL DEFAULT '',
  target_words INTEGER CHECK (target_words IS NULL OR target_words > 0),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'writing', 'written', 'reviewed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- 写作技能（B61）：内置技能的文字在 packages/prompts/templates/skills/，这里只存启用状态与作者的改动（instruction 为空表示沿用内置文字）；
-- builtin_version 为空的是作者自定义的技能。
CREATE TABLE writing_skill (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE CHECK (length(key) > 0),
  name TEXT NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  builtin_version TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (builtin_version IS NOT NULL OR length(instruction) > 0)
) STRICT;

-- 长篇记忆（B66）：派生结论，记录依据的段落版本（based_on：段落标识到版本），正文修改后标为待复核。
CREATE TABLE chapter_memory (
  chapter_id TEXT PRIMARY KEY REFERENCES chapter (id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  cast_state TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cast_state) AND json_type(cast_state) = 'object'),
  foreshadow_progress TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(foreshadow_progress) AND json_type(foreshadow_progress) = 'object'),
  based_on TEXT NOT NULL CHECK (json_valid(based_on) AND json_type(based_on) = 'object'),
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'stale')),
  llm_call_id TEXT REFERENCES llm_call (id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- 审核问题（B64）：派生结论，定位到段落锚点（段落标识、版本、引文），依据为设定、事实、伏笔或段落的引用（JSON 数组）。
CREATE TABLE review_issue (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('setting_conflict', 'timeline', 'pov_leak', 'foreshadow', 'character', 'off_plan', 'pacing', 'ai_tone')),
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  anchor TEXT NOT NULL CHECK (json_valid(anchor) AND json_type(anchor) = 'object'),
  evidence TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence) AND json_type(evidence) = 'array'),
  description TEXT NOT NULL,
  suggestion TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ignored', 'fixed', 'sent_to_writer', 'stale')),
  source TEXT NOT NULL CHECK (source IN ('program', 'model')),
  llm_call_id TEXT REFERENCES llm_call (id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source = 'model' OR llm_call_id IS NULL)
) STRICT;

CREATE INDEX review_issue_by_chapter ON review_issue (chapter_id, status, created_at);
CREATE INDEX foreshadow_by_status ON foreshadow (status, payoff_chapter_id);

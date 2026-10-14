-- 推演写成正文（需求 B29、B45、B62，施工文档 M4-07）：节拍表，以及由节拍表写成的候选稿。

-- 节拍表：在事件记录与正文之间，作者为视角角色认知中的各条见闻标记展开、略写、省略、倒叙或留白。
-- 它是派生结论（硬性规则 21）：记下依据的运行、视角角色与事件序号（视角角色在那一刻的认知）。
CREATE TABLE beat_sheet (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES sim_run (id),
  -- 视角角色的键（场景内的键）。正文只用他在 up_to_seq 这一刻的认知（硬性规则 3）。
  pov_actor TEXT NOT NULL,
  from_round INTEGER NOT NULL CHECK (from_round >= 1),
  to_round INTEGER NOT NULL,
  up_to_seq INTEGER NOT NULL CHECK (up_to_seq >= 1),
  -- 节拍：[{ ref（认知条目的标识）, treatment, note, withhold }]。
  beats TEXT NOT NULL CHECK (json_valid(beats) AND json_type(beats) = 'array'),
  -- 作者对文风的说明，写正文时带上。
  style TEXT NOT NULL DEFAULT '',
  llm_call_id TEXT REFERENCES llm_call (id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (to_round >= from_round),
  FOREIGN KEY (run_id, up_to_seq) REFERENCES sim_event (run_id, seq)
) STRICT;

CREATE INDEX beat_sheet_by_run ON beat_sheet (run_id, created_at);

-- 候选稿增加“推演写成正文”（narrate）与它依据的节拍表。SQLite 不能修改 CHECK 约束，按原结构重建；没有其他表引用它。
CREATE TABLE candidate_new (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter (id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('continue', 'rewrite', 'expand', 'shorten', 'polish', 'narrate')),
  target TEXT NOT NULL CHECK (json_valid(target) AND json_type(target) = 'object'),
  base_text TEXT NOT NULL,
  base_versions TEXT NOT NULL CHECK (json_valid(base_versions) AND json_type(base_versions) = 'object'),
  generated TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'discarded', 'stale')),
  status_reason TEXT,
  llm_call_id TEXT REFERENCES llm_call (id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 由节拍表写成的候选稿记下节拍表；其余为 NULL。
  beat_sheet_id TEXT REFERENCES beat_sheet (id) ON DELETE SET NULL,
  CHECK (beat_sheet_id IS NULL OR operation = 'narrate')
) STRICT;

INSERT INTO candidate_new (id, chapter_id, operation, target, base_text, base_versions, generated, content, status, status_reason, llm_call_id, version, created_at, updated_at)
SELECT id, chapter_id, operation, target, base_text, base_versions, generated, content, status, status_reason, llm_call_id, version, created_at, updated_at FROM candidate;

DROP TABLE candidate;
ALTER TABLE candidate_new RENAME TO candidate;

CREATE INDEX candidate_by_chapter ON candidate (chapter_id, status, created_at);

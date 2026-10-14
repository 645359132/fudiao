-- 角色推演（需求 B22、B28、B30、B39 至 B41，施工文档第四章）：推演场景、推演运行、事件与快照。
-- 事件只追加，不修改、不删除（硬性规则 8），由 sim_event 上的触发器保证；回放只读事件（硬性规则 9）。

-- 推演场景：场景配置是领域内核的 SceneSpec（JSON 对象），作者可以修改。
CREATE TABLE sim_scene (
  id TEXT PRIMARY KEY,
  -- 场景属于哪一章；没有指定时为 NULL。
  chapter_id TEXT REFERENCES chapter (id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (trim(title) <> ''),
  config TEXT NOT NULL CHECK (json_valid(config) AND json_type(config) = 'object'),
  -- 场景配置每修改一次加一；运行记录记下开始时的版本。
  config_version INTEGER NOT NULL DEFAULT 1,
  -- 回合协议（B40）与回合上限；first_speaker 是轮流对话中第一个开口的角色键。
  protocol TEXT NOT NULL CHECK (protocol IN ('simultaneous', 'turn_based')),
  max_rounds INTEGER NOT NULL CHECK (max_rounds > 0),
  first_speaker TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX sim_scene_by_chapter ON sim_scene (chapter_id) WHERE chapter_id IS NOT NULL;

-- 推演运行。scene_config 是开始时的场景配置：场景之后再改，这次运行仍按当时的配置继续与回放。
-- status、end_reason、round、last_seq 是由事件得出的缓存，供列表显示；以事件为准。
CREATE TABLE sim_run (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES sim_scene (id),
  scene_config TEXT NOT NULL CHECK (json_valid(scene_config) AND json_type(scene_config) = 'object'),
  scene_config_version INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('interactive', 'auto')),
  -- 批量推演（B48）的批次；单次推演为 NULL。
  batch_id TEXT,
  -- 分支：从哪次运行的哪个序号分出来（B30）。
  parent_run_id TEXT REFERENCES sim_run (id),
  branch_from_seq INTEGER,
  -- 这次运行的费用上限（美元，B28）；没有设置时为 NULL。
  budget_usd REAL CHECK (budget_usd IS NULL OR budget_usd > 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'running', 'awaiting_author', 'paused', 'ended')),
  end_reason TEXT,
  pause_reason TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((parent_run_id IS NULL) = (branch_from_seq IS NULL)),
  CHECK ((status = 'ended') = (end_reason IS NOT NULL)),
  CHECK (pause_reason IS NULL OR status = 'paused')
) STRICT;

CREATE INDEX sim_run_by_scene ON sim_run (scene_id, created_at);

-- 推演事件。同一次追加的事件属于同一批次，与 M0 的 JSONL 记录格式一一对应。
-- type 与 actor 取自事件内容，便于查询；内容以 payload 为准。
CREATE TABLE sim_event (
  run_id TEXT NOT NULL REFERENCES sim_run (id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  batch_first INTEGER NOT NULL,
  batch_index INTEGER NOT NULL,
  batch_size INTEGER NOT NULL,
  type TEXT,
  actor TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK (batch_index >= 0 AND batch_index < batch_size AND seq = batch_first + batch_index)
) STRICT;

CREATE TRIGGER sim_event_no_update BEFORE UPDATE ON sim_event
BEGIN
  SELECT RAISE(ABORT, 'sim_event 只追加，不能修改');
END;

CREATE TRIGGER sim_event_no_delete BEFORE DELETE ON sim_event
BEGIN
  SELECT RAISE(ABORT, 'sim_event 只追加，不能删除');
END;

-- 状态快照：某个序号处的推演状态与它的哈希，用来校验回放的结果（B30）。
CREATE TABLE sim_snapshot (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (json_valid(state)),
  state_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id, seq) REFERENCES sim_event (run_id, seq)
) STRICT;

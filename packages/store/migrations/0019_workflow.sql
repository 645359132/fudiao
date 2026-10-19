-- 写作工作流（需求 B78，施工文档 M6-01）：一次运行按固定的步骤依次做，每步的状态与结果保存在作品里，
-- 关掉应用后可以接着做。运行做没做完由各步推出，不另存；只记作者放弃了没有。

CREATE TABLE workflow_run (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL CHECK (length(workflow) > 0),
  title TEXT NOT NULL,
  params TEXT NOT NULL CHECK (json_valid(params) AND json_type(params) = 'object'),
  mode TEXT NOT NULL CHECK (mode IN ('step', 'auto')),
  budget_usd REAL CHECK (budget_usd IS NULL OR budget_usd > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'abandoned')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- 步骤：output 是这一步的结果（草稿、报告或说明），读出时按这一步的结构校验；changes 是采用时对作品的改动（撤回用，
-- 格式同 AI 助手的撤销记录）；usage 是这一步的用量与费用；based_on 是派生结论依据的段落或长篇记忆的版本。
CREATE TABLE workflow_step (
  run_id TEXT NOT NULL REFERENCES workflow_run (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  key TEXT NOT NULL CHECK (length(key) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'awaiting_author', 'done', 'failed', 'skipped', 'interrupted', 'stale')),
  output TEXT CHECK (output IS NULL OR json_valid(output)),
  edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  note TEXT NOT NULL DEFAULT '',
  changes TEXT CHECK (changes IS NULL OR (json_valid(changes) AND json_type(changes) = 'array')),
  usage TEXT CHECK (usage IS NULL OR (json_valid(usage) AND json_type(usage) = 'object')),
  based_on TEXT CHECK (based_on IS NULL OR (json_valid(based_on) AND json_type(based_on) = 'object')),
  started_at TEXT,
  finished_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, idx),
  UNIQUE (run_id, key)
) STRICT;

CREATE INDEX workflow_run_by_time ON workflow_run (created_at);

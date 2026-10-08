-- 应用设置库 app.sqlite（施工文档第五章“服务、模型与任务分配的配置”）：属于应用，不随作品导出。
-- API Key 只在系统凭据管理器中，以服务标识为条目名；这里不保存任何凭据。

CREATE TABLE provider (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'gemini', 'openai_compatible', 'local')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  base_url TEXT NOT NULL CHECK (base_url LIKE 'http://%' OR base_url LIKE 'https://%'),
  auth_method TEXT NOT NULL CHECK (auth_method IN ('api_key', 'none')),
  -- OpenAI 写法的差异（ChatDialect 的覆盖项），空对象表示用该服务种类的默认值。
  dialect TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dialect) AND json_type(dialect) = 'object'),
  concurrency INTEGER NOT NULL DEFAULT 4 CHECK (concurrency BETWEEN 1 AND 64),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX provider_by_name ON provider (name);

CREATE TABLE model_profile (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider (id) ON DELETE CASCADE,
  model_id TEXT NOT NULL CHECK (length(trim(model_id)) > 0),
  display_name TEXT NOT NULL,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities) AND json_type(capabilities) = 'object'),
  -- 每百万 Token 的美元价格；未配置时费用记为未知（B19）。
  prices TEXT CHECK (prices IS NULL OR (json_valid(prices) AND json_type(prices) = 'object')),
  source TEXT NOT NULL CHECK (source IN ('service', 'builtin', 'user')),
  self_test TEXT CHECK (self_test IS NULL OR json_valid(self_test)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, model_id)
) STRICT;

-- 任务分配（B58）：首版只有 task = 'default' 一行，所有任务共用默认模型；P1 加入按任务分配与预设。
CREATE TABLE task_routing (
  task TEXT PRIMARY KEY,
  model_ref TEXT NOT NULL REFERENCES model_profile (id) ON DELETE CASCADE,
  params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params) AND json_type(params) = 'object'),
  fallback_model_ref TEXT REFERENCES model_profile (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
) STRICT;

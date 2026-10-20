-- 模型自带的联网搜索（需求 B84，M7-02）：搜索服务增加第四种 kind = 'provider'，由一个已配置的模型自己联网搜索
-- （Anthropic Messages API 与 OpenAI Responses API 的服务端搜索工具）。这种服务没有地址与 API Key：
-- 请求走该模型所属服务的凭据，model_id 记下用哪个模型。0003 的 credential_ref（沿用模型服务的 Key）照旧保留。
-- SQLite 不能修改 CHECK 约束，两张表按 0003 的结构重建：search_default 引用 search_service，开着外键时 DROP TABLE
-- 会级联删掉默认项，所以先把 search_default 也重建到新表上，再删旧表，最后改名（RENAME 会把外键引用一并改过来）。

CREATE TABLE search_service_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tavily', 'brave', 'deepseek', 'provider')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- 外部搜索服务要凭据，只能是 https；模型自带的搜索没有地址，记为空串。
  base_url TEXT NOT NULL CHECK ((kind <> 'provider' AND base_url LIKE 'https://%') OR (kind = 'provider' AND base_url = '')),
  -- 沿用哪个模型服务的 API Key（凭据条目名即它的标识）；两者的源须相同，由应用层核对。模型自带的搜索不用它。
  credential_ref TEXT,
  -- 模型自带的搜索用哪个模型；模型删除后置空，服务须重新选模型。外部搜索服务没有这一项。
  model_id TEXT REFERENCES model_profile (id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind = 'provider' OR model_id IS NULL),
  CHECK (kind <> 'provider' OR credential_ref IS NULL)
) STRICT;

INSERT INTO search_service_new (id, kind, name, base_url, credential_ref, model_id, enabled, version, created_at, updated_at)
SELECT id, kind, name, base_url, credential_ref, NULL, enabled, version, created_at, updated_at FROM search_service;

CREATE TABLE search_default_new (
  key TEXT PRIMARY KEY CHECK (key = 'default'),
  service_id TEXT NOT NULL REFERENCES search_service_new (id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO search_default_new (key, service_id, updated_at) SELECT key, service_id, updated_at FROM search_default;

DROP TABLE search_default;
DROP TABLE search_service;
ALTER TABLE search_service_new RENAME TO search_service;
ALTER TABLE search_default_new RENAME TO search_default;

CREATE UNIQUE INDEX search_service_by_name ON search_service (name);

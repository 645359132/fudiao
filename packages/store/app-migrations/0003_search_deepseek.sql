-- 联网搜索的服务增加 DeepSeek（开放平台 2026-10-17 起的 Search 与 Fetch 接口），并允许沿用某个模型服务的 API Key：
-- credential_ref 为那个模型服务（provider）的标识，为 NULL 时用这个搜索服务自己的凭据条目。
-- SQLite 不能修改 CHECK 约束，两张表按原结构重建；search_default 只有一行，先删子表再删父表。
CREATE TABLE search_service_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tavily', 'brave', 'deepseek')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  base_url TEXT NOT NULL CHECK (base_url LIKE 'https://%'),
  -- 沿用哪个模型服务的 API Key（凭据条目名即它的标识）；两者的源须相同，由应用层核对。
  credential_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO search_service_new (id, kind, name, base_url, credential_ref, enabled, version, created_at, updated_at)
  SELECT id, kind, name, base_url, NULL, enabled, version, created_at, updated_at FROM search_service;

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

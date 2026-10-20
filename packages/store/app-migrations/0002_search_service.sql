-- 联网搜索的服务（需求 B84，M7-01）：Tavily 或 Brave Search，由作者自填 API Key。
-- 与模型服务一样，API Key 只在系统凭据管理器中，以服务标识为条目名；这里不保存任何凭据。
-- 读网页不需要服务（Rust 命令 web_fetch 不带凭据），这里只管搜索。

CREATE TABLE search_service (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tavily', 'brave')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- 搜索服务都要凭据，所以只能是 https。
  base_url TEXT NOT NULL CHECK (base_url LIKE 'https://%'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX search_service_by_name ON search_service (name);

-- 默认的搜索服务：AI 助手与扫榜拆书用它；只有一行。
CREATE TABLE search_default (
  key TEXT PRIMARY KEY CHECK (key = 'default'),
  service_id TEXT NOT NULL REFERENCES search_service (id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
) STRICT;

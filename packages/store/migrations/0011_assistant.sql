-- AI 助手的对话（需求 B69，施工文档 M5-01）：每部作品一段对话，按 seq 排列，只追加；作者可以清空重来。
-- role：user 作者的话；assistant 助手一步的输出（经结构化输出管线校验）；results 动作的结果；
-- pending 等待作者确认的动作（之后有 results 即为已处理）。payload 为 JSON。
CREATE TABLE assistant_message (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'results', 'pending')),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at TEXT NOT NULL
) STRICT;

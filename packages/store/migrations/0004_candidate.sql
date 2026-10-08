-- 候选稿（需求 B17，施工文档第四章 candidate）：AI 结果先成为候选稿，作者比较、修改后接受或放弃；接受前检查原文是否改过。

CREATE TABLE candidate (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter (id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('continue', 'rewrite', 'expand', 'shorten', 'polish')),
  -- 原文位置：起止段落标识与段内下标（续写时起止相同），JSON。
  target TEXT NOT NULL CHECK (json_valid(target) AND json_type(target) = 'object'),
  -- 生成时原位置的文字与相关段落的版本；接受时不一致即为过期。
  base_text TEXT NOT NULL,
  base_versions TEXT NOT NULL CHECK (json_valid(base_versions) AND json_type(base_versions) = 'object'),
  -- 模型生成的原文（段落来源的“生成原文”）与作者修改后的内容。
  generated TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'discarded', 'stale')),
  status_reason TEXT,
  llm_call_id TEXT REFERENCES llm_call (id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX candidate_by_chapter ON candidate (chapter_id, status, created_at);

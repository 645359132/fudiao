-- 开篇打磨（需求 B81，施工文档 M6-05）：开篇诊断提出的审核问题来源记为 opening，
-- 单章审核与全书体检都只换掉各自来源的待处理问题，开篇诊断的问题留给作者处理，复诊时才换成新的一批。
-- SQLite 不能修改 CHECK 约束，审核问题表按原结构重建；没有其他表引用它。
CREATE TABLE review_issue_new (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('setting_conflict', 'timeline', 'pov_leak', 'foreshadow', 'character', 'off_plan', 'pacing', 'ai_tone')),
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  anchor TEXT NOT NULL CHECK (json_valid(anchor) AND json_type(anchor) = 'object'),
  evidence TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence) AND json_type(evidence) = 'array'),
  description TEXT NOT NULL,
  suggestion TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ignored', 'fixed', 'sent_to_writer', 'stale')),
  source TEXT NOT NULL CHECK (source IN ('program', 'model', 'continuity', 'opening')),
  llm_call_id TEXT REFERENCES llm_call (id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source <> 'program' OR llm_call_id IS NULL)
) STRICT;

INSERT INTO review_issue_new (id, chapter_id, kind, severity, anchor, evidence, description, suggestion, status, source, llm_call_id, version, created_at, updated_at)
  SELECT id, chapter_id, kind, severity, anchor, evidence, description, suggestion, status, source, llm_call_id, version, created_at, updated_at FROM review_issue;
DROP TABLE review_issue;
ALTER TABLE review_issue_new RENAME TO review_issue;
CREATE INDEX review_issue_by_chapter ON review_issue (chapter_id, status, created_at);

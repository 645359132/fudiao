-- 人物关系随剧情变化（需求 B73 补充，作者反馈 2026-10-23：写了一百多章，关系页还是建书时的两条）。
-- cast_presence：人物的出场、退场与回归。出场多数由章节计划与长篇记忆推算（第一次出现的章节），这里记的是推算不出的
--   （新人物在哪一章第一次出场）与作者改过的；退场（死亡、离开）与回归只记在这里。退场那一章人物还在，下一章起不在；
--   回归那一章起又在。作者可以在设定里改。
-- relation_suggestion：模型从长篇记忆找出的关系与人物变化（派生结论，硬性规则 21），作者逐条采用或忽略后才写进作品。
--   记下来源章节、依据的长篇记忆版本与调用记录。kind：relation_add 新增关系、relation_change 关系改变（旧的到上一章为止、
--   新的从这一章起）、relation_end 关系结束（到这一章为止）、cast_enter 新人物出场、cast_exit 退场、cast_return 回归。
--   关系的两端：已有的人物记 from_id、to_id，还没有卡片的新人物只记名字（采用时建卡片）；人物的出场、退场与回归记在 from 一端。
--   relationship_id 是模型指认的那条关系（改变与结束时），采用时它在这一章已不成立就按两端重新找；result_id 是采用后建出或改动的记录。
-- relation_scan：每章找到了哪个版本的长篇记忆（记忆重建后版本变了，这一章再找一次）。
CREATE TABLE cast_presence (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES chapter (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('enter', 'exit', 'return')),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (entity_id, chapter_id, kind)
) STRICT;

CREATE INDEX cast_presence_by_chapter ON cast_presence (chapter_id);

CREATE TABLE relation_suggestion (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('relation_add', 'relation_change', 'relation_end', 'cast_enter', 'cast_exit', 'cast_return')),
  relationship_id TEXT REFERENCES relationship (id) ON DELETE SET NULL,
  from_id TEXT REFERENCES entity (id) ON DELETE CASCADE,
  from_name TEXT NOT NULL CHECK (length(trim(from_name)) > 0),
  to_id TEXT REFERENCES entity (id) ON DELETE CASCADE,
  to_name TEXT NOT NULL DEFAULT '',
  category TEXT CHECK (category IS NULL OR category IN ('family', 'romance', 'mentor', 'ally', 'rival', 'enemy', 'affiliation', 'other')),
  label TEXT NOT NULL DEFAULT '',
  old_label TEXT NOT NULL DEFAULT '',
  mutual INTEGER NOT NULL DEFAULT 0 CHECK (mutual IN (0, 1)),
  secret INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0, 1)),
  description TEXT NOT NULL DEFAULT '',
  valid_to_chapter_id TEXT REFERENCES chapter (id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'adopted', 'ignored')),
  memory_version INTEGER NOT NULL,
  llm_call_id TEXT REFERENCES llm_call (id) ON DELETE SET NULL,
  result_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 关系的变化两端都要有名字，并且不是同一个人。
  CHECK (kind NOT LIKE 'relation_%' OR (length(trim(to_name)) > 0 AND from_name <> to_name AND length(trim(label)) > 0 AND category IS NOT NULL))
) STRICT;

CREATE INDEX relation_suggestion_by_chapter ON relation_suggestion (chapter_id, status);

CREATE TABLE relation_scan (
  chapter_id TEXT PRIMARY KEY REFERENCES chapter (id) ON DELETE CASCADE,
  memory_version INTEGER NOT NULL,
  llm_call_id TEXT REFERENCES llm_call (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

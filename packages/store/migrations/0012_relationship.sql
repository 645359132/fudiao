-- 人物关系网（需求 B73）：两项设定之间的关系，多为人物与人物、人物与组织。
-- label 是“from 是 to 的〈label〉”，例如 from = 青崖老人、to = 沈砚、label = 师父；mutual 为 1 时两边相同（朋友、同门）。
-- secret：读者还不知道这层关系（正文尚未揭晓），写手可以暗示，不要点明。
-- 适用的章节范围与事实相同：起止章节为空表示从头起或一直有效。关系随两端的设定一起删除。
CREATE TABLE relationship (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('family', 'romance', 'mentor', 'ally', 'rival', 'enemy', 'affiliation', 'other')),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  mutual INTEGER NOT NULL DEFAULT 0 CHECK (mutual IN (0, 1)),
  description TEXT NOT NULL DEFAULT '',
  secret INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0, 1)),
  valid_from_chapter_id TEXT REFERENCES chapter (id) ON DELETE SET NULL,
  valid_to_chapter_id TEXT REFERENCES chapter (id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (from_id <> to_id)
) STRICT;

CREATE INDEX relationship_by_from ON relationship (from_id);
CREATE INDEX relationship_by_to ON relationship (to_id);

-- 关系图上作者拖定的位置（只影响显示，不进入写作材料）。
CREATE TABLE relation_position (
  entity_id TEXT PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

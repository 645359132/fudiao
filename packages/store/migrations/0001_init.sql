-- 第一版作品库结构（施工文档第四章“主要数据表”；M1-03）。
-- 标识为 ULID 文本；系统时间为 UTC ISO 文本；故事时间为标签加可选排序键，与系统时间无关。
-- 可变记录带 version，供乐观并发守卫与来源版本使用。

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  -- 每个作品库只有一部作品。
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  title TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  outline TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(goals)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE chapter (
  id TEXT PRIMARY KEY,
  -- 分数索引字符串，在两个键之间总能插入新键。
  order_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'trashed')),
  trashed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'trashed') = (trashed_at IS NOT NULL))
) STRICT;

CREATE INDEX chapter_by_status_order ON chapter (status, order_key);

CREATE TABLE paragraph (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter (id) ON DELETE CASCADE,
  order_key TEXT NOT NULL,
  text TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'handwritten'
    CHECK (source_kind IN ('handwritten', 'ai_generated', 'ai_modified', 'mixed')),
  -- 合并段落时按字符区间记录各部分的来源。
  source_spans TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_spans)),
  -- 接受候选稿时的生成原文，用于判断是否改为“AI 生成后修改”。
  ai_origin_text TEXT,
  -- 拆分得到的后半段记录原段落标识；不设外键，原段落可能已被合并删除。
  split_from TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chapter_id, order_key)
) STRICT;

CREATE TABLE chapter_snapshot (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter (id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'before_restore', 'accept_candidate', 'import')),
  title TEXT NOT NULL,
  paragraphs TEXT NOT NULL CHECK (json_valid(paragraphs)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX chapter_snapshot_by_chapter ON chapter_snapshot (chapter_id, created_at);

CREATE TABLE entity (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'location', 'organization', 'item', 'rule')),
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases) AND json_type(aliases) = 'array'),
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  -- 锁定设定不被推演或生成结果改变。
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE fact (
  id TEXT PRIMARY KEY,
  -- 世界事实、人物认知、人物说法（B11）。
  kind TEXT NOT NULL CHECK (kind IN ('world', 'belief', 'claim')),
  holder_id TEXT REFERENCES entity (id) ON DELETE RESTRICT,
  subject_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(subject_ids) AND json_type(subject_ids) = 'array'),
  content TEXT NOT NULL,
  modality TEXT CHECK (modality IN ('observed', 'heard', 'inferred', 'claimed')),
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  valid_from_chapter_id TEXT REFERENCES chapter (id) ON DELETE SET NULL,
  valid_to_chapter_id TEXT REFERENCES chapter (id) ON DELETE SET NULL,
  valid_from_label TEXT,
  valid_from_order REAL,
  valid_to_label TEXT,
  valid_to_order REAL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'needs_review', 'rejected')),
  review_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 世界事实没有持有者；认知与说法必须有。
  CHECK ((kind = 'world') = (holder_id IS NULL)),
  -- 排序键只能与标签一同出现。
  CHECK (valid_from_order IS NULL OR valid_from_label IS NOT NULL),
  CHECK (valid_to_order IS NULL OR valid_to_label IS NOT NULL)
) STRICT;

CREATE INDEX fact_by_status ON fact (status);
CREATE INDEX fact_by_holder ON fact (holder_id);

-- 来源关系与依赖图（B12）。多态引用不设外键，由仓储校验。
CREATE TABLE source_ref (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_version INTEGER,
  -- 段落锚点：段落标识、段落版本、段内起止、摘录（规则 19）。
  anchor TEXT CHECK (anchor IS NULL OR json_valid(anchor)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX source_ref_by_target ON source_ref (to_type, to_id);
CREATE INDEX source_ref_by_origin ON source_ref (from_type, from_id);

-- 故事层（B55、I07）。
CREATE TABLE story_event (
  id TEXT PRIMARY KEY,
  story_time_label TEXT,
  story_time_order REAL,
  summary TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(participants) AND json_type(participants) = 'array'),
  location_id TEXT REFERENCES entity (id) ON DELETE SET NULL,
  perceptions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(perceptions)),
  -- 由推演采纳时记录来源运行与事件序号。
  origin_run_id TEXT,
  origin_seq INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((origin_run_id IS NULL) = (origin_seq IS NULL)),
  CHECK (story_time_order IS NULL OR story_time_label IS NOT NULL)
) STRICT;

CREATE TABLE event_paragraph_link (
  event_id TEXT NOT NULL REFERENCES story_event (id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraph (id) ON DELETE CASCADE,
  -- 正面叙述、回忆、转述、暗示。
  mode TEXT NOT NULL CHECK (mode IN ('direct', 'flashback', 'retold', 'implied')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, paragraph_id)
) STRICT;

CREATE INDEX event_paragraph_link_by_paragraph ON event_paragraph_link (paragraph_id);

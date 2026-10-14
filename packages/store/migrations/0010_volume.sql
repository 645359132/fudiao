-- 分卷（需求 B68，施工文档 M1-13）：一部作品分若干卷，一卷有若干章。

-- 卷：order_key 是卷在书中的顺序（分数索引，与章节的排序键各自独立）。
CREATE TABLE volume (
  id TEXT PRIMARY KEY,
  order_key TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  -- 本卷简介：这一卷讲什么，写手写本卷的章节时一并参考。
  summary TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX volume_by_order ON volume (order_key);

-- 章节所在的卷；为空表示“未分卷”（没有分卷的作品全部为空，与以前相同）。章节的 order_key 只在同一卷内比较。
-- 删除卷之前须先移走其中的章节（应用层检查）；回收站里的章节随卷删除变为未分卷。
ALTER TABLE chapter ADD COLUMN volume_id TEXT REFERENCES volume (id) ON DELETE SET NULL;

CREATE INDEX chapter_by_volume_order ON chapter (status, volume_id, order_key);

-- 章节在书中的位置：未分卷的在前，然后按卷的顺序，卷内按章节的顺序。
-- 需要“书中顺序”的查询都按它排序（目录、导出、查找、来源统计、章节计划、长篇记忆、事实的适用范围）。
CREATE VIEW chapter_book_order AS
SELECT
  c.id AS chapter_id,
  row_number() OVER (ORDER BY v.order_key IS NOT NULL, v.order_key, v.id, c.order_key, c.id) AS position
FROM chapter c
LEFT JOIN volume v ON v.id = c.volume_id;

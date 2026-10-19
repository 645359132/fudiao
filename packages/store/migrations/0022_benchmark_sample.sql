-- 扫榜拆书（需求 B79，施工文档 M6-07）：作者粘贴或导入的榜单条目与对标作品的样章原文。
-- 样章是别人的作品，只用于拆解：不进入作品包与导出（schema.ts 的 LOCAL_TABLES），运行结束或放弃时删除；
-- 拆解结果只写结构与技法，存在写作工作流的步骤里。
CREATE TABLE benchmark_sample (
  run_id TEXT NOT NULL REFERENCES workflow_run (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  title TEXT NOT NULL CHECK (length(title) > 0),
  author TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  words TEXT NOT NULL DEFAULT '',
  blurb TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, idx)
) STRICT;

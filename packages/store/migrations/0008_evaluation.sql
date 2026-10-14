-- 推演评价（需求 B46，施工文档 M4-09）：推演结束后作者的简短评价。单次推演评价一次运行，
-- 批量推演（B48）在整组结束后评价一次，两者恰有其一。

CREATE TABLE evaluation (
  id TEXT PRIMARY KEY,
  run_id TEXT UNIQUE REFERENCES sim_run (id),
  batch_id TEXT UNIQUE,
  -- 作者的评分与说明（与 M0 评价表同一组评分项），以及保存时记下的采纳事件、费用与等待。
  answers TEXT NOT NULL CHECK (json_valid(answers) AND json_type(answers) = 'object'),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((run_id IS NULL) <> (batch_id IS NULL))
) STRICT;

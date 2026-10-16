-- AI 助手的撤销（ASSISTANT_REVIEW.md 第五节第 3 项）：对话里增加两种记录。
-- changes 一个动作对作品的改动（改动前后的样子，撤销时据此改回；不给模型看）；undo 撤销了哪一轮的哪些改动。
-- SQLite 不能修改 CHECK 约束，按原结构重建；没有其他表引用它。
CREATE TABLE assistant_message_new (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'results', 'pending', 'changes', 'undo')),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO assistant_message_new (id, seq, role, payload, created_at) SELECT id, seq, role, payload, created_at FROM assistant_message;
DROP TABLE assistant_message;
ALTER TABLE assistant_message_new RENAME TO assistant_message;

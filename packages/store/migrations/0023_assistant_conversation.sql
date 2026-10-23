-- AI 助手的历史对话（作者反馈 2026-10-22：开新对话后之前的对话看不到了）：对话分成多段，“新对话”另开一段，
-- 之前的留着，可以切回去看、接着聊，也可以删掉。assistant_conversation 一段对话一行；assistant_message 增加
-- conversation_id（删除对话时连同消息一起删）。seq 仍在整张表里递增，一段对话之内按 seq 排列。
-- 已有的消息都归入一段对话，标识取固定的 ULID（时间戳为 0 的那一个），时间取最早与最晚一条消息。
-- SQLite 不能给已有的表加 NOT NULL 的外键列，按原结构重建；没有别的表引用 assistant_message。
CREATE TABLE assistant_conversation (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO assistant_conversation (id, created_at, updated_at)
SELECT '00000000000000000000000000', first, last
FROM (SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM assistant_message)
WHERE first IS NOT NULL;

CREATE TABLE assistant_message_new (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversation (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'results', 'pending', 'changes', 'undo')),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO assistant_message_new (id, conversation_id, seq, role, payload, created_at)
SELECT id, '00000000000000000000000000', seq, role, payload, created_at FROM assistant_message;

DROP TABLE assistant_message;
ALTER TABLE assistant_message_new RENAME TO assistant_message;
CREATE INDEX assistant_message_by_conversation ON assistant_message (conversation_id, seq);

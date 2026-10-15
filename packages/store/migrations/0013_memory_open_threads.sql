-- 长篇记忆增加“章尾留给后面的事”（需求 B74）：悬而未决的问题、人物的承诺或约定、没有完成的动作。
-- 写手写下一章时带上，提醒接住。旧的记忆为空，重建记忆时补上。
ALTER TABLE chapter_memory ADD COLUMN open_threads TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_threads) AND json_type(open_threads) = 'array');

-- 删除段落时记下它最后的版本（审查 2026-10-19）。长篇记忆、审核问题与候选稿以“段落标识加版本”判断原文是否变化；
-- 快照恢复或编辑器撤销找回同一标识的段落时，版本从这里接着往上加，不会倒退到与旧记录相同的版本而被当成原文没变。
CREATE TABLE paragraph_retired (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TRIGGER paragraph_retired_on_delete AFTER DELETE ON paragraph
BEGIN
  INSERT INTO paragraph_retired (id, version) VALUES (old.id, old.version)
    ON CONFLICT (id) DO UPDATE SET version = max(paragraph_retired.version, excluded.version);
END;

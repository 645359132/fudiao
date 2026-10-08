-- 全文查找（需求 B04）：用 FTS5 trigram 索引段落正文，3 字及以上的查询走索引，1 至 2 字的查询直接扫描 paragraph。
-- 索引是派生数据：由触发器随 paragraph 维护，不导出，导入时随插入段落重建。
-- FTS 的 rowid 取自 paragraph_search_key 的整数主键：paragraph 没有整数主键，
-- VACUUM（包括备份用的 VACUUM INTO）可能改变它的隐式 rowid，直接引用会让索引指错段落。

CREATE TABLE paragraph_search_key (
  id INTEGER PRIMARY KEY,
  paragraph_id TEXT NOT NULL UNIQUE
) STRICT;

CREATE VIRTUAL TABLE paragraph_fts USING fts5(text, tokenize = 'trigram');

INSERT INTO paragraph_search_key (paragraph_id) SELECT id FROM paragraph ORDER BY id;
INSERT INTO paragraph_fts (rowid, text)
  SELECT k.id, p.text FROM paragraph_search_key k JOIN paragraph p ON p.id = k.paragraph_id;

CREATE TRIGGER paragraph_search_insert AFTER INSERT ON paragraph BEGIN
  INSERT INTO paragraph_search_key (paragraph_id) VALUES (new.id);
  INSERT INTO paragraph_fts (rowid, text)
    VALUES ((SELECT id FROM paragraph_search_key WHERE paragraph_id = new.id), new.text);
END;

CREATE TRIGGER paragraph_search_update AFTER UPDATE OF text ON paragraph WHEN new.text IS NOT old.text BEGIN
  UPDATE paragraph_fts SET text = new.text
    WHERE rowid = (SELECT id FROM paragraph_search_key WHERE paragraph_id = new.id);
END;

-- 删除章节时级联删除的段落同样会触发。
CREATE TRIGGER paragraph_search_delete AFTER DELETE ON paragraph BEGIN
  DELETE FROM paragraph_fts WHERE rowid = (SELECT id FROM paragraph_search_key WHERE paragraph_id = old.id);
  DELETE FROM paragraph_search_key WHERE paragraph_id = old.id;
END;

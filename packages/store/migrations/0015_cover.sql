-- 作品封面（需求 B76）：每部作品一张。作者上传的图片在界面里缩放后以 data URL 存进作品库，随备份与作品包一起走；
-- image 是封面本身（保留原图的长宽比），thumbnail 是作品列表用的 3:4 小图。没有封面时界面按书名排出文字封面，不存。
CREATE TABLE cover (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  image TEXT NOT NULL CHECK (image LIKE 'data:image/%;base64,%' AND length(image) <= 3000000),
  thumbnail TEXT NOT NULL CHECK (thumbnail LIKE 'data:image/%;base64,%' AND length(thumbnail) <= 200000),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

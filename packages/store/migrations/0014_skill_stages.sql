-- 写作技能的阶段（需求 B75）：planning 用于生成作品骨架与章节计划，writing 用于写手写章节；空格分开，可以两者都有。
-- 已有的技能都是写章节用的。内置技能的阶段在模板里，打开作品时随内置技能一起同步到这一列。
-- “作者偏好”（AI 助手记下的作者明确说过的偏好与禁忌）在规划时同样要遵守。
ALTER TABLE writing_skill ADD COLUMN stages TEXT NOT NULL DEFAULT 'writing' CHECK (stages IN ('planning', 'writing', 'planning writing'));
UPDATE writing_skill SET stages = 'planning writing' WHERE key = 'author-preferences' AND builtin_version IS NULL;

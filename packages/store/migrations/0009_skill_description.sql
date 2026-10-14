-- 写作技能采用 SKILL.md 格式（需求 B61，施工文档 M3-11）：增加适用说明 description（SKILL.md 的 description，
-- 说明这项技能做什么、什么时候用）。内置技能的说明在模板文件里，这一列只存作者自定义或导入的技能的说明。
ALTER TABLE writing_skill ADD COLUMN description TEXT NOT NULL DEFAULT '';

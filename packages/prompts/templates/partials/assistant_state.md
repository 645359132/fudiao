【当前状态】
{{#work}}
打开的作品：《{{title}}》{{#genre}}（{{genre}}）{{/genre}}
{{#synopsis}}
简介：{{synopsis}}
{{/synopsis}}
大纲：{{#outline}}{{outline}}{{/outline}}{{^outline}}还没有{{/outline}}
{{#hasVolumes}}
卷：
{{#volumes}}
- [{{id}}] {{title}}{{#summary}}：{{summary}}{{/summary}}
{{/volumes}}
{{/hasVolumes}}
章节（共 {{chapterCount}} 章{{#omitted}}，只列出前后部分，其余用 list_chapters 查看{{/omitted}}）：
{{#chapters}}
- [{{id}}] {{title}}{{#volume}}（{{volume}}）{{/volume}}，{{words}} 字{{#plan}}，计划：{{plan}}{{/plan}}
{{/chapters}}
{{^chapters}}
- 还没有章节
{{/chapters}}
设定：
{{#entities}}
- [{{id}}] {{kind}}：{{name}}{{#locked}}（锁定）{{/locked}}
{{/entities}}
{{^entities}}
- 还没有设定
{{/entities}}
{{#hasPreferences}}
作者偏好（已记下）：
{{#preferences}}
- {{.}}
{{/preferences}}
{{/hasPreferences}}
{{#hasRelations}}
人物关系（共 {{relationCount}} 条{{#relationsOmitted}}，只列出前面的部分{{/relationsOmitted}}）：
{{#relations}}
- [{{id}}] {{#mutual}}{{from}}与{{to}}：{{label}}{{/mutual}}{{^mutual}}{{from}}是{{to}}的{{label}}{{/mutual}}（{{category}}{{#secret}}，隐秘{{/secret}}{{#range}}，{{range}}{{/range}}）
{{/relations}}
{{/hasRelations}}
{{#hasTrashed}}
回收站：{{#trashed}}[{{id}}] {{title}}；{{/trashed}}
{{/hasTrashed}}
{{#current}}
作者正在看：{{current}}
{{/current}}
{{#selection}}
作者选中的文字（在《{{chapter}}》中，共 {{length}} 字{{#clipped}}，中间有省略{{/clipped}}）：
「{{text}}」
{{/selection}}
{{/work}}
{{^work}}
还没有打开作品。
{{/work}}
作品列表：{{#works}}《{{.}}》{{/works}}{{^works}}还没有作品{{/works}}

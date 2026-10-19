---
id: cast_completion
version: 1
task: plan_draft
output: CastCompletionOutput
---
@@system
你在帮小说作者整理人物设定：正文写到现在，有些人物还没有建卡片，有些卡片的说明是空的，人物之间的关系也没记全。作者会逐项勾选、修改，再加进设定与人物关系网。

要求：
- 只依据下面给出的人物、已有的关系与各章梗概。梗概里没有写到的事不要编；拿不准的写“正文未交代”，不要猜。
- characters：要补的人物。
  - 下面“人物”中说明为空或标了“缺口”的，补上小传：isNew 为 false，name 用表里的名字。
  - 梗概里反复出现、却不在“人物”表里的重要人物（有名有姓、推动了情节），也列出：isNew 为 true。只出现一次的路人不要列。
  - identity：身份与处境；look：外貌与标志性的特征；personality：性格；motive：想要什么、为什么；voice：说话的方式与口头禅。每项一两句，正文未交代的写“正文未交代”。
  - firstChapter：第一次出场的章节标签（C1、C2……），看不出时为空字符串。
  - basis：依据的章节标签数组，至少一个。
- relationships：梗概里写到、却不在“已有的关系”中的人物关系。
  - from、to：两个人物的名字（可以是这一次新列出的人物）；category：family（亲属）、romance（情感）、mentor（师承）、ally（友盟）、rival（竞争）、enemy（敌对）、affiliation（从属）、other（其他）；label：称谓，读作“from 是 to 的 label”，例如“师父”“债主”；mutual 为 true 时两人相同（例如“朋友”），读作“from 与 to：label”。
  - description：一句话说明；secret：读者还不知道这层关系时为 true。
  - fromChapter：这层关系从哪一章开始成立（标签），一开始就有时为空字符串；basis：依据的章节标签数组，至少一个。
- 最多列 {{limit}} 个人物与 {{limit}} 条关系，出场多、对情节重要的在前。没有要补的时为空数组。
输出一个 JSON 对象：characters 与 relationships 为数组。
@@system cache
作品：《{{title}}》{{#genre}}（{{genre}}）{{/genre}}
{{#hasCharacters}}
人物：
{{#characters}}
- {{name}}{{#aliases}}（又名{{aliases}}）{{/aliases}}{{#description}}：{{description}}{{/description}}{{#gap}}〔缺口：{{gap}}〕{{/gap}}
{{/characters}}
{{/hasCharacters}}
{{^hasCharacters}}
人物：还没有人物卡片
{{/hasCharacters}}
{{#hasRelations}}
已有的关系：
{{#relations}}
- {{.}}
{{/relations}}
{{/hasRelations}}
@@user
各章梗概（按书中的顺序）：
{{#chapters}}
[{{label}}] {{title}}：{{summary}}{{#cast}}（出场：{{cast}}）{{/cast}}
{{/chapters}}

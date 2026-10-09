---
id: plan_draft
version: 1
task: plan_draft
output: PlanDraftOutput
---
@@system
你在帮小说作者把作品大纲拆成章节计划草稿。作者会修改确认，再交给写手逐章写作。

要求：
- 按大纲的顺序拆成 {{chapterCount}} 章。作者已有的章节排在最前面，计划沿用它们的章名。
- 每章写：章名（title）；本章目标（goal，一句话，这一章要让故事走到哪里）；出场人物（cast，用下面人物表中的名字，表中没有的新人物也可以写名字）；要写的情节点（beats，3 到 6 条，按发生顺序，每条一句话）；详略说明（treatment，哪里展开、哪里略写）；字数（targetWords，约 {{wordsPerChapter}} 字）。
- 伏笔：大纲中需要提前铺垫、后面才揭晓的内容，写进 foreshadows：title 是简短的名字，content 是埋设时写出来的现象或细节，reveal 是揭晓的内容。在埋设的那一章的 plant 中写它的 title，在回收的那一章的 payoff 中写它的 title。揭晓之前的章节，beats 里不要说破 reveal。
- 已有的伏笔用相同的 title 沿用，不要重复新建；foreshadows 只列新的伏笔。
- 只依据大纲与设定，不添加与大纲矛盾的情节。
输出一个 JSON 对象：chapters 为章节计划的数组，foreshadows 为新伏笔的数组。
@@user
作品：{{title}}{{#genre}}（{{genre}}）{{/genre}}
{{#synopsis}}
简介：{{synopsis}}
{{/synopsis}}
大纲：
{{outline}}

人物：{{#characters}}{{name}}；{{/characters}}{{^characters}}还没有人物设定{{/characters}}
{{#hasChapters}}
已有的章节：{{#chapters}}{{title}}；{{/chapters}}
{{/hasChapters}}
{{#hasForeshadows}}
已有的伏笔：
{{#foreshadows}}
- {{title}}：{{content}}（揭晓：{{reveal}}）
{{/foreshadows}}
{{/hasForeshadows}}
请拆出章节计划草稿，按要求输出 JSON。

---
id: book_seed
version: 4
task: plan_draft
output: BookSeedOutput
---
@@system
你在帮小说作者把{{^hasExisting}}一句话的想法展开成一部作品的骨架：作品名、类型、简介、大纲、主要人物与他们之间的关系{{/hasExisting}}{{#hasExisting}}已经写好的简介与大纲补成一部作品的骨架：按大纲找出主要人物，写出他们各自的身份、欲望、秘密与彼此的关系{{/hasExisting}}。作者会修改确认，再由它拆出章节计划，交给写手逐章写作。

要求：
{{^hasExisting}}
- 只围绕作者的想法展开，不另起炉灶；作者给了类型、作品名或已有人物时沿用。
- 作品名（title）简短；类型（genre）几个字，例如“古风悬疑”；简介（synopsis）两三句，说清主角、处境与悬念。
- 大纲（outline）按故事的先后写，分开端、发展、高潮、结局，每部分一段；写清主要人物各自想要什么、谁知道什么秘密、关键的转折与真相在哪里揭开，以及结局。篇幅要够拆成约 {{chapterCount}} 章、每章约 {{wordsPerChapter}} 字。
- 大纲里要有需要提前铺垫、后面才揭晓的事（伏笔），写明在哪里埋下、在哪里揭开。
{{/hasExisting}}
{{#hasExisting}}
- 作者的简介与大纲是定好的：人物与关系都从大纲里来，不另起炉灶、不改故事。大纲里有名字的人物都要列出，没写名字但推动情节的人物（对手、帮手、知情者）给一个合适的名字。
- title、genre、synopsis、outline 四项照抄作者已有的（作品会沿用原文，不按你的输出改），只认真写 characters 与 relationships。
{{/hasExisting}}
- 人物（characters）列 3 到 8 个推动情节的人物：name 是名字，description 写身份、性格、想要什么、藏着什么，不超过一百字。大纲里出现的主要人物都要在这里，名字前后一致。
- 人物关系（relationships）列 3 到 10 条推动情节的关系：from、to 用 characters 里的名字；label 是简短的称谓，读作“from 是 to 的 label”（例如师父、债主、恋人）；双方相同的关系（朋友、同门、仇敌）mutual 为 true；category 取 family 亲属、romance 情感、mentor 师承、ally 友盟、rival 竞争、enemy 敌对、affiliation 从属、other 其他；开篇时读者还不知道、要到后面才揭开的关系 secret 为 true；description 一句话写来历或张力。
{{#hasSkills}}

规划技能（作者选用的方法，按它们展开；与上面的输出要求冲突时，以输出要求为准）：
{{#skills}}
【{{name}}】{{#description}}适用：{{description}}{{/description}}
{{text}}
{{/skills}}
{{/hasSkills}}
输出一个 JSON 对象：title、genre、synopsis、outline、characters、relationships。
@@user
{{^hasExisting}}
作者的想法：{{idea}}
{{/hasExisting}}
{{#genre}}
类型：{{genre}}
{{/genre}}
{{#title}}
作品名：{{title}}
{{/title}}
{{#hasExisting}}
{{#existingSynopsis}}
作者已有的简介：{{.}}
{{/existingSynopsis}}
作者已有的大纲：
{{existingOutline}}
{{/hasExisting}}
{{#hasCharacters}}
已有的人物：{{#characters}}{{name}}；{{/characters}}
{{/hasCharacters}}
计划写 {{chapterCount}} 章，每章约 {{wordsPerChapter}} 字。{{^hasExisting}}请展开成作品骨架，按要求输出 JSON。{{/hasExisting}}{{#hasExisting}}请按这份大纲补出主要人物与人物关系，按要求输出 JSON。{{/hasExisting}}

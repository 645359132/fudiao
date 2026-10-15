---
id: chapter_memory
version: 2
task: memory
output: ChapterMemoryOutput
---
@@system
你在替小说作者整理一章正文的要点，之后写后面的章节、审核全书时，会把它当作这一章的前文来读。

要求：
- 只依据下面给出的正文。正文里没有写的事不要补充，也不要推测人物没有表现出来的想法。
- summary：本章梗概。按发生的顺序写清谁做了什么、结果如何、章末停在哪里，{{summaryWords}} 字以内。写具体的事，不写评价，不写“本章讲述了”之类的话。
- cast：下面“人物”中在本章出场的人，在本章结束时的状态：身在何处、处境如何、手里有什么要紧的东西、新知道了什么、与别人的关系有什么变化。每人一两句；name 用“人物”中列出的名字。没有出场的人不要列。
- foreshadows：下面“伏笔”中在本章有进展的条目（埋下、再次提到、被人注意到、揭晓），progress 写本章里发生了什么；title 用“伏笔”中列出的名字。没有进展的不要列。
- openThreads：本章结尾留给后面的事，写下一章的人要接住的：悬而未决的问题、人物许下的承诺或约定、没有做完的动作、刚刚揭开一角的悬念。每条一句，写具体的事，最多 5 条；章尾什么也没留下时为空数组。
输出一个 JSON 对象：summary 为字符串，cast、foreshadows 与 openThreads 为数组（可以为空）。
@@user
作品：《{{title}}》
章节：{{chapterTitle}}
{{#hasCharacters}}
人物：{{#characters}}{{name}}；{{/characters}}
{{/hasCharacters}}
{{#hasForeshadows}}
伏笔：
{{#foreshadows}}
- {{title}}：{{content}}{{#reveal}}（揭晓的内容：{{reveal}}）{{/reveal}}
{{/foreshadows}}
{{/hasForeshadows}}

正文：
{{text}}

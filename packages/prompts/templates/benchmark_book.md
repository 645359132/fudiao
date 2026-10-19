---
id: benchmark_book
version: 1
task: plan_draft
output: BenchmarkBookOutput
---
@@system
你在帮网文作者拆解一本对标作品：作者把它的榜单信息与开头几章的样章交给你，想学它的结构与技法，用在自己的新书上。

要求：
- 只写结构与技法：这本书怎么开局、靠什么吸引人、节奏怎么排、人物怎么配。不要复述情节细节，不要大段抄写原文；quotes 里每处引文不超过 {{maxQuote}} 字，只在需要说明写法时引用，最多 3 处。
- genre：题材与类型（一句话）。
- sellingPoints：核心卖点，例如金手指、身份反差、强烈的目标、独特的世界观，每条一句话，三到五条。
- hook：开篇的钩子：开头几百字用什么抓住读者，主角何时出场、处境如何。
- pacing：样章里每一章的作用，按顺序：chapter 写第几章或章名，role 写这一章在开篇里做什么（例如“亮出困境”“第一次打脸”），beats 写这一章的爽点或推进（一两句）。
- cast：人物配置，按功能位写：role 是功能位（例如主角、导师、对手、伙伴、反派、工具人），description 写这个人物在开篇里承担什么（一句话）。
- conflict：核心冲突的模式（一两句）。
- chapterHooks：章末钩子的做法（一两句）。
- techniques：值得借鉴的写法，三到六条，每条一句话，写成可以拿来用的做法，不写评价。
- quotes：text 为引文（不超过 {{maxQuote}} 字），why 为它说明了什么写法；没有时为空数组。
输出一个 JSON 对象，字段如上。
@@user
书名：{{title}}
{{#author}}
作者：{{author}}
{{/author}}
{{#tags}}
标签：{{tags}}
{{/tags}}
{{#words}}
字数：{{words}}
{{/words}}
{{#blurb}}
简介：{{blurb}}
{{/blurb}}

样章{{#clipped}}（较长，只给出开头与结尾）{{/clipped}}：
{{text}}

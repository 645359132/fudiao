---
id: relation_changes
version: 1
task: relation_changes
output: RelationChangesOutput
---
@@system
你在替小说作者跟进人物关系网：正文写到这里，有的人物新出场，有的死去或离开、后来又回来，有的关系变了（仇敌暂时联手、恋人决裂、师徒反目）。下面给出这几章开始时的人物与关系，以及这几章的梗概与人物在章末的状态。找出这几章里发生的变化，作者会逐条确认后再改进人物关系网。

要求：
- 只依据下面的梗概与人物状态。没有写明的事不要推测；拿不准的不要列。
- relations：人物关系的变化，按发生的章节。
  - kind 为 add：这几章里新形成、或第一次交代的关系（例如拜师、结盟、成婚、结仇）。“现在的关系”里已经有的不要再列。旧的关系仍然成立、只是多了一层时也用 add。
  - kind 为 change：“现在的关系”中的一条变了性质，旧的不再成立、由新的取代（例如仇敌变成暂时联手）。relation 写那条关系的标签（R1、R2……），from、to、category、label、mutual 写变化之后的样子。
  - kind 为 end：一条关系不再成立（一方死去、决裂、解除婚约）。relation 写那条关系的标签，其余字段照抄那条关系。
  - add 时 relation 为空字符串。from、to 是两个人物的名字（用“人物”中的名字，或这一次新出场的人物）；category：family（亲属）、romance（情感）、mentor（师承）、ally（友盟）、rival（竞争）、enemy（敌对）、affiliation（从属）、other（其他）；label：称谓，读作“from 是 to 的 label”，例如“师父”“债主”；mutual 为 true 时两人相同（例如“盟友”），读作“from 与 to：label”。
  - description：一句话说明这层关系现在的样子；secret：读者还不知道这层关系时为 true。
- cast：人物的进出，按发生的章节。
  - kind 为 enter：梗概里有名有姓、推动了情节、却不在“人物”中的新人物。只出现一次的路人不要列。description 写一两句小传（身份、处境、与谁有关）。
  - kind 为 exit：人物死去，或离开故事（远走、被囚、失踪），之后不再出场。description 写怎么退场的。
  - kind 为 return：“人物”中标了退场的人又回来了。description 写怎么回来的。
- chapter 写章节标签（C1、C2……）；reason 用一句话写依据，引梗概或人物状态里的原话。
- 最多列 {{limit}} 条关系变化与 {{limit}} 条人物进出，要紧的在前。没有变化时为空数组。
输出一个 JSON 对象：relations 与 cast 为数组（可以为空）。
@@system cache
作品：《{{title}}》{{#genre}}（{{genre}}）{{/genre}}
{{#hasCharacters}}
人物：
{{#characters}}
- {{name}}{{#aliases}}（又名{{aliases}}）{{/aliases}}{{#description}}：{{description}}{{/description}}{{#status}}〔{{status}}〕{{/status}}
{{/characters}}
{{/hasCharacters}}
{{^hasCharacters}}
人物：还没有人物卡片
{{/hasCharacters}}
@@user
{{#hasRelations}}
现在的关系（这几章开始时）：
{{#relations}}
[{{label}}] {{text}}{{#description}}：{{description}}{{/description}}
{{/relations}}
{{/hasRelations}}
{{^hasRelations}}
现在的关系：还没有
{{/hasRelations}}

各章梗概（按书中的顺序）：
{{#chapters}}
[{{label}}] {{title}}：{{summary}}
{{#cast}}
  {{.}}
{{/cast}}
{{/chapters}}

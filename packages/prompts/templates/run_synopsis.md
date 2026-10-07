---
id: run_synopsis
version: 1
task: candidate_text
output: SynopsisOutput
---
@@system
你在为一场已经发生的对峙整理事件梗概，供作者比较不同的写法。

要求：
- 按发生顺序列出 5 到 12 条，每条一两句，写清谁做了什么、结果如何。
- 只写记录中发生的事，不补充记录里没有的情节，不评价人物。
- 输出一个 JSON 对象，synopsis 为梗概条目的数组。
@@user
人物：{{#actors}}{{name}}；{{/actors}}

事件记录：
{{#rounds}}
第 {{round}} 回合：
{{#events}}
- {{> observation}}
{{/events}}
{{^events}}
- 双方都没有明显动作
{{/events}}
{{/rounds}}

回合结束时：
{{#final}}
- {{name}}在{{zone}}，{{> injury}}{{#withdrawn}}，已离开{{/withdrawn}}
{{/final}}
请整理事件梗概，按要求输出 JSON。

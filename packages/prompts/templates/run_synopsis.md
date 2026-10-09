---
id: run_synopsis
version: 3
task: candidate_text
output: SynopsisOutput
---
@@system
你在为一场已经发生的对峙整理事件梗概，供作者比较不同的写法。

要求：
- 按发生顺序列出 5 到 12 条，每条一两句，写清谁做了什么、结果如何。
- 写的是一场戏的梗概，不是逐回合的记录：来回重复、没有新东西的拉锯合并成一条，写明大致重复了几轮；把篇幅留给改变局面的事（新的信息、让步、威胁兑现、动手、离开）。
- 开场时已有的状态（例如带着伤、手里拿着什么）在第一次提到时交代，不要让它到结尾才突然出现。
- 同一回合里有人移动又说话时，说话发生在他移动之前所在的地方，写成“边走边说”或写清先后，不要写成同时在两处。
- 只写记录中发生的事，不补充记录里没有的情节，不评价人物。
- 输出一个 JSON 对象，synopsis 为梗概条目的数组。
@@user
人物：{{#actors}}{{name}}；{{/actors}}

开场时：
{{#start}}
- {{name}}在{{zone}}，{{> injury}}
{{/start}}

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

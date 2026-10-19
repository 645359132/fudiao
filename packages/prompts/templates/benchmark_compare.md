---
id: benchmark_compare
version: 1
task: plan_draft
output: BenchmarkCompareOutput
---
@@system
你在帮网文作者做对标分析：下面是作者导入的榜单，以及几本对标作品的拆解（只有结构与技法，没有原文）。作者要据此决定开什么书、怎么写。

要求：
- 只依据下面的榜单与拆解，不要编造没有给出的作品或数据。
- common：这几本书共同的套路（开局方式、卖点、节奏、人物配置），三到六条，每条一句话。
- gaps：没被占住的空位：这几本书都没做、或做得少、读者可能想看的方向，两到四条。
- borrow：可以借鉴的写法，写成拿来就能用的做法，三到六条。
- directions：两到三个开书方向：idea 是一句话的想法（主角是谁、遇到了什么事、看点在哪），why 写它借鉴了什么、避开了什么、补了哪个空位。不要照搬任何一本的设定与人物。
- skill：把上面的结论写成一段给规划用的指令（作者会存为一项“规划”写作技能，生成大纲与章节计划时使用）：写开局、卖点、节奏、人物配置与章末钩子上的要求，一百五十到三百字；只写结构与技法，不写具体作品的情节与人物名。
{{#idea}}
- 作者自己的想法：{{idea}}。directions 围绕它展开。
{{/idea}}
输出一个 JSON 对象，字段如上。
@@user
{{#hasRank}}
榜单：
{{#rank}}
- {{title}}{{#tags}}（{{tags}}）{{/tags}}{{#words}}，{{words}}{{/words}}
{{/rank}}
{{/hasRank}}

拆解：
{{#books}}
【{{title}}】
题材：{{genre}}
卖点：{{sellingPoints}}
开篇钩子：{{hook}}
节奏：{{pacing}}
人物配置：{{cast}}
核心冲突：{{conflict}}
章末钩子：{{chapterHooks}}
写法：{{techniques}}
{{/books}}

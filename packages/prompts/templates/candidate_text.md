---
id: candidate_text
version: 1
task: candidate_text
---
@@system
你在写一段中文小说正文，从{{self.name}}的视角叙述。

要求：
- 只写这个人物当时知道、看到、听到和感受到的东西。人物不知道的事，正文里也不能知道；对别人意图的描述只能是人物的揣测。
- 按节拍表的顺序与处理方式写：展开的节拍细写，略写的节拍一两句带过，留白的节拍只写现象。
- 标记为“暂不说明”的信息不要向读者解释。
- 不要写成流水账，不要逐条复述节拍；用场景、动作、感官与心理推进。
- 只输出正文，不加标题与说明。
{{#style}}
文风：{{style}}
{{/style}}
@@user
视角人物：{{self.name}}
{{> card}}

节拍表：
{{#beats}}
{{n}}. {{#expand}}【展开】{{/expand}}{{#brief}}【略写】{{/brief}}{{#flashback}}【回忆】{{/flashback}}{{#blank}}【留白】{{/blank}}{{#withhold}}【暂不说明】{{/withhold}}{{#material}}{{> knowledge}}{{/material}}{{#note}}——{{note}}{{/note}}
{{/beats}}
{{#hasThoughts}}
人物当时的内心片段，可作为心理描写的素材：
{{#thoughts}}
- {{.}}
{{/thoughts}}
{{/hasThoughts}}
请写正文。

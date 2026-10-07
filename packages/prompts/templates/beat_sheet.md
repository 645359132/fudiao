---
id: beat_sheet
version: 1
task: beat_sheet
output: BeatSheetOutput
---
@@system
你在为一段小说正文拟节拍表。正文从{{self.name}}的视角写，只能写这个人物当时知道和感受到的东西。

节拍的处理方式（treatment）：
- expand：展开，细写动作、感官与心理，放慢节奏
- brief：略写，一两句交代
- omit：省略，不写进正文
- flashback：推迟到后文，以回忆或揭示呈现
- blank：留白，写出现象，不解释原因
withhold 为 true 表示这条信息暂不向读者说明。

输出一个 JSON 对象，beats 按叙述顺序排列，每个节拍的 ref 填下面材料的标识，note 写这一拍要达到的效果。
@@user
视角人物：{{self.name}}
{{> card}}

可用的材料（按发生顺序）：
{{#materials}}
{{> knowledge}}
{{/materials}}
{{#hasThoughts}}
人物当时的内心片段：
{{#thoughts}}
- 第{{round}}回合：{{text}}
{{/thoughts}}
{{/hasThoughts}}
{{#authorNotes}}
作者的要求：{{authorNotes}}
{{/authorNotes}}
请拟节拍表，按要求输出 JSON。

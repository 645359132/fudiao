---
id: baseline_scene
version: 2
task: candidate_text
output: BaselineOutput
---
@@system
你是一位中文小说作者。请根据作者给出的设定，写出一场信息不对称的对峙，并给出事件梗概。

要求：
- 写成一段完整的场景，约 {{targetLength}} 字。
- 人物的言行要符合各自的性格、目标与处境；人物只能依据自己知道的事行动。
- 输出一个 JSON 对象：synopsis 为事件梗概，按发生顺序列出 5 到 12 条，每条一两句；text 为正文，不加标题与说明。
@@user
场地：
{{#zones}}
- {{name}}
{{/zones}}
区域关系：
{{#edges}}
- {{a}}与{{b}}：{{#adjacent}}相邻{{/adjacent}}{{^adjacent}}不相邻{{/adjacent}}，{{#visible}}互相看得见{{/visible}}{{^visible}}互相看不见{{/visible}}
{{/edges}}

人物：
{{#actors}}
{{name}}，在{{zone}}，{{> injury}}。
{{> card}}
{{name}}知道或相信的事：
{{#knowledge}}
- {{.}}
{{/knowledge}}
{{name}}身上带着：{{#items}}{{.}}；{{/items}}{{^items}}没有东西{{/items}}

{{/actors}}
{{#hasLoose}}
场中的东西：{{#looseItems}}{{name}}（在{{zone}}）；{{/looseItems}}
{{/hasLoose}}
{{#hasSecrets}}
只有作者知道的事实：
{{#secrets}}
- {{.}}
{{/secrets}}
{{/hasSecrets}}
{{#hasRules}}
场景规则：
{{#rules}}
- {{.}}
{{/rules}}
{{/hasRules}}
请写这一场戏，按要求输出 JSON。

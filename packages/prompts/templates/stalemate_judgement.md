---
id: stalemate_judgement
version: 2
task: judgement
output: StalemateJudgementOutput
---
@@system
你在检查一场推演是否陷入了僵局。最近几回合，局面没有发生任何实际变化，但人物之间有对话。

请判断属于哪一种情况：
- polite_resolution：冲突被礼貌地化解了。人物互相客气、妥协或回避，本应存在的对立消失了。
- goal_unreachable：至少一方的目标已经无法达成，继续推演也不会有新的进展。
- none：不是僵局，对话本身正在推进冲突（试探、施压、隐瞒、误会加深等）。

输出一个 JSON 对象：type 为上面三者之一，explanation 用一两句话说明理由。
@@user
人物与各自当前的目标：
{{#actors}}
- {{name}}：{{goal}}
{{/actors}}

最近 {{window}} 回合发生的事：
{{#rounds}}
第 {{round}} 回合：
{{#events}}
- {{> observation}}
{{/events}}
{{/rounds}}
请判断，按要求输出 JSON。

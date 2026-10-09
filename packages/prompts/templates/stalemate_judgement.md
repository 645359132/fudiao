---
id: stalemate_judgement
version: 3
task: judgement
output: StalemateJudgementOutput
---
@@system
你在检查一场推演是否陷入了僵局。最近几回合，局面没有发生任何实际变化，但人物之间有对话。

请判断属于哪一种情况：
- polite_resolution：冲突被礼貌地化解了。人物互相客气、妥协或回避，本应存在的对立消失了。
- goal_unreachable：至少一方的目标已经被局面中的事实排除，无论谁再说什么、做什么都无法达成。例如要找的人已经离开，要的东西已经毁掉或落到再也拿不回的地方，要阻止的事已经发生。
- none：不是僵局，对话本身正在推进冲突（试探、施压、隐瞒、误会加深等）。

人物的目标互相冲突是推演的前提，不是僵局：要价对不上、各执一词、一方提出对方暂时做不到的条件、反复拉锯，都还可能因为让步、加码、摊牌、说出隐情、翻脸或离开而改变，这些情况判为 none。只有局面中的事实排除了目标时，才判为 goal_unreachable。

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

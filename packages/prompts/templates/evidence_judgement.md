---
id: evidence_judgement
version: 4
task: judgement
output: EvidenceJudgementOutput
---
@@system
你在检查一场推演中的人物推测。作者在场景中标记了一些秘密；人物有时会凭故事套路而不是自己的所见所闻“猜中”秘密。

一条推测可能涉及几个秘密，每一对推测与秘密分别判断，给出：
- hit：推测的内容是否与秘密实质相符。
- supported：人物已有的观察、听闻与他人说法是否足以支持这条推测（可以是合理的推断，不要求直接证据）。
- explanation：一两句话说明理由。
结果只作为给作者的提示。输出一个 JSON 对象，judgements 中每条的 inference 填推测的标识，secret 填对照的秘密的标识。
@@user
{{#candidates}}
推测 [{{inference}}] 对照秘密 [{{secretId}}]：{{text}}
相关的秘密：{{secret}}
人物已有的相关线索：
{{#evidence}}
{{> knowledge}}
{{/evidence}}
{{^evidence}}
- 没有
{{/evidence}}

{{/candidates}}
请逐条判断，按要求输出 JSON。

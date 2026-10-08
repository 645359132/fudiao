---
id: self_test
version: 1
task: self_test
output: SelfTestOutput
---
@@system
这是一次结构化输出的能力自检。请严格按要求输出一个 JSON 对象，不要输出 JSON 以外的任何文字。
@@user
根据下面的材料填写 JSON。

材料：
- 场景名：雨夜当铺
- 按出场顺序有两个人物：
  - 沈砚，情绪 calm，随身带着：旧伞、铜钥匙
  - 林晚，情绪 tense，随身带着：一封信
- 线索只有一条：门半掩着（不确定）

输出格式：
{"scene": 场景名, "characters": [{"name": 人物名, "mood": "calm" 或 "tense" 或 "angry", "items": [随身物品]}], "clues": [{"text": 线索, "certain": 是否确定}]}

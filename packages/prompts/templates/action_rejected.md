---
id: action_rejected
version: 1
task: character_action
output: ActionProposal
---
@@user
这个行动无法执行：{{#violation}}{{> violation}}{{/violation}}。
请根据你的处境重新决定这一回合的行动，按同样的要求输出 JSON。

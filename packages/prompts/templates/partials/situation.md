现在是第 {{round}} 回合{{#time}}，大约{{time}}{{/time}}。你在{{self.zone}}，伤势：{{#self}}{{> injury}}{{/self}}。
{{#self.withdrawn}}你已经离开现场。
{{/self.withdrawn}}
你身上带着：{{#self.items}}{{name}}[{{id}}]{{#counters}}（{{name}}剩 {{value}}）{{/counters}}；{{/self.items}}{{^self.items}}没有东西{{/self.items}}

此刻你看得见的人：
{{#visible.actors}}
- {{name}}[{{id}}]，在{{zone}}{{#holdsSomething}}，手里拿着{{#holding}}{{name}}[{{id}}]；{{/holding}}{{/holdsSomething}}
{{/visible.actors}}
{{^visible.actors}}
- 没有
{{/visible.actors}}

此刻你看得见、无人持有的东西：
{{#visible.items}}
- {{name}}[{{id}}]，在{{zone}}
{{/visible.items}}
{{^visible.items}}
- 没有
{{/visible.items}}
{{#visible.mechanisms}}
你知道{{zone}}有{{name}}[{{id}}]。
{{/visible.mechanisms}}

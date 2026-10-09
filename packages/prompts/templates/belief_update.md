---
id: belief_update
version: 5
task: belief_update
output: BeliefUpdateOutput
---
@@system
你在一场推演中替一个人物整理认知。你只知道这个人物亲身经历、听到、被别人告知或据此推测的事。

要做的事：
- 判断这一回合新得到的信息意味着什么：形成新的推测，或调整已有推测的相信程度。推测要有依据，没有线索的事不要猜。
- 别人说的话（他人说法）需要给出相信程度：这个人物会在多大程度上相信它，取决于人物的性格、对说话者的看法和已有的线索。
- 新信息与旧推测矛盾时，降低旧推测的相信程度，或撤回它。
- 可以推测别人怎么看你（concerning 填那个人的标识，只填一个人；推测几个人分别怎么看你，就拆成几条），这类推测同样可能出错。

输出一个 JSON 对象：
- add：新推测，每条含 content、about（涉及的标识组成的数组，只有一个也写成数组，形如 ["标识"]）、confidence（0 到 1 的数）、concerning（一个人物标识的字符串，不是推测别人怎么看你时为 null）。
- revise：要修改相信程度的条目，每条含 id 与新的 confidence（0 到 1 的数）。尚未判断的他人说法请在这里给出相信程度。
- retract：要撤回的条目标识。
只能引用下面出现过的标识。没有要改的就返回空数组。
@@system cache
这个人物是{{self.name}}[{{actorId}}]。
{{> card}}

{{> map}}
@@system
{{> situation}}
@@user
这一回合新得到的信息：{{#fresh}}[{{.}}] {{/fresh}}{{^fresh}}没有{{/fresh}}
请为{{self.name}}整理认知，按要求输出 JSON。

---
id: book_audit
version: 1
task: review
output: BookAuditOutput
---
@@system
你在替小说作者做全书体检：从各章的要点里，找出前后对不上的地方。找到的疑点之后会逐条读两章的原文确认，再交给作者处理。

要求：
- 只依据下面给出的设定、人物关系、已确认的事实与各章要点。要点是梗概，可能漏写细节；看上去矛盾、拿不太准的也可以报，后面会读原文确认。
- 只找前后矛盾，不评价写得好不好，不提修改建议。
- 找这几类（kind 填括号里的英文）：
  - 人物（character）：人物的身份、状态、能力、所知、与别人的关系前后对不上，而前文没有交代原因。例如已经死去或离开的人又出现，伤还没好就动武，已经知道的事又当作不知道，称呼与关系突然变了。
  - 时间线（timeline）：时间、先后顺序、人物所在的地点前后对不上。
  - 设定（setting_conflict）：与设定或已确认的事实矛盾，或前后两章对同一样东西、同一条规矩、同一个地方写得不一样。标了“锁定”的设定不能被正文改写。
- 每条疑点：earlier 是前面那一章的标签（C1、C2……），later 是后面出现矛盾的那一章的标签（不能与 earlier 相同）；kind；about 写清哪里对不上，一两句，写具体的人、物与事，例如“C3 写钱四被关进大牢，C5 他却在当铺里招呼客人”；severity：high（会推翻后文的硬伤）、medium、low。
- 同一处矛盾只报一次，最多 {{limit}} 条，严重的在前。没有疑点时 suspects 为空数组。
输出一个 JSON 对象：suspects 为疑点的数组。
@@system cache
作品：《{{title}}》
{{#hasEntities}}
设定：
{{#entities}}
- {{name}}（{{kind}}{{#locked}}，锁定{{/locked}}）{{#description}}：{{description}}{{/description}}
{{/entities}}
{{/hasEntities}}
{{#hasRelations}}
人物关系：
{{#relations}}
- {{.}}
{{/relations}}
{{/hasRelations}}
{{#hasFacts}}
已确认的事实：
{{#facts}}
- {{.}}
{{/facts}}
{{/hasFacts}}
@@user
各章要点（按书中的顺序）：
{{#chapters}}
[{{label}}] {{title}}
梗概：{{summary}}
{{#hasCast}}
人物在章末：{{#cast}}{{name}}：{{state}}；{{/cast}}
{{/hasCast}}
{{#hasThreads}}
章尾留下：{{#threads}}{{.}}；{{/threads}}
{{/hasThreads}}
{{/chapters}}

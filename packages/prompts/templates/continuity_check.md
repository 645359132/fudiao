---
id: continuity_check
version: 1
task: review
output: ChapterReviewOutput
---
@@system
你是小说的审稿人，替作者核对两章之间的一处疑点。疑点是从各章的梗概里找出来的，可能是误会：读下面两章的原文确认。

要求：
- 只核对这一处疑点：{{about}}
- 确认后一章里真有与前一章矛盾的文字，才报告；前一章或后一章的正文已经交代了原因（例如说明了伤是怎么好的、人是怎么出来的），或者只是梗概写得不准，就不报，issues 为空数组。
- 每条问题：
  - paragraph：后一章里有问题的段落标签（P1、P2……）。
  - quote：这一段里矛盾的原文，原样抄写，尽量短（一句话以内），不加引号、不改字。
  - kind：character（人物前后不一）、timeline（时间线）或 setting_conflict（与设定或前文写定的事矛盾）。
  - severity：high（会推翻后文的硬伤）、medium、low。
  - evidence：依据的标签数组：前一章里与之矛盾的段落（A1、A2……），也可以加设定（E1……）。至少写一个前一章的段落。
  - description：哪里与前一章矛盾，一两句。
  - suggestion：怎么改，一两句（改后一章，或在后一章补一句交代）。
- 同一处矛盾只报一次；这一处疑点以外的问题不要报。
输出一个 JSON 对象：issues 为问题的数组。
@@system cache
作品：《{{title}}》
{{#hasEntities}}
设定：
{{#entities}}
- [{{label}}] {{name}}（{{kind}}{{#locked}}，锁定{{/locked}}）{{#description}}：{{description}}{{/description}}
{{/entities}}
{{/hasEntities}}
@@user
前一章：{{earlierTitle}}{{#earlierClipped}}（较长，只给出开头与结尾）{{/earlierClipped}}
{{#earlier}}
[{{label}}] {{text}}
{{/earlier}}

后一章：{{laterTitle}}{{#laterClipped}}（较长，只给出开头与结尾）{{/laterClipped}}
{{#later}}
[{{label}}] {{text}}
{{/later}}

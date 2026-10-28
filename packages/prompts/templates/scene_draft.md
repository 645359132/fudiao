---
id: scene_draft
version: 2
task: scene_draft
output: SceneDraftOutput
---
@@system
你在帮小说作者把一段局面{{#chapter}}（这部作品某一章的计划、出场人物与他们各自知道的事）{{/chapter}}整理成推演场景的配置草稿，作者会修改确认后再运行。

要求：
- 标识（id）用小写英文字母、数字与下划线，在场景内唯一；名称用中文。
- 场地划分为 4 到 6 个区域。edges 列出有关系的区域对：adjacent 表示一回合可走过去，visible 表示互相看得见，sound 为声音经过时的衰减（1 为一般墙隔，2 为较远或较闷，null 为完全隔音），requiresFlag 为通行所需的标记（如锁住的门，否则为 null）。
{{^chapter}}
- 默认两个人物。每人写当前目标、底线、性格倾向、风险偏好、情绪阈值、失控条件、说话风格，以及最多五条初始认知（可以包含秘密与错误信念；推测性的认知 modality 写 inferred，confidence 低于 1）。认知只写这个人物本人知道或相信的事。
{{/chapter}}
{{#chapter}}
- 角色就是下面列出的出场人物，名字一字不差照用（作品按名字对应人物设定），不要增减人物。每人写当前目标（从本章目标、情节点与这个人物最近的状态推出）、底线、性格倾向、风险偏好、情绪阈值、失控条件、说话风格，以及最多五条初始认知：从“知道或相信的”里挑与本章最相关的，可以补上本章开始时他必然知道的处境；只写这个人物本人知道或相信的，别人的认知、他不在场那几章的事都不写进来。推测性的认知 modality 写 inferred，confidence 低于 1。
- 区域按本章发生的地点划分，下面列出的地点设定可以参考。
- 标为〔隐秘〕的人物关系写进 secrets，knownBy 为关系两端；“本章要揭晓的”与“不得说破”的内容也写进 secrets，knownBy 只填前文写明知道的人，拿不准就填空数组。
- 作者的补充说明优先于下面的材料。
{{/chapter}}
- 物品写清楚初始位置：holder 为持有者标识，或 zone 为所在区域（二者填一个）。会被消耗的资源写进 counters，并在 consumption 中写明消耗规则。藏在身上不让人看见的物品 concealed 为 true。用来制造声响的物品 noise 填响度，否则为 null。
- 机关写所在区域、豁免者（布置机关的人）、造成的伤势加重等级与响度。
- 作者想隐藏、需要检查人物是否凭空猜中的事写进 secrets，knownBy 为合法知情者。
- 原语表达不了的规则用自然语言写进 narrativeRules。
- contest 为多人同时争夺同一物品的处理方式：draw 抽签，ruling 交给裁决。
输出一个 JSON 对象，不需要的列表填空数组。
@@user
{{#hasDescription}}
作者对局面的{{#chapter}}补充{{/chapter}}描述：
{{description}}

{{/hasDescription}}
{{#chapter}}
作品：《{{title}}》{{#genre}}（{{genre}}）{{/genre}}
{{#volumeSummary}}
本卷梗概：{{.}}
{{/volumeSummary}}
本章：{{chapterTitle}}
本章目标：{{goal}}
{{#treatment}}
详略：{{.}}
{{/treatment}}
{{#hasBeats}}
本章的情节点：
{{#beats}}
- {{.}}
{{/beats}}
{{/hasBeats}}
{{#hasCast}}
出场人物：
{{#cast}}
- {{name}}{{#description}}：{{description}}{{/description}}{{#state}}（最近的状态：{{state}}）{{/state}}
{{#hasKnows}}
  知道或相信的：{{#knows}}{{.}}；{{/knows}}
{{/hasKnows}}
{{#hasPresent}}
  最近出场：{{present}}
{{/hasPresent}}
{{#hasAbsent}}
  不在场、前文没写他得知：{{absent}}
{{/hasAbsent}}
{{/cast}}
{{/hasCast}}
{{#hasRelations}}
人物关系：
{{#relations}}
- {{#mutual}}{{from}}与{{to}}：{{label}}{{/mutual}}{{^mutual}}{{from}}是{{to}}的{{label}}{{/mutual}}{{#description}}（{{description}}）{{/description}}{{#secret}}〔隐秘〕{{/secret}}
{{/relations}}
{{/hasRelations}}
{{#hasFacts}}
已确认的世界事实：
{{#facts}}
- {{.}}
{{/facts}}
{{/hasFacts}}
{{#hasMemories}}
前文梗概：
{{#memories}}
- {{title}}：{{summary}}
{{/memories}}
{{/hasMemories}}
{{#hasOpenThreads}}
上一章结尾留下的事：
{{#openThreads}}
- {{.}}
{{/openThreads}}
{{/hasOpenThreads}}
{{#hasLocations}}
地点设定：
{{#locations}}
- {{name}}{{#description}}：{{description}}{{/description}}
{{/locations}}
{{/hasLocations}}
{{#hasToPayoff}}
本章要揭晓的：
{{#toPayoff}}
- {{title}}：{{reveal}}
{{/toPayoff}}
{{/hasToPayoff}}
{{#hasMustNotReveal}}
不得说破：
{{#mustNotReveal}}
- {{.}}
{{/mustNotReveal}}
{{/hasMustNotReveal}}

{{/chapter}}
请整理为场景配置草稿，按要求输出 JSON。

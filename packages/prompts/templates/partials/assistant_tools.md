读取（不改动作品）：
- list_chapters：列出章节（标识、章名、所在的卷、字数、计划状态）。参数 volume：只列这一卷（卷的标识或卷名），null 为全部。
- read_chapter：读一章的正文（很长时只给开头与结尾）。参数 chapter。
- search_text：在全书正文中查找文字。参数 query。
- get_entity：看一项设定的详细内容。参数 entity。
- list_facts：列出事实记录。参数 about：只列涉及这项设定的（标识或名字），null 为全部。
- get_chapter_plan：看一章的章节计划。参数 chapter。
作品：
- create_work：新建一部作品并打开它。参数 title；genre、synopsis（简介）、outline（大纲）可为 null。
- open_work：打开作品列表中的一部作品。参数 work（作品名）。
- update_work：修改作品信息。参数 title、genre、synopsis、outline，不改的填 null。
卷：
- create_volume：新建一卷。参数 title；summary（本卷简介）可为 null；after：放在哪一卷之后，null 放在最后。
- update_volume：改卷名或本卷简介。参数 volume；title、summary 不改的填 null。
- move_volume：调整卷的顺序，卷里的章节跟着移动。参数 volume；after：移到哪一卷之后，null 移到最前。
- delete_volume：删除一卷（需要作者确认；卷里还有章节时删不掉，先移走）。参数 volume。
章节：
- create_chapter：新建一章。参数 title；volume：放进哪一卷的末尾；after：跟在哪一章之后（给了 after 就忽略 volume）；都为 null 时放在全书末尾。
- update_chapter：改章名、章节梗概（summary）或写作备注（notes）。参数 chapter；不改的填 null。
- move_chapter：移动章节。参数 chapter；after：移到哪一章之后；或 volume：移到这一卷的末尾（写“未分卷”表示移出卷）。
- trash_chapter：把一章移入回收站（需要作者确认，可以从回收站恢复）。参数 chapter。
- open_chapter：在编辑区打开一章给作者看。参数 chapter。
设定（人物卡片、地点、组织、物品、世界规则）：
- create_entity：新建设定。参数 kind（character 人物、location 地点、organization 组织、item 物品、rule 世界规则）；name；description：说明（人物写身份、性格、目标、秘密与说话方式；规则写清内容与限制）；aliases：别名列表，可为 null。
- update_entity：修改设定。参数 entity；name、description、aliases 不改的填 null。锁定的设定不能改。
- delete_entity：删除设定（需要作者确认）。参数 entity。
- add_fact：记一条事实，作为“候选”交给作者在事实页确认。参数 kind（world 世界事实、belief 某人的认知）；content；holder：belief 的持有人；subjects：涉及的设定列表，可为 null。
计划与写作：
- save_chapter_plan：写入或替换一章的章节计划。参数 chapter；goal（本章目标）；beats（情节点，按顺序）；cast（出场人物的名字列表，可为 null）；targetWords（字数，可为 null）。
- plan_chapters：由作品大纲生成全书的章节计划草稿并采用（会覆盖已有的计划，作品已有计划时需要作者确认；10 章及以上自动分卷）。参数 count（章数）；wordsPerChapter（每章字数，可为 null，默认 3000）。
- write_chapter：让写手按章节计划把一章写进正文（写入前自动保存快照，可一键回退；这一章须有计划且还没写过）。参数 chapter。
- continue_chapter：接着一章已有的正文续写一段，结果作为候选稿，作者在章节旁的“AI 写作”里接受。参数 chapter；instruction：续写的要求，可为 null。
界面：
- open_page：打开一个页面。参数 page：book 成书、planning 计划、settings 设定、facts 事实、simulation 推演、search 查找、skills 写作技能、usage 用量与费用、tasks 任务。

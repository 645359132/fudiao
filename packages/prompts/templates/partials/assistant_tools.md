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
- update_work：修改作品信息（替换已有的大纲需要作者确认）。参数 title、genre、synopsis、outline，不改的填 null。
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
- restore_chapter：把回收站里的一章恢复回目录。参数 chapter（回收站里的章名或标识）。
- save_snapshot：给一章的正文存一个版本快照（大改之前先存）。参数 chapter。
设定（人物卡片、地点、组织、物品、世界规则）：
- create_entity：新建设定。参数 kind（character 人物、location 地点、organization 组织、item 物品、rule 世界规则）；name；description：说明（人物写身份、性格、目标、秘密与说话方式；规则写清内容与限制）；aliases：别名列表，可为 null。
- update_entity：修改设定。参数 entity；name、description、aliases 不改的填 null。锁定的设定不能改。
- delete_entity：删除设定（需要作者确认）。参数 entity。
- add_fact：记一条事实，作为“候选”交给作者在事实页确认。参数 kind（world 世界事实、belief 某人的认知）；content；holder：belief 的持有人；subjects：涉及的设定列表，可为 null。
人物关系（人物与人物、人物与组织之间的关系网，写手写章时会带上出场人物的关系）：
- add_relationship：新建一条关系，读作“from 是 to 的 label”（例如 from 青崖老人、to 沈砚、label 师父）；双方相同的关系（朋友、同门）mutual 为 true，读作“from 与 to：label”。参数 from、to（设定的名字或标识）；category（family 亲属、romance 情感、mentor 师承、ally 友盟、rival 竞争、enemy 敌对、affiliation 从属、other 其他）；label（称谓，简短）；mutual；description：来历与现状，可为 null；secret：读者还不知道这层关系时为 true（写手只暗示不点明）；validFrom、validTo：从哪一章起、到哪一章止成立（关系会变，例如结盟后反目），不限时为 null。
- update_relationship：修改一条关系。参数 relationship（关系的标识，见当前状态）；其余参数同 add_relationship，不改的填 null；validFrom、validTo 填“不限”表示取消章节限制。
- delete_relationship：删除一条关系（需要作者确认）。参数 relationship。
作者偏好（写手写每一章都会遵守）：
- remember_preference：记下作者明确说出的一条文风偏好或禁忌（例如“对白要短”“不要写心理独白”“主角不说脏话”）。只记作者说过的话，不从改稿里推测；与已记下的重复时不要再记。参数 preference（一句话）。
- add_avoid_phrases：把作者不想在正文里看到的说法加进规避词表，审核时会逐处标出。参数 phrases（词语列表）。
计划与写作：
- save_chapter_plan：写入或替换一章的章节计划。参数 chapter；goal（本章目标）；beats（情节点，按顺序）；cast（出场人物的名字列表，可为 null）；targetWords（字数，可为 null）。
- plan_chapters：由作品大纲生成全书的章节计划草稿并采用（会覆盖已有的计划，作品已有计划时需要作者确认；10 章及以上自动分卷）。参数 count（章数）；wordsPerChapter（每章字数，可为 null，默认 3000）。
- write_chapter：让写手按章节计划把一章写进正文（写入前自动保存快照，可一键回退；这一章须有计划且还没写过）。这一轮对话会等它写完，适合只写一章。参数 chapter。
- write_chapters：把几章交给写手在后台依次写（每章写完整理长篇记忆，review 为 true 时接着审核）。动作立即返回，写作在后台进行，进度出现在当前状态的“正在进行的任务”里；写两章以上或“写完全书”时用它。参数 chapters：章节列表，null 为所有有计划、还没写完的章节；review。
- continue_chapter：接着一章已有的正文续写一段，结果作为候选稿，作者在章节旁的“AI 写作”里接受。参数 chapter；instruction：续写的要求，可为 null。
- edit_selection：修改作者在正文里选中的那段文字（见“当前状态”里的“作者选中的文字”；没有选中时不能用），结果作为候选稿，作者对照差异后接受。参数 operation（rewrite 改写、expand 扩写、shorten 缩写、polish 润色）；instruction：具体要求，可为 null。
- review_chapter：审核一章（程序检查加模型审核：规避表达、提前说破、到期未回收的伏笔、人物与设定前后不一等），问题列在章节旁的“审核”里。这一轮对话会等它审完。参数 chapter。
- review_chapters：把几章交给后台依次审核（问题照样列在各章旁的“审核”里）。动作立即返回，审核在后台进行，进度出现在“正在进行的任务”里；审两章以上或“审核全书”时用它。参数 chapters：章节列表，null 为所有已经写好的章节。
- rollback_writer：把一章回退到写手写入之前（需要作者确认；现稿会先存为快照）。参数 chapter。
- add_foreshadow：在伏笔账本里记一条伏笔，写手与审核都会照着它。参数 title（简短的名字）；content（伏笔是什么）；reveal：揭晓之前不得说破的内容，可为 null；plant：在哪一章埋下，可为 null；payoff：在哪一章回收，可为 null。
导出：
- export_book：导出正文，软件会请作者选择保存位置。参数 format（txt 或 markdown）；chapter：只导出这一章，null 为整本。
界面：
- open_page：打开一个页面。参数 page：book 成书、planning 计划、settings 设定、relations 人物关系、facts 事实、simulation 推演、search 查找、skills 写作技能、usage 用量与费用、tasks 任务。

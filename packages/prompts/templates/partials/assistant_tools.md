读取（不改动作品）：
- list_chapters：列出章节（标识、章名、所在的卷、字数、计划状态）。参数 volume：只列这一卷（卷的标识或卷名），null 为全部。
- get_work：看作品信息的全文：简介、大纲、各卷简介与全部人物关系（当前状态只列出了一部分或截短时用）。没有参数。
- read_chapter：读一章的正文（很长时只给开头与结尾）。参数 chapter。
- search_text：在全书正文中查找文字。参数 query。
- get_entity：看一项设定的详细内容。参数 entity。
- list_facts：列出事实记录。参数 about：只列涉及这项设定的（标识或名字），null 为全部。
- get_chapter_plan：看一章的章节计划。参数 chapter。
- build_chapter_memory：按现在的正文重新整理一章的长篇记忆（改过正文、修订过问题之后，记忆会过时）。参数 chapter。
- get_chapter_memory：看一章的长篇记忆（写完后整理的梗概、人物状态、伏笔进展与章尾留给后面的事），比读全文省得多；问“前面写了什么”时先看它。参数 chapter。
- list_foreshadows：列出伏笔账本（标识、内容、不得说破的内容、埋设与回收的章节、状态），以及该改状态的建议。参数 chapter：只列在这一章埋设或回收的，null 为全部。
- list_review_issues：列出待处理的审核问题（标识、严重程度、说明、建议、原文）。参数 chapter：只列这一章的，null 为全书有问题的各章。
- list_skills：列出写作技能（名称、阶段、是否启用、适用说明）。参数 stage：planning 规划或 writing 写章节，null 为全部。
- web_search：联网搜索公开的网页（榜单、书的简介与评论、资料），返回标题、网址与摘要；要作者先在“模型服务”页配好搜索服务，没配时结果会说明。参数 query。
- read_web_page：读一个公开网页的正文（太长时只给开头与结尾）。参数 url：搜索结果里的网址，或作者给的网址。
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
- set_skill：启用或停用一项写作技能（作者说“别用雪花写作法”“打开不用副词”时）。参数 skill（技能名称）；enabled。
计划与写作：
- save_chapter_plan：写入或替换一章的章节计划。参数 chapter；goal（本章目标）；beats（情节点，按顺序）；cast（出场人物的名字列表，可为 null）；targetWords（字数，可为 null）。
- plan_chapters：由作品大纲生成全书的章节计划草稿并采用（会覆盖已有的计划，作品已有计划时需要作者确认；10 章及以上自动分卷）。参数 count（章数）；wordsPerChapter（每章字数，可为 null，默认 3000）。
- write_chapter：让写手按章节计划把一章写进正文（写入前自动保存快照，可一键回退；这一章须有计划且还没写过）。在后台写：动作结果说“已排上”就是开始写了，写完的结果出现在之后的当前状态里（“后台刚做完的”）；结果里没说排上的（例如测试环境），就是这一轮等它写完了。参数 chapter。
- write_chapters：把几章交给写手在后台依次写（每章写完整理长篇记忆，review 为 true 时接着审核）。动作立即返回，写作在后台进行，进度出现在当前状态的“正在进行的任务”里，这一批结束时（写完、停下或出错）怎样结束的出现在“后台刚做完的”里；写两章以上或“写完全书”时用它。参数 chapters：章节列表，null 为所有有计划、还没写完的章节；review。
- continue_chapter：接着一章已有的正文续写一段，结果作为候选稿，作者在章节旁的“AI 写作”里接受。参数 chapter；instruction：续写的要求，可为 null。
- edit_selection：修改作者在正文里选中的那段文字（见“当前状态”里的“作者选中的文字”；没有选中时不能用），结果作为候选稿，作者对照差异后接受。参数 operation（rewrite 改写、expand 扩写、shorten 缩写、polish 润色）；instruction：具体要求，可为 null。
- review_chapter：审核一章（程序检查加模型审核：规避表达、提前说破、到期未回收的伏笔、人物与设定前后不一等），问题列在章节旁的“审核”里。和 write_chapter 一样在后台审，审完的结果出现在之后的当前状态里。参数 chapter。
- review_chapters：把几章交给后台依次审核（问题照样列在各章旁的“审核”里）。动作立即返回，审核在后台进行，进度出现在“正在进行的任务”里，审完或停下时的结果出现在“后台刚做完的”里；审两章以上或“审核全书”时用它。参数 chapters：章节列表，null 为所有已经写好的章节。
- stop_background：停下后台的写作、依次审核、一键修订、推演或写作工作流（写手正在写的这一段不再写下去，已写完的段落保留，可以接着写；一键修订正在改的那一条不写入，已改好的保留；推演停在当前这一步之后，可以继续；工作流停在当前这一步，继续时从这一步做起）。只在作者要求停下时用。参数 what：writing 写作、review 审核、revision 一键修订审核问题、simulation 推演、workflow 工作流、all 全部。
- resolve_review_issue：处理一条审核问题：fixed 标为已改好，ignored 忽略。参数 issue（问题的标识，见 list_review_issues）；status。
- revise_review_issue：把一条审核问题交给写手修订问题所在的那一段（写入前自动保存快照；同一段上其他问题一并修订）。和 write_chapter 一样在后台改，改完的结果出现在之后的当前状态里。参数 issue。
- revise_review_issues：一键把一章、几章或全书待处理的审核问题逐条交给写手修订（同一段上的问题一次改；前一条改了段落后，后面的问题重新定位，定位不到或依据过期的跳过；针对整章的问题跳过；每章改之前存一份快照，可以撤销）。在后台进行，进度在“正在进行的任务”里，做完的那句话（修订了几条、跳过几条、失败几条和原因）出现在“后台刚做完的”里。不止一章时软件先把条数与预计费用给作者确认。作者说“把这些问题都改了”“一键修订”“全书的问题交给写手”时用它；只改一两条用 revise_review_issue。参数 chapters：章节列表，null 为全书有待处理问题的章节；severities：要修的严重程度（high 严重、medium 中等、low 轻微），null 为全部，作者没说时按作者的意思选，“只改要紧的”就是 high 与 medium。
- rollback_writer：把一章回退到写手写入之前（需要作者确认；现稿会先存为快照）。参数 chapter。
- add_foreshadow：在伏笔账本里记一条伏笔，写手与审核都会照着它。参数 title（简短的名字）；content（伏笔是什么）；reveal：揭晓之前不得说破的内容，可为 null；plant：在哪一章埋下，可为 null；payoff：在哪一章回收，可为 null。
- update_foreshadow：修改账本里的一条伏笔，或改它的状态（planned 计划中、planted 已埋下、paid_off 已回收、dropped 放弃）。参数 foreshadow（标识或名字）；title、content、reveal、plant、payoff、status 不改的填 null；plant、payoff 填“无”表示清除章节。
角色推演（每个角色只按自己知道的信息行动，程序裁决结果；用来试一个局面会怎样发展，再挑一个角色的视角写成正文）：
- list_simulations：列出推演场景（标识、场景名、角色）与每个场景的推演（标识、状态、回合、费用）。参数 scene：只列这个场景的（标识或场景名），null 为全部。
- create_sim_scene：由一段局面描述生成推演场景并保存（保存前按规则校验，不合格时不保存、返回问题）。描述写清：在哪里（几个区域、彼此能否看见听见）、有谁、各自想要什么、谁知道什么秘密、有哪些关键物品；可以先看章节计划与人物设定再写。参数 description；title：场景名，可为 null；chapter：关联的章节，可为 null；maxRounds：回合上限，null 为 8。
- start_simulation：用一个场景开始一次推演，在后台连续推进到结束（会按回合调用模型；裁决自动接受，采纳进作品前由作者复核）。动作立即返回，进度出现在“正在进行的任务”里。参数 scene；budgetUsd：费用上限（美元），null 为不设（模型没有配置价格时不能设）。
- continue_simulation：让暂停或停下的推演在后台接着推进。等待作者确认裁决或决定导演提议时不能继续，请作者到推演页处理。参数 run（推演的标识）。
- get_simulation：看一次推演的状态与全局概要（每回合谁做了什么、说了什么，结束原因、费用，等作者处理的事）。这是作者视角的全貌，只用来向作者汇报与做计划。参数 run。
- narrate_simulation：按一个角色的视角，把一次推演中已经结束的回合写成正文，作为候选稿放在这一章末尾；只用这个角色当时知道的信息。候选稿要作者在章节旁的“AI 写作”里用“采纳…”写进作品，不能直接接受。参数 run；pov：视角角色（名字或键）；chapter：写进哪一章；fromRound、toRound：回合范围，null 为从第 1 回合到最后一个结束的回合。
写作工作流（按固定的步骤依次做完一件大事，每步的结果存在作品里，作者可以看、改、采用，可以停下、接着做、重做或跳过一步）：
- list_workflows：列出可用的工作流（名称、说明、步骤）与这部作品的运行（标识、状态、停在哪一步）。没有参数。
- start_workflow：开始一个工作流，在后台推进。quick_book 一键成书：检查模型 → 由想法生成大纲与人物 → 拆章节计划（30 章以上先定全书卷纲、再逐卷拆章）→ 写手写完并审核 → 导出（导出须作者自己点）。作者没说章数或每章字数时不要发起，先问清楚（分几卷也顺带问；不说就按故事自动分）。book_audit 全书体检：补齐长篇记忆 → 依次审核 → 伏笔核对 → 由各章记忆找跨章的疑点 → 逐条读两章原文定位到段落（问题列在后一章的“审核”里）→ 体检报告；作者要“检查全书前后矛盾”“体检一下”时用。next_volume 续写一卷：补齐最近几章的长篇记忆 → 下一卷的卷纲（卷名、主线、新人物与伏笔）→ 只给这一卷拆章节计划 → 写手写完并审核 → 本卷体检；作者要“接着写下一卷”“再写一卷”时用。opening_polish 开篇打磨：算出前几章的客观数字（主角第几字出场、对白占比、前一千字的设定名）→ 按开篇的要求逐章诊断（问题列在各章的“审核”里）→ 作者处理问题（须作者自己在成书页点“处理完了”）→ 复诊 → 对比前后；作者要“打磨开头”“看看黄金三章”时用。cast_completion 人物补全：补齐长篇记忆 → 找出说明为空、出场却没有关系的人物 → 写人物小传与关系的草稿（包括正文里有、还没建卡的人物）→ 作者勾选后采用（只增不改，锁定的不动）；作者要“把人物卡补全”“理一下人物关系”时用，没有参数。mode：step 每步停下给作者看（草稿要作者在成书页采用），auto 一路做完（草稿直接采用；会替换已有大纲或覆盖已有计划时仍停下等作者）。动作立即返回，进度出现在“正在进行的任务”里，停下时停在哪里出现在“后台刚做完的”里。会按步骤调用模型，开始前在 message 里说一句。参数 workflow；mode；budgetUsd：费用上限（美元），null 为不设；idea：一句话的想法（已有大纲、不需要生成时可为 null）；genre：类型，可为 null；chapters：章数（quick_book 必填，最多 2000；next_volume 为这一卷的章数，null 为 20；opening_polish 为诊断前几章，null 为 3）；wordsPerChapter：每章字数（quick_book 必填；next_volume null 为 3000）；volumes：卷数，只用于 quick_book：null 为按故事自动分，1 为不分卷，2 以上为指定卷数（idea、genre 只用于 quick_book，chapters 用于 quick_book、next_volume 与 opening_polish，wordsPerChapter 用于 quick_book 与 next_volume，其他填 null）；instruction：给这一卷的要求，可为 null（只用于 next_volume）；from、to：体检的起止章节，null 为从头、到尾；rereview：已审核过的章节也重新审核，null 为否（这三项只用于 book_audit，其他工作流填 null）。
- get_workflow：看一次运行的各步状态与结果的概要。参数 run：运行的标识，null 为最近的一次。
- continue_workflow：让停下、中断或等作者的运行在后台接着推进。adopt 为 true 时先按原样采用正在等作者的那一步（作者说“就这样”“采用”时）；须作者确认的覆盖，作者在对话里明确同意了才用 adopt。出错或可能过时的步骤要作者在成书页决定重做、跳过或保留。参数 run；adopt。
撤销：
- undo_last_turn：撤销上一轮（作者上一句话）里你对作品做的改动：新建的设定、关系、卷、章节、计划、伏笔与候选事实删掉，改过的改回去，删掉的设定、关系与卷重建，写手写的章回退到写入之前，写手的修订恢复到修订之前。之后又被改过的不动；候选稿、审核结果、推演记录、新建的作品不在撤销范围。只在作者要求撤销时用；再用一次撤销更早的一轮。没有参数。
导出：
- export_book：导出正文，软件会请作者选择保存位置。参数 format（txt 或 markdown）；chapter：只导出这一章，null 为整本。
界面：
- open_page：打开一个页面。参数 page：book 成书（写作工作流）、planning 计划、settings 设定、relations 人物关系、facts 事实、simulation 推演、search 查找、skills 写作技能、usage 用量与费用、tasks 任务。

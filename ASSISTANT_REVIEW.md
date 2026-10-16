# AI 助手评估（2026-10-16）

本文件评估“复调”的 AI 助手（需求 B69、B71、B77，任务 M5-01 至 M5-16）：现在能做什么、怎样实现、真实模型试用的结果、已修正的缺陷、仍然存在的问题与建议的下一步。接手的开发者（或换了账号的 AI 编程助手）先读本文件，再读 AGENTS.md 的“当前状态”。

## 一、结论

- 助手已经可以用平常的话驱动整本书的流程：开新书、人物与关系、大纲与章节计划、伏笔、写章（单章同步、多章交给后台）、审核与处理问题、问前文、记偏好、启停技能、停下与续写后台任务、导出。两次真实模型试用（中转站的 deepseek-flash，14 句对话）中，每一句都选对了动作，删除与覆盖类的动作都先请作者确认，后台任务的进度如实汇报。
- 试用暴露的 6 处缺陷已修正并合并（M5-16，提交 b966a25）。其中第 3 至 6 项（须确认动作之后的动作、过时的审核问题、重新整理记忆、没看就下结论）**还没有用真实模型验证**，下一步先跑一次试用。
- 主要短板不在“会不会调动作”，而在：不能操作推演（产品的核心创新）、改动没有统一的撤销、单章审核与修订会挡住对话、模型偶尔编造细节、写手的文笔（按作者决定，以后再磨）。

## 二、现在的样子

### 架构

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 输出结构 | `packages/prompts/src/assistant.ts` | 每一步输出 `message`、`actions`（以 `tool` 区分的可辨识联合，共 58 个动作）、`done`；结构化输出管线校验 |
| 提示词 | `packages/prompts/templates/assistant_turn.md`（版本 12）与 `partials/assistant_tools.md`、`assistant_state.md`、`assistant_results.md`、`assistant_request.md` | 系统提示（规则与动作说明）不变、可缓存；之前的对话只追加；最后一条消息是现状与最新的请求或动作结果 |
| 对话循环 | `apps/desktop/src/app/assistant.ts` | 一轮最多 12 步；须确认的动作停下，排在后面的动作随它保存（`rest`），确认后接着执行；走满步数或停止时说明；之前几轮的动作结果截到 600 字，对话超过 60 条或 4 万字时从最早的一轮截断；对话按作品存进 `assistant_message` |
| 撤销 | `apps/desktop/src/app/assistant-undo.ts` | 改结构的动作前后取现状、记下差别（对话里的 `changes` 记录），撤销时倒着改回；之后又改过的不动 |
| 动作的命令表 | `apps/desktop/src/app/assistant-tools.ts` | 每个动作：界面名称、是否须确认、撤销方式、执行（只调用现有用例，锁定设定、快照、版本守卫、回收站照常生效）；`BackgroundJobs` 由状态层实现（写手队列、依次审核、推演、停下） |
| 界面 | `apps/desktop/src/ui/AssistantPanel.tsx`，状态层 `src/state/store.ts` 的 `assistantTurn` | 逐字显示、进展、选区条、确认卡片、模型与思考深度选择、上下文用量；每一轮登记为任务 |
| 试用脚本 | `tools/assistant-eval/`（`pnpm assistant:eval`） | 14 句作者会说的话，真实模型，报告写在 `m3/runs/`（不入库） |

### 动作一览（58 个）

- 读取：`list_chapters`、`read_chapter`、`search_text`、`get_entity`、`list_facts`、`get_chapter_plan`、`build_chapter_memory`、`get_chapter_memory`、`list_foreshadows`、`list_review_issues`、`list_skills`
- 作品与卷：`create_work`、`open_work`、`update_work`（替换已有大纲须确认）、`create_volume`、`update_volume`、`move_volume`、`delete_volume`（须确认）
- 章节：`create_chapter`、`update_chapter`、`move_chapter`、`trash_chapter`（须确认）、`open_chapter`、`restore_chapter`、`save_snapshot`
- 设定与事实：`create_entity`、`update_entity`、`delete_entity`（须确认）、`add_fact`（候选，作者在事实页接受）
- 人物关系：`add_relationship`、`update_relationship`、`delete_relationship`（须确认）
- 偏好与技能：`remember_preference`、`add_avoid_phrases`、`set_skill`
- 计划与写作：`save_chapter_plan`、`plan_chapters`（已有计划时须确认）、`write_chapter`（同步，写完整理长篇记忆）、`write_chapters`（后台）、`continue_chapter`（候选稿）、`edit_selection`（候选稿）、`review_chapter`（同步）、`review_chapters`（后台）、`stop_background`、`resolve_review_issue`、`revise_review_issue`（写入前快照）、`rollback_writer`（须确认）、`add_foreshadow`、`update_foreshadow`
- 角色推演（M5-19）：`list_simulations`、`create_sim_scene`、`start_simulation`（后台）、`continue_simulation`（后台）、`get_simulation`（全局概要，只用于汇报）、`narrate_simulation`（按视角写成候选稿，作者经“采纳…”写进作品）
- 撤销（M5-20）：`undo_last_turn`；对话框里另有“撤销这一轮的改动”
- 其他：`export_book`、`open_page`

### 自动测试

`apps/desktop/src/app/assistant.test.ts`（20 项）、`assistant-tools.test.ts`（须确认的动作恰好是删除与覆盖类）、`packages/prompts/src/assistant.test.ts`（动作说明与结构一致、提示词的排列）、`src/ui/app.test.tsx` 中的助手用例。全部用排好的模型回复，不联网。

## 三、真实模型试用

命令（Key 运行时在终端里输入，不写进文件；也可以用 `--config m3/eval/config.json`）：

```bash
pnpm assistant:eval --base-url https://example.com/v1
```

14 句话：开新书并建三个人物与关系 → 简短大纲与 3 章计划 → 记一条伏笔（第一章埋、第三章揭）→ 写第一章 → 审核 → 挑最要紧的问题交给写手、其余酌情忽略 → 问第一章写了什么、伏笔埋没埋 → 对白要短、规划别用雪花写作法 → 剩下两章交给后台写并审核 → 问进度 → 停下 → 接着写、不审核 → 问全书写完没有 → 新建一章再删掉（须确认，同意）。

| 次数 | 结果 | 用量 |
| --- | --- | --- |
| 第一次 | 跑到第 11 句时试用脚本自己出错（后台批次结束时读进度），已修正；发现缺陷 1、2 | 未统计 |
| 第二次 | 14 句全部走完，3 章共约 5,600 字；发现缺陷 3 至 6 | 作品库记下 38 次调用，输入约 7.3 万、输出约 5.5 万 Token，按内置的 deepseek-flash 价格约 $0.09（作品建好之前的几步与能力自检不在作品库的记录里；中转站实际怎么收费不清楚） |

报告：`m3/runs/assistant-2026-10-16T00-54-30-615Z/report.md`（本机，不入库）。

## 四、已修正的缺陷

| # | 现象（试用中看到的） | 原因 | 修正 |
| --- | --- | --- | --- |
| 1 | 问“第一章写了什么”，助手说还没有长篇记忆，只能读全文 | `write_chapter` 只调写手，不整理记忆（成书进度写章会整理） | 写完接着 `buildMemory`，进展里显示“正在整理长篇记忆” |
| 2 | 伏笔记在账本里写明第一章埋，写手没有埋 | 计划先做好、伏笔后记；写手只认计划里列的伏笔 | `packages/writing` 的 `foreshadowsForChapter` 并入账本里写明在本章埋设（状态为计划）或回收（未回收、未放弃）的伏笔，审核同一规则 |
| 3 | 第 2 句：替换大纲须确认，排在后面的三份章节计划和一条偏好没有执行；模型误以为“没有章节”，还声称记了偏好 | 停在确认时，同一步后面的动作被丢掉，模型不知道 | 后面的动作随等待确认的一条保存（`rest`），确认后接着执行；拒绝或作者接着说了别的，逐条写明“没有执行” |
| 4 | 修订后忽略两条问题，回报“已忽略”，计数却没变 | 修订后程序检查重新标出、换了标识；旧标识已不在待处理里，什么也没改却报成功 | `resolveIssue` 对不在待处理里的问题返回原因；修订结果提示先 `list_review_issues` |
| 5 | 助手说“长篇记忆过时，我没法刷新” | 没有对应动作 | 新动作 `build_chapter_memory`；修订结果提示记忆已过时 |
| 6 | 写完第一章，助手说“玉佩按账本埋下了”，审核却发现没埋 | 没看正文就替写手下结论 | `assistant_turn` 版本 9：写了什么、埋没埋下、改没改好，看过正文、记忆或审核结果再说 |

更早的修正（M5-12、M5-13、M5-15）：后台任务不被打断；助手不再声称在后台做了没做的事；多章写作与审核交给后台；能看审核问题、伏笔账本、长篇记忆与写作技能；能停下后台任务；走满步数时说明。

## 五、仍然存在的问题

按建议的处理先后排列。

1. **第 3 至 6 项修正没有经过真实模型验证。** 先跑一次 `pnpm assistant:eval`，读报告确认：第 2 句的计划与偏好是否在确认后落地；第 6 句是否先列问题再处理；第 7 句是否在记忆过时时重新整理；第 4 句是否不再自称伏笔已埋。
2. **助手不能操作推演。** 已处理（M5-19）：建场景、后台推演、全局概要、按视角写成候选稿；确认裁决、导演提议与采纳仍由作者在界面上做。没有经过真实模型验证。原来的描述： 推演场景的建立、开始、单步与继续、待核实裁决的确认、写成正文与采纳都只能在“推演”页手动做。这是产品的核心创新，助手却完全碰不到。建议先做读取与发起（列出场景、从章节计划草拟场景、开始一次推演交给后台、汇报进度与结果），确认与采纳仍由作者在界面上做。动作结果只能给全局局面的概要，不能把角色视图之外的内容交给写正文的环节（硬性规则 1 至 3）。
3. **改动没有统一的撤销。** 已处理（M5-20）：对话框的“撤销这一轮的改动”与 `undo_last_turn`。原来的描述： 正文有快照，但设定、关系、计划、伏笔、作品信息被助手改了以后不能一键回到改之前。建议给助手的每一轮记下改动前的值（或在一轮开始前给相关表做轻量快照），提供“撤销助手刚才的改动”。
4. **单章审核与修订挡住对话。** `review_chapter`、`revise_review_issue`、`write_chapter` 在对话里同步等待，期间作者不能再说话。可以考虑统一走后台，对话里只汇报“已排上”，完成时在下一句话的现状里看到结果。
5. **模型偶尔编造细节。** 第二次试用第 13 句说这本书“约 30 章”，大纲里没有。已处理（M5-17）：现状给出全书字数与有计划的章数，`assistant_turn` 版本 10 要求数字与事实只用现状与动作结果里有的。没有经过真实模型验证。
6. **发出请求前不检查上下文上限。** 现在只靠条数与字数截断对话，现状部分（章节、设定、关系列表）在大部头作品里可能很长。建议按模型的 `contextWindow` 估算，超出时进一步缩减现状与历史。
7. **作品建好之前的调用没有记进作品库。** 用量页与试用报告的统计因此偏低。可以把这些调用记进应用设置库，或在作品建好时补记。
8. **写手的文笔。** 第一次写第一章时玉佩只含糊带过，靠审核与修订补上。按作者决定（先做完软件，正文质量以后再磨），暂不处理。
9. **“停下后台任务”的界面层没有自动测试。** 已处理（M5-18）：`src/ui/app.test.tsx` 用挂起的模型回复让写手停在第一章，经助手的 `stop_background` 停下，核对没写完的一段不写入、第二章不开写、任务记为已取消、没有多发请求。
10. **试用只覆盖一条路径。** 没有试过：打开已有的大部头作品、分卷、选区修改、续写、导出、拒绝确认、模型输出不合格时的修正、网络中断重试。可以给 `tools/assistant-eval` 增加几组对话（`DEFAULT_TURNS` 之外的场景）。

## 六、接手时怎样继续

1. 读 AGENTS.md（规则、命令、当前状态）与本文件。
2. 跑 `pnpm check`，应当全部通过（2026-10-16：1,257 个测试）。
3. 用真实模型跑一次试用（费用很低，约 $0.1；运行前确认作者同意），验证第五节第 1 项。
4. 按第五节的顺序挑下一项，一项一个分支（例如 `m5-17-assistant-simulation`），提交信息以任务编号开头，快进合并到 main，不推送。

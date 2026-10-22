# AGENTS.md

本文件供所有在本仓库工作的 AI 编程助手阅读（Claude Code 经 CLAUDE.md 引入本文件，Codex 等工具直接读取）。规则对人类开发者同样适用。

## 项目简介

产品名“复调”（英文名 fudiao）：基于 Tauri 的中文长篇小说编辑器。核心创新是“有限情报下的角色行为推演”：每个角色代理只依据自己掌握的信息行动，程序统一裁决结果，作者把选中的事件写成正文。产品的根基是“谁在什么时候知道什么”的结构化记录与严格的信息隔离。

## 必读文档

| 文档 | 内容 | 何时读 |
| --- | --- | --- |
| [REQUIREMENTS.md](REQUIREMENTS.md) | 需求、术语表（第三章）、验收标准（第八章） | 实现任何功能前，查对应需求编号与验收项 |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | 技术选型、架构、数据模型、推演引擎、模型接入、任务分解（第八章） | 开始一个任务前，读该任务所在的里程碑与相关章节 |
| [DESIGN_PATTERNS.md](DESIGN_PATTERNS.md) | 设计模式、禁止的做法（第七章） | 设计模块结构、写核心代码前 |
| [ASSISTANT_REVIEW.md](ASSISTANT_REVIEW.md) | AI 助手的评估：现状、真实模型试用、已修正与仍存在的问题、建议的下一步 | 改动 AI 助手（`assistant*.ts`、`assistant_turn` 模板）之前 |

用词以需求文档第三章的术语表为准（推演场景、推演草案、候选稿、批量推演等），代码命名、界面文案与文档保持一致。

## 当前状态

- M0-01 已完成：pnpm 单仓库、TypeScript 严格模式、ESLint、Vitest、dependency-cruiser 与持续集成。各包只有空入口，`apps/desktop` 在 M1-01 创建。
- M0-02 已完成：`packages/domain` 的场景配置、区域图、世界状态与效果、规则原语、裁决、语义裁决范围校验、机关、感知计算、领域事件与回放。
- M0-03 已完成：角色卡与秘密、认知条目与二阶认知、人物说法、感知投影、认知更新校验、角色视图（`buildCharacterView`）、证据链筛选、金丝雀泄露测试（`packages/domain/src/cognition/leak.test.ts`）。
- M0-04 已完成：`packages/llm` 的模型端口、`AnthropicAdapter`、`OpenAIChatAdapter`、录制回放、结构化输出管线、预算守卫、步骤键调用记录与请求检查；适配器契约测试用不联网的 fetch 夹具。
- M0-05 已完成：`packages/prompts` 的模板渲染、九个模板（角色行动、规则拒绝、格式修正、认知更新、语义裁决、证据链判断、节拍表、候选稿正文、场景配置草稿）、输出 schema、模板版本锁与提示词金丝雀测试。
- M0-11 已完成：`m0/scenes/` 下的三个实验场景（仓库争夺密信、当铺谈判、雨夜道歉）与场景文件加载（`apps/m0-cli/src/scene-file.ts`）。
- M0-06、M0-08 已完成：`packages/engine` 的回合状态机、两种回合协议、交互与自动模式、暂停停止与预算、作者介入与分支、证据链提示、恢复与幂等；`packages/store` 的事件存储（内存版与 JSONL 文件版）与 JSONL 调用记录。故障注入、录制回放端到端与引擎金丝雀测试均已就绪。
- M0-09 已完成：`pnpm m0` 的 run、baseline、narrate、motive-check；实验配置 `m0/experiments/default.yaml`；运行前费用估算与确认。report 在 M0-12。
- M0-10 已完成：`pnpm m0 view <运行标识>` 由运行记录生成单个 HTML 查看页（时间线、全局局面、角色所见），只读事件、不调用模型。
- M0-12 已完成：`pnpm m0 report` 按清单生成评估包（均衡分配、隐藏来源、答案键单独存放、分层评分表），`report analyze` 汇总评分；对照组与推演组都输出事件梗概。实验步骤见 `m0/README.md`。
- M0-07 已完成：僵局分类（程序判定观望与重复，僵局判断区分礼貌化解与目标无法达成）、导演提议（`stalemate` 与 `curve` 两种触发，导演只读全局局面）、`run --runs N --parallel P --director …` 与 `pnpm m0 outcomes` 走向归类。
- M1-01 已完成：`apps/desktop` 的 Tauri 2 外壳（React 19 + React Compiler、Vite），持续集成在 Windows 上运行 Rust 测试并生成 NSIS 安装包（内置 WebView2 引导程序）。产品名为“复调”，英文名 fudiao（应用标识 `com.fudiao.desktop`、可执行文件 `fudiao.exe`、工作区包 `@fudiao/*`）。
- M1-02 已完成：`packages/store` 的 `SqlPort`（批量事务与影响行数守卫）、Node 实现（better-sqlite3）与迁移执行器；Rust 的 `db_open`、`db_query`、`db_tx`、`db_close`（一个写连接加只读连接池、WAL、迁移前备份、迁移编译期嵌入）；两端共用 `packages/store/contract/sql-cases.json` 契约用例；桌面端适配器 `apps/desktop/src/adapters/tauri-sql.ts`。
- M1-03 已完成：第一版迁移 `packages/store/migrations/0001_init.sql`（作品、章节、段落、快照、设定、事实、来源关系、故事事件与事件段落关联，STRICT 表与约束）；故事时间领域类型（标签加排序键）；表结构清单 `packages/store/src/schema.ts` 与数据层导出导入（每张表一个 JSONL）及往返测试。
- M0-13（真实实验与 `m0/DECISION.md`）需要作者提供 API Key、确认费用并安排评价者。按施工文档，M1 的脚手架与存储部分可与 M0 并行；M1 的其余任务在 M0 结论为继续或调整后进行。作者决定（2026-10-07）：M0-13 的真实实验暂缓，M1 先行，不等 M0 结论。M1 的任务已全部完成，待作者执行手工清单；M2 与之并行推进。
- M1-04 已完成：作品列表（默认作品库“文档\复调”、打开其他位置的作品、归档、丢失提示）、作品信息与写作目标、章节目录（新建、重命名、拖动与上下移动排序、回收站与恢复）。分层为仓储（`packages/store/src/repos`）→ 应用服务层（`apps/desktop/src/app`）→ Zustand 状态（`src/state`）→ 界面（`src/ui`）；分数索引排序键与 ULID 在 `packages/shared`；界面测试用 jsdom 与 Testing Library 驱动真实用例；手工清单见 `apps/desktop/MANUAL_TESTS.md`。
- M1-05 已完成：正文编辑器（TipTap 3，doc > paragraph+，关闭按事务重渲染）；段落标识扩展 `packages/editor/src/paragraph-identity.ts`（拆分、合并、粘贴、撤销后的标识继承，输入法组合期间不改动文档）；保存计划 `packages/store/src/repos/paragraph-plan.ts` 与段落仓储（只写变化的段落、版本守卫、事件关联随拆合继承）；自动保存控制器 `apps/desktop/src/app/autosave.ts`；草稿与意外退出恢复；保存失败时复制全文与导出本章；字数统计 `countWords`（`packages/shared`）。
- M1-06 已完成：章节快照（`packages/store/src/repos/snapshot.ts`）的建立、列表、预览与恢复；恢复前自动把现稿存为快照；快照带来源标记与事件关联，恢复后标识、来源与关联正确；界面为章节的“保存快照”“版本快照”。
- M1-07 已完成：导入 TXT 与 Markdown（Rust 识别编码，`apps/desktop/src/app/text-import.ts` 拆分章节，预览后导入为新作品或追加章节）；导出整本或一章（TXT、Markdown）；作品包（`project-package.ts` 决定内容，Rust `transfer.rs` 打包与校验 zip）及导回；备份（`db/backup.rs`：自动、手动、恢复前，自动备份保留 30 份）与从备份原地恢复。
- M1-08 已完成：设定管理（`packages/store/src/repos/entity.ts`：人物、地点、组织、物品、世界规则，别名、说明与属性，锁定后作者须先解锁、自动流程不能修改）；正文设定名高亮与 Ctrl + 点击打开设定卡片（`packages/editor` 的匹配器与装饰扩展）；设定页的筛选与查找。
- M1-09 已完成：事实记录（`packages/store/src/repos/fact.ts`：世界事实、人物认知、人物说法；持有者、来源方式、相信程度、涉及的设定、适用章节与故事时间范围）；依据（设定与其他事实）与待复核的推导（`reviewStaleFacts`，沿依赖链传递并写明原因）；事实页与顶栏的待复核提示。
- M1-10 已完成：段落来源（`packages/store/src/repos/paragraph-source.ts`）按字符区间记录 AI 文字，保存时推导来源（改动超过生成原文的 10% 为“AI 生成后修改”，合并不同来源为“混合”，拆分各部分按区间判定）；来源统计（`source-stats.ts`）与“段落来源”页；正文左侧来源色条（`packages/editor/src/source-marks.ts`），开关在作品列表文件的偏好中。接受候选稿写入来源在 M2-06。
- M1-11 已完成：迁移 `0002_paragraph_search.sql`（FTS5 trigram 索引，触发器维护，派生表不导出）；`searchParagraphs`（3 字及以上走索引，1 至 2 字扫描段落）；查找页与 Ctrl+F，结果跳转并选中；较旧结构版本的作品包按 `UPGRADES` 转换后导入。
- M1-12 已完成：`tools/bench` 的测试集生成器（基础集 10 万字 40 章、连载规模集 200 万字 800 章，固定种子）与性能基准 `pnpm bench`；开发机上两档全部达标，结果见 `tools/bench/README.md`。
- M2-01 已完成：Rust 凭据代理 `src-tauri/src/net.rs`（`net_fetch` 流式转发、`net_cancel`、凭据与源绑定、只允许 https 或回环地址、不跟随重定向、按源限制并发；reqwest 用 native-tls）；`packages/llm` 的 `createProxyFetch` 与 `testConnection`、`connection_test` 模板；桌面端传输层 `adapters/tauri-net.ts`。凭据的系统存储在 M2-02。
- M2-02 已完成：凭据存储 `src-tauri/src/credentials.rs`（Windows 凭据管理器，凭据与源一起保存）；应用设置库 `app.sqlite`（`packages/store/app-migrations`、`packages/store/src/app/model-services.ts`）；应用层 `apps/desktop/src/app/model-services.ts`（服务、凭据、模型、默认模型、连接测试）与“模型服务”页。
- M2-02a 已完成：`OpenAIAdapter`（Responses API，`packages/llm/src/adapters/openai-responses.ts`），桌面端的 OpenAI 官方服务改用它；Gemini 走兼容模式；五类服务的适配器选择与连接测试（不联网）均有测试，适配器契约测试覆盖三个适配器、直连与经代理。
- M2-02b 已完成：适配器的 `listModels` 与“获取模型列表”；能力合并 `resolveModel`（内置能力与价格表 `builtin-models.ts` 首版为空，待核实后填写）；“能力与价格”编辑（来源记为用户编辑，改结构化输出方式须重新自检）；能力自检 `runSelfTest`、`self_test` 模板与期望内容。
- M2-03 已完成：迁移 `0003_llm_call.sql`；调用记录仓储 `packages/store/src/repos/llm-call.ts`（读写与用量汇总）；`withCallLog` 记录每次调用；桌面端调用器 `apps/desktop/src/app/model-runner.ts`（默认模型、调用记录、结构化任务的自检门槛、有限次修正与暂停原因）；“用量与费用”页。
- M2-04 已完成：`packages/context` 的写作上下文构建（候选收集、预算选入、清单与原因）；应用层 `apps/desktop/src/app/writing-context.ts`（按选区分开正文、设定提及、适用事实、预算）；章节旁的“AI 上下文”抽屉，可增减条目。
- M2-05 已完成：`selection_edit` 模板（版本 1）与 `renderSelectionEdit`；应用层 `selection-ops.ts` 与用例 `runSelectionOperation`（按上下文清单组合提示词，经调用器流式生成）；章节旁的“AI 写作”抽屉（五种操作、附加要求、流式结果、取消、重试、复制）。
- M2-06 已完成：迁移 `0004_candidate.sql`；候选稿仓储 `candidate.ts` 与按范围替换 `paragraph-range.ts`（版本守卫、事件关联、来源区间）；逐字差异 `textDiff`（`packages/shared`）；应用层 `candidates.ts`（存为候选稿、修改、放弃、接受时检查过期、快照、写入来源）；“AI 写作”抽屉中的候选稿（差异、修改、接受、放弃）。
- M2-07 已完成：任务记录 `apps/desktop/src/app/tasks.ts`（进度、部分结果、已知用量与费用）；选区操作登记为任务；顶栏“任务”与任务页（取消、复制部分结果、清除）。M2 的任务已全部完成，待作者执行手工清单与真实模型的验证。
- M0-13 进行中（分支 `m0-13-experiment`）：DeepSeek flash 的真实实验已完成（三个场景各 4 种条件、每种 3 次，共 $14.65），27 次推演已生成正文；实验中修正的问题、实测费用与等待见 `m0/DECISION.md`。评估清单 `m0/evaluation/round1.yaml`（39 篇，`batch_pick` 由作者委托 Claude 代选）已备好，`m0/DECISION.md` 附门槛建议值。作者决定（2026-10-09）第一轮以作者本人盲评为主（`m0/packets/round1-self/`，12 篇梗概），外部写作者补充（`round1-external`，招募文案 `m0/evaluation/external-recruit.md`）；评估包支持只看梗概、只打部分评分项。实际由 4 个模型评了梗概层，推演组未达门槛、低于对照组；作者确认 M0 结论为“调整”（2026-10-09），调整清单见 `m0/DECISION.md` 第五节；第 1 至 5 项已实施（场景时钟 `clock`、角色行动模板第 8 版与 `triggered`、反复拉锯 `circling`、梗概取舍、仓库后墙），第二轮实验待作者确认费用后进行。
- 作者决定（2026-10-09）：新增写手代理与审核代理以快速成书（需求 B59 至 B66，需求文档 v0.8、施工文档 v0.4）。新的 M3 为写手与审核，原 M3 角色推演原型顺延为 M4；写手写入草稿章节不经候选稿，以来源标记与写入前快照保证可追溯、可回退（硬性规则 21 已相应修改）。
- M3-01 已完成：迁移 `0005_writing.sql`（伏笔账本、章节计划、写作技能、长篇记忆、审核问题；快照增加“写手写入”原因）；仓储 `foreshadow.ts`、`chapter-plan.ts`、`writing-skill.ts`（内置技能登记 `ensureBuiltinSkills`）、`chapter-memory.ts`（`reviewStaleMemories`）、`review-issue.ts`（`reviewStaleIssues`）；导出导入往返与 Rust 迁移测试已更新。
- M3-02 已完成：`packages/writing`（纯函数，依赖边界与 ESLint 规则同领域内核）：`foreshadowsForChapter`（本章要埋、要收、不得说破的伏笔）、`checkPlan`、`nextChapterToWrite`；`composeSkills`（内置技能按模板顺序、作者改动优先、记录来源与版本）；审核的程序检查 `runProgramChecks`（规避表达、揭晓内容提前说破、到期未回收的伏笔、计划中的人物未出场）。
- M3-03 已完成：八项内置写作技能（`packages/prompts/templates/skills/`，`BUILTIN_SKILLS`，版本锁记为 `skill:键`）；作品的规避词表 `project.avoid_phrases`（为空时用 `DEFAULT_AVOID_PHRASES`）；用例 `apps/desktop/src/app/writing-skills.ts` 与“作品 → 写作技能”页（启用、改写、恢复、自定义技能、规避词表）。
- M3-04 已完成：`plan_draft` 模板（版本 1，输出 `PlanDraftOutput`）；用例 `apps/desktop/src/app/planning.ts`（计划视图与问题、生成草稿、采用草稿、计划与伏笔的编辑）；顶栏“计划”页（草稿、章节计划、伏笔账本）；任务种类增加 `plan_draft` 等；测试辅助 `src/testing/models.ts`。
- M3-05 已完成：`writer_chapter` 模板（版本 1）；`packages/writing` 的 `planSegments`、`splitParagraphs`；`chapter_plan.progress` 与仓储 `writer-segment.ts`（一段的段落与进度在同一事务写入，以段落数与版本之和为守卫）；用例 `apps/desktop/src/app/writer.ts`（`writeChapter` 分段写、续写不重复调用，`rollbackWriter` 回退到写手写入前）；章节页“让写手写这一章”（写作期间正文只读），计划页的写手操作与连续写多章。
- M3-06 已完成：`chapter_memory` 模板（版本 1，输出 `ChapterMemoryOutput`）；用例 `apps/desktop/src/app/memory.ts`（`buildMemory`：梗概、人物状态、伏笔进展，记录依据的段落版本与调用记录）；计划视图先标出待复核的记忆；写手模板升到版本 2，带人物最近的状态与要回收伏笔的进展；写手写完一章后自动生成记忆，计划页可查看、生成与重建。
- M3-07 已完成：`chapter_review` 模板（版本 1，输出 `ChapterReviewOutput`）与 `writer_revise` 模板（版本 1）；`packages/writing` 的 `resolveModelIssues`（标签换回标识，定位不到原文或依据不存在的问题丢弃）与 `dropHandled`；仓储 `replacePendingIssues`、`countPendingIssues`；用例 `apps/desktop/src/app/review.ts`（`reviewChapter` 程序检查加模型审核、`resolveIssue`、`reviseIssue` 交给写手修订一段）；章节页的“审核”抽屉。
- M3-08 已完成：成书流程看板 `apps/desktop/src/ui/PipelineBoard.tsx`（“计划”页的“成书进度”：按章显示计划、写作、长篇记忆与审核，写下一章、依次写完、排定一段章节、写完后审核、单章审核与查看问题）；状态层的 `writeChapters(ids, { review })`、`reviewFromBoard`、`openChapterReview`。
- M3-09 的工具已完成、真实评估待作者执行：评估脚本 `tools/m3-eval/`（`pnpm m3:eval`，走完全流程并统计植入问题的检出率，运行前显示预计费用并确认）；短篇材料与植入的问题 `m3/eval/book.json`，步骤见 `m3/README.md`，结果记入 `m3/RESULTS.md`；`chapter_review` 模板升到版本 2（先判断视角人物，带上详略说明）。M3 的任务代码已全部完成，待作者执行真实评估与手工清单。
- M3-09 试跑后的调整（2026-10-13，两章，DeepSeek flash）：评估报告写明模型审核没有完成的章节并重试一次，不计入检出率；输出上限的思考余量 `THINKING_ALLOWANCE` 提到 32,000；`chapter_review` 版本 3（只标“不得说破”的伏笔不要求在本章出现）；`writer_chapter` 版本 3（设定是约束，不是要逐条写进正文的清单）；`proxy-fetch` 在读取方放弃响应体后丢弃迟到的事件。
- M3-09 真实评估已执行一次（2026-10-13，DeepSeek flash，六章）：流程走通，6 处植入全部检出，$0.218，结果与发现见 `m3/RESULTS.md`，“读后的判断”待作者填写。由此补上：采用计划草稿时给账本里已有的伏笔补上章节；账本状态的建议 `suggestForeshadowStatus`（章节写完后提示标为已埋或已回收，作者确认）；`chapter_review` 版本 4。
- M4-01 已完成：迁移 `0006_simulation.sql`（`sim_scene`、`sim_run`、`sim_event`、`sim_snapshot`；`sim_event` 的触发器拒绝修改与删除）；`sqlEventStore`（`packages/store/src/sql-event-store.ts`，与内存版、JSONL 版共用契约测试）；仓储 `repos/sim.ts`；用例 `apps/desktop/src/app/simulation.ts`（保存场景、开始、单步、继续、暂停、恢复、停止、状态与事件、校验回放），模型取默认模型、调用记录写入 `llm_call`；M0 的三个场景在 SQLite 上回放与 JSONL 记录逐事件一致（`apps/m0-cli/src/e2e.test.ts`）。没有界面，界面在 M4-02 起。
- M4-02 已完成：顶栏“推演”页（`SimulationPanel.tsx`）与场景编辑表单（`SceneEditor.tsx`：基本信息、角色卡、初始认知、秘密、物品、叙述规则，“高级”里直接编辑整份配置）；用例 `draftSimScene`（`scene_draft` 模板，草稿不保存）；`apps/desktop/src/app/scene-editing.ts`（空白场景、校验结果的中文说明）。机关与各类规则首版只能在“高级”里编辑。
- M4-03 已完成：区域图的表格编辑 `ZoneGraphEditor.tsx`（区域列表与出口，区域两两之间的相邻、可见、声音与通行标记）；`scene-editing.ts` 的 `zonePairs`、`setZoneEdge`、`renameZone`（引用一并改名）、`removeZone`。
- M4-04 已完成：推演工作区 `SimWorkspace.tsx`（开始、单步、继续、暂停、停止，时间线的全局局面与角色所见，等待时间）；`buildViewerData` 从 M0 命令行移到 `packages/engine/src/run-view.ts` 两边共用；预算上限 `sim_run.budget_usd`（迁移 0006 尚未发布，直接修改）与 `listRunCalls`；用例 `simRunDetail`。待核实裁决的确认在 M4-05。
- M4-05 已完成：待核实裁决的确认与修改、导演提议的决定、作者介入（改认知、外部事件、替换行动，介入前存快照）与从快照处分支（用例 `confirmSimRuling`、`decideSimDirector`、`interveneSimRun`、`forkSimRun`，界面 `SimAuthorPanel.tsx`，文字说明 `sim-describe.ts`）。
- M4-06 已完成：列出运行时按事件校正状态与回合（缓存落后时以事件为准）；工作区的“校验回放”（`verifySimRun`，快照处重算的状态与记下的哈希比较）。中断后的恢复沿用事件存储与步骤键查重，测试见 `simulation.test.ts`。
- M4-07 已完成：迁移 `0007_narration.sql`（`beat_sheet`；候选稿重建，增加 `narrate` 操作与 `beat_sheet_id`）；仓储 `beat-sheet.ts`；用例 `apps/desktop/src/app/narration.ts`（`draftBeatSheet` 取视角角色在所选回合结束时的认知、`saveBeatSheet`、`narrateBeatSheet` 写成这一章末尾的候选稿）；工作区的“写成正文”（`NarrationPanel.tsx`）；桌面端接法的金丝雀测试。
- M4-08 已完成：采纳推演草案（`narration.ts` 的 `adoptionDraft`、`adoptCandidate`，仓储 `repos/adoption.ts`、`repos/story-event.ts`）：选定事件、世界事实与视角角色的认知，复核自动接受的裁决，核对涉及锁定设定的事实，写入前快照，正文、故事事件、事件与段落关联、事实及其来源在一个事务中写入；推演写成的候选稿不能直接接受；“AI 写作”里候选稿的“采纳…”（`AdoptionForm.tsx`）。不涉及迁移。
- M4-09 已完成：迁移 `0008_evaluation.sql`（`evaluation`：一次运行或一个批次一份）；仓储 `repos/evaluation.ts`；用例 `apps/desktop/src/app/sim-evaluation.ts`（评分项与 M0 评价表相同，保存时记下采纳的事件、费用与耗时，批量推演整组结束后评价一次）；工作区的“推演评价”（`EvaluationPanel.tsx`）。M4 的任务代码已全部完成，待作者执行手工清单。
- 凭据代理的取消已修正（M2-01 补充，2026-10-14）：开始前已到的取消与可以发送同时就绪时，`tokio::select!` 随机选择会把请求连同凭据发出（全套 `net` 测试约 8% 复现）；`net.rs` 的三处 select 改为先看取消（`biased`），测试 `cancel_before_start_sends_nothing` 改为重复 50 次。
- 全项目审查后的修正（2026-10-14）：采纳推演草案时同一件事（另一视角、分支上的同一事件）关联到原有的故事事件，不另建；采纳的事实从写进的那一章起适用，见闻的来源指向同一回合的事；写手只带适用于本章的事实（与上下文、审核一致）；自动保存在保存抛出异常时按失败重试，不再停下；事实涉及的设定、章节计划的出场人物、故事事件的参与者用到的设定不能删除。
- M3-10 已完成（需求 v0.9 新增 B67，作者决定 2026-10-14）：快速成书——`book_seed` 模板（版本 1，输出 `BookSeedOutput`）；用例 `apps/desktop/src/app/quick-book.ts`（`quickBookStatus`、`draftBookSeed`、`applyBookSeed`）；成书页 `QuickBookPanel.tsx`（连接模型、想法生成大纲与人物、章节计划、写完并审核、导出），新作品从这一页开始；顶栏精简为成书、计划、设定、任务，推演、事实、查找收进“更多”。
- M3-11 已完成：写作技能采用通用的 SKILL.md 格式——`packages/prompts/src/skill-md.ts`（`parseSkillMd`、`formatSkillMd`），八项内置技能改写为 SKILL.md（版本 2，metadata 里是名称、版本与顺序），迁移 `0009_skill_description.sql`（`writing_skill.description`），`writer_chapter` 版本 4（带上技能的适用说明），“写作技能”页可导入与导出 SKILL.md。
- 降本（2026-10-14）：按 M0 首轮调用记录（证据链判断约占四成费用，平均输入约 1.6 万 Token、几乎不命中缓存；思考计入的输出约占七成）调整——提示词按“不变 → 只追加 → 每回合都变”排列以命中服务端前缀缓存（`knowledge_list` 局部模板；`character_action` 版本 9、`belief_update` 版本 7、`evidence_judgement` 版本 5，线索只列一遍）；内置能力表收录 DeepSeek（思考深度可调、价格含缓存命中），模型服务页可“采用内置的能力与价格”；DeepSeek 实验配置中抽取与判断类任务用 low。
- M1-13 已完成（需求 B68，作者要求 2026-10-14）：分卷——迁移 `0010_volume.sql`（`volume` 表、`chapter.volume_id`、视图 `chapter_book_order` 给出书中顺序）；仓储 `repos/volume.ts`，章节的新建、移动与恢复按卷进行（`moveChapter` 的目的地为卷加前一章）；目录按卷分组（`ChapterSidebar.tsx`：新建卷、卷内新建章节、上下移动越过卷的边界、拖到卷标题、编辑卷名与简介、删除空卷）；整本导出带卷名，导入识别“第…卷”与 Markdown 二级标题；`writer_chapter` 版本 5 带上本卷与本卷梗概。
- 计划草稿自动分卷（M1-13 补充）：`plan_draft` 版本 2（10 章及以上按故事的大段落分卷，输出 `volumes` 与每章的 `volume`，已有卷沿用卷名）；采用草稿时建卷、写梗概、把章节放进各自的卷（作者已归卷的章节不动）；计划页与成书页的草稿按卷列出（`PlanDraftChapters.tsx`）。
- M5-01 已完成（需求 B69、B70，作者要求 2026-10-14）：AI 助手——`packages/prompts` 的 `AssistantTurnOutput`（动作的可辨识联合，27 个动作）、`assistant_turn` 模板与 `assistant_tools`、`assistant_state`、`assistant_results` 局部模板、`renderAssistantTurn`；迁移 `0011_assistant.sql`（`assistant_message`）；用例 `apps/desktop/src/app/assistant.ts`（工具执行、确认、最多 8 步、对话保存与随作品切换）；右侧对话框 `AssistantPanel.tsx`；三栏布局（左侧作品导航与目录、右侧助手）、新的视觉规范（`app.css` 的设计变量）、作品列表卡片、手写图标 `Icon.tsx`。
- M5-02 已完成（需求 B71，作者要求 2026-10-14“我要最好的方案”）：AI 助手的回复逐字出现（`packages/llm` 的 `partialStringField`，只用于显示）、耗时动作的进展；选中正文后对话框上方的选区条与快捷说法，`edit_selection` 把选中的文字改成候选稿；新动作 `review_chapter`、`rollback_writer`（须确认）、`add_foreshadow`、`save_snapshot`、`restore_chapter`、`export_book`（`assistant_turn` 版本 2，共 34 个动作）；外观设置（偏好 `theme`，`ThemeButton.tsx`）；章节旁抽屉打开时的排版；浏览器预览 `apps/desktop/preview.html`（sql.js，MIT，开发依赖）。
- M5-03 已完成（需求 B72，作者反馈 2026-10-15 界面还需调整、两栏要能调宽度）：左栏与助手可拖动调整宽度（`Splitter.tsx`，偏好 `layout`），左栏可收起；Radix UI 原语（`radix-ui`，MIT）的下拉菜单与提示气泡（`IconButton.tsx`），Lucide 图标（`lucide-react`，ISC）；更中性的配色、细滚动条、章节工具栏、空白章节的提示（TipTap Placeholder）、标题栏随外观（权限 `core:window:allow-set-theme`）。
- M5-06 已完成（需求 B74，作者要求 2026-10-15 参考 oh-story-claudecode 与 zenstory 吸纳长处）：`packages/writing` 的文字体检 `proseChecks`（AI 常见句式、生成退化、写作材料泄漏，并入审核的程序检查）与标点规范化 `normalizePunctuation`（写手写入前）；迁移 `0013_memory_open_threads.sql`、`chapter_memory` 版本 2 的“章尾留给后面的事”、`writer_chapter` 版本 7 带上它；AI 助手的 `remember_preference`（存为“作者偏好”写作技能）与 `add_avoid_phrases`（`assistant_turn` 版本 4）。
- M5-05 已完成（需求 B73，作者要求 2026-10-15）：人物关系网——迁移 `0012_relationship.sql`（`relationship`、`relation_position`，随设定级联删除）；仓储 `repos/relationship.ts`；`packages/writing` 的 `relationApplies`、`relationsForCast`；用例与关系图布局 `app/relations.ts`；关系页 `RelationsPanel.tsx`（关系图、按章节查看、拖定位置、表单与列表）；`writer_chapter` 版本 6 带上出场人物的关系、`packages/context` 的 `relation` 条目；AI 助手的 `add_relationship`、`update_relationship`、`delete_relationship`（`assistant_turn` 版本 3）；`book_seed` 版本 2 生成主要人物的关系。
- M5-04 已完成（作者要求 2026-10-15 按设计模式自查）：正文旁的抽屉由四个布尔标志改为可辨识联合 `drawer`，只读原因由 `chapterLock` 给出；状态层的任务句柄 `startTask`（时间取自时钟端口 `service.now()`），AI 助手的每一轮登记为任务；助手动作改为命令表 `app/assistant-tools.ts`（`assistant.ts` 只管对话循环）；`parseSceneConfigText` 把“高级”编辑的 JSON 解析移到应用层；`app/labels.ts` 统一设定种类与计划状态的名称。设计模式文档 v0.2 增加相应两节，并写明任务列表只保留本次运行。
- M5-07 已完成（作者要求 2026-10-15 从性能的角度自查）：模型 SDK 改为第一次调用时载入（`@fudiao/llm/adapters`，主包 2,137 kB 降到 1,552 kB）；正文每次按键的段落标识、设定高亮与来源色条只处理改动的段落（3.4 万字的一章每次按键约 10 毫秒降到 0.8 毫秒，属性测试保证与整章重建一致）；关系图布局按网格只比较相近的人物（200 人 243 毫秒降到 46 毫秒）；关系页的布局按内容缓存；章节目录改为虚拟列表（`@tanstack/react-virtual`，MIT；800 章时切换章节不再重渲染整个目录）；字数统计 `countWords` 改为逐字分类（全书约 195 毫秒降到 14 毫秒，属性测试对照原写法）。结果见 `tools/bench/README.md`。
- M5-08 已完成（需求 B75，作者要求 2026-10-15 内置一项提炼自雪花写作法的技能）：写作技能分规划与写章节两个阶段（`packages/shared` 的 `SkillStage`，迁移 `0014_skill_stages.sql`，SKILL.md 的 `metadata.stages`）；内置技能“雪花写作法”（`templates/skills/snowflake.md`，用于规划）；`book_seed` 与 `plan_draft` 版本 3 带上启用的规划技能，章节计划草稿带上人物说明；`skillsForStage`（`app/writing-skills.ts`）供写手与规划共用；“写作技能”页显示与选择阶段；“作者偏好”两个阶段都用。
- M5-18 已完成：界面测试覆盖经助手停下后台写作（写到一半的一章不写入、后面排着的章不再写、任务记为已取消）。
- M5-19 已完成（ASSISTANT_REVIEW.md 第五节第 2 项）：AI 助手操作角色推演——`create_sim_scene`（描述生成场景、校验通过才保存）、`start_simulation`/`continue_simulation`（经 `BackgroundJobs.simulate` 在后台推进，与推演页的“继续”共用 `advanceSim`）、`get_simulation`（全局概要，只用于汇报）、`narrate_simulation`（节拍表与候选稿，只用视角角色的认知，不带助手写的说明）、`list_simulations`，`stop_background` 可停推演；`assistant_turn` 版本 11，共 57 个动作。
- M5-20 已完成（ASSISTANT_REVIEW.md 第五节第 3 项）：撤销 AI 助手一轮的改动——命令表每个动作写明 `undo` 方式；改结构的动作前后取现状（`app/assistant-undo.ts` 的 `captureWork`、`diffWork`），差别存进对话的 `changes` 记录（迁移 `0016_assistant_undo.sql`），`undoChanges` 倒着改回（之后又改过的不动、锁定设定不改、新建章节移入回收站、重建记录的新标识记在 `undo` 记录里）；写手写章回退、修订恢复快照；对话框的“撤销这一轮的改动”与动作 `undo_last_turn`（`assistant_turn` 版本 12，共 58 个动作）；仓储 `deleteChapterPlan`。
- M5-25 已完成（第三次真实模型试用后的修正，2026-10-19）：后台整批写作与依次审核结束时（写完、停下或出错），状态层的 `writeChapters`、`reviewChapters` 返回怎样结束的一句话，经 `BackgroundJobs` 的 `onEnd` 与 `ToolEvents.backgroundReport` 放进之后一轮的现状（“后台刚做完的”）；`assistant_turn` 版本 15；伏笔状态的建议在长篇记忆没提到时要求先读正文确认；试用脚本的 `--max-output`（没有登记能力的模型最大输出按 4,096 计，先思考的模型会被截断）与写手停下的原因。试用结果见 ASSISTANT_REVIEW.md 第三节。
- M5-24 已完成（ASSISTANT_REVIEW.md 第五节第 10 项）：AI 助手试用增加几组对话——`tools/assistant-eval/scenarios.ts`：`long-work`（打开已有的大部头：分卷、120 章、长大纲与关系网）、`edit-and-export`（选区修改、续写、导出、拒绝确认与撤销）、`faults`（在模型端口上注入连接中断与不合格的输出，看重试与修正）；`--scenario` 选择、`--list` 列出，每组各自估计费用。真实模型的试用待作者确认费用后运行。
- M5-23 已完成（ASSISTANT_REVIEW.md 第五节第 4 项）：AI 助手的 `write_chapter`、`review_chapter`、`revise_review_issue` 有后台时交给后台——`BackgroundJobs.run`（状态层登记为任务、`assistantJobs` 让写作与修订中的那一章只读、`stop_background` 可停），排上就返回；做完的结果放进之后一轮的现状（“后台刚做完的”，只说一次）；写章与修订的撤销记录在做完时写进对话，`turnOf` 指向发起的那一轮；没有后台（测试、命令行与试用脚本）时照旧就地做完；`assistant_turn` 版本 14。测试见 `assistant-background.test.ts` 与界面测试。
- M5-22 已完成（ASSISTANT_REVIEW.md 第五节第 7 项）：没有打开作品时的模型调用（例如 AI 助手新建作品之前的几步）记录暂存在调用器（`model-runner.ts`，最多 500 条），下一次在作品里调用时补记进那部作品的调用记录，用量与费用不漏算。
- M5-21 已完成（ASSISTANT_REVIEW.md 第五节第 6 项）：AI 助手的请求按模型的上下文上限缩减——`modelRunner.modelLimits`；`assistant.ts` 的 `fitPrompt` 按每字 Token 数估算（起初 1.3，按服务报回的用量分模型校准；原生结构化输出时输出结构按每字 0.5 计入），留出 5% 余量、输出上限与一次修正的余量，放不下时依次换四级更少的对话与现状（简介、大纲与卷简介留开头与结尾），现状写明缩减过；新动作 `get_work`（作品信息全文）；`assistant_turn` 版本 13，共 59 个动作。测试见 `assistant-context.test.ts`。
- 全项目审查后的修正（2026-10-19，写手、快照、来源与 AI 助手）：写手与修订的输出被截断时不写入、停下说明，续写时这一段换步骤键（`retryableStepKey`）；能力自检的输出上限不超过模型的最大输出；迁移 `0017_paragraph_retired.sql` 记下删除段落的最后版本，快照（新增 `version`）恢复与编辑器撤销找回同一标识时版本不倒退；快照恢复以现稿为守卫，写手正在写或写到一半时不恢复；回退写手写入改为一个事务（`rollbackWriterRun`）；在 AI 段末接受续写不改动那一段，续写与推演正文的过期检查带上其后的一段（`candidateVersions`）；接受候选稿时正文与状态同一事务（`acceptCandidateRange`）；写手修订与写章共用一把锁；章节计划里要埋或要收的伏笔不能删除；助手：一轮里两次换作品不丢作者的话（按作品位置判断换没换）、对话存不进时停下、确认绑定找到的那一项的标识、`plan_chapters` 只记采用计划那一步的改动、撤销写手写章与修订先比较正文（改过或有草稿不动）且须作者确认、撤销删除设定沿用原标识、不直接写或回退排在后台写作里的章节、后台写作保存不了本章时不排上；对话的序号在事务里取。拆分合并记录只累加（`paragraph-identity.ts`，编辑器段落标识扩展）的修正方案待作者确认。
- M6-01 已完成（需求 v0.10 新增 B78 至 B83，作者确认方案 2026-10-19）：写作工作流框架——迁移 `0019_workflow.sql`（`workflow_run`、`workflow_step`，随作品包导出）与仓储 `repos/workflow.ts`；`packages/shared` 的步骤状态与模式；`packages/writing` 的步骤状态机 `transition`、`nextAction`、`runState`（纯函数，中断的步骤接着做同一次、步骤键不变）；应用层 `app/workflows.ts`（命令表、推进 `advanceWorkflow`、预计用量 `quoteWorkflow`、采用与撤回经 AI 助手的撤销、按步记用量与预算上限、打开作品时进行中的步骤标为中断）；第一个工作流“一键成书”（检查模型、大纲与人物、章节计划、写完并审核、导出，步骤沿用快速成书的用例）；状态层在后台推进（写章节经写手队列，任务种类 `workflow`，离开前确认、停下）；“工作流”页 `ui/WorkflowPanel.tsx`（导航“成书”下面）；AI 助手的 `list_workflows`、`start_workflow`、`get_workflow`、`continue_workflow`，`stop_background` 增加 workflow（`assistant_turn` 版本 16，共 63 个动作）。顺带修正：`stop_background` 停推演时不再连带停下写手队列与依次审核。成书页并入工作流页在 M6-02。
- M6-02 已完成：成书页并入写作工作流——导航“成书”打开 `ui/WorkflowPanel.tsx`（模型是否可用、作品现状、工作流卡片与开始表单（随机想法）、运行与步骤；“写完并审核”一步里是成书进度看板），新作品打开时展开一键成书的开始表单；`QuickBookPanel.tsx` 与状态层的骨架草稿（`bookSeed` 等）退役，骨架的编辑只在步骤里（`ui/BookSeedFields.tsx`）；没写想法而作品已有大纲时跳过“大纲与人物”（步骤的 `skipIf`）；AI 助手的页面去掉 workflows，book 即成书页（`assistant_turn` 版本 17）。
- M6-03 已完成（需求 B80）：全书体检——工作流 `book_audit`（补齐长篇记忆、依次审核、伏笔核对、跨章疑点、读原文定位、体检报告）；迁移 `0020_review_continuity.sql`（审核问题的来源增加 `continuity`，单章重新审核不冲掉体检的问题）；依据可以是另一章的段落（带章节与版本，那一段改过后问题过期）；`packages/writing` 的 `foreshadowAudit`；模板 `book_audit`（版本 1，`BookAuditOutput`）与 `continuity_check`（版本 1，输出同 `chapter_review`）；用例 `app/book-audit.ts`；工作流的步骤结果可标 `settled`（没有要作者看的草稿直接完成）；状态层的依次审核抽成 `reviewQueueRun` 供工作流用；成书页的体检表单（范围、重新审核）、疑点编辑与报告；AI 助手 `start_workflow` 可发起体检（`from`、`to`、`rereview`，`assistant_turn` 版本 18）。
- M6-04 已完成（需求 B82）：续写一卷——工作流 `next_volume`（补齐最近几章的长篇记忆、卷纲、本卷章节计划、写完并审核、本卷体检）；模板 `volume_outline`（版本 1，`VolumeOutlineOutput`）与 `plan_draft` 版本 4（只给新的一卷拆章：已有章节只作为前文，列最后几章与最近的梗概）；`plan_draft` 版本 5（2026-10-20）：拆章一步带上卷纲挑出的本卷要回收的伏笔（`appendVolume.payoffs`，只带账本里还没回收也没废弃的），要求每条都在本卷的某一章 payoff；`planning.ts` 的 `draftVolumeOutline`、`applyVolumeOutline`（新建一卷、写简介、新人物与新伏笔）、`draftVolumePlans`、`applyVolumeDraft`（在这一卷末尾建章并写计划，已有章节不动；与 `applyPlanDraft` 共用 `writeDraftPlans`）；成书页的续写表单与卷纲编辑；AI 助手 `start_workflow` 可发起续写（`instruction`，`assistant_turn` 版本 19）。
- M6-05 已完成（需求 B81）：开篇打磨——工作流 `opening_polish`（开篇的数字、逐章诊断、处理问题（须作者动手）、复诊、对比前后）；`packages/writing` 的 `openingMetrics`（字数、主角第几字出场、对白占比、前一千字的设定名、最长一段）与 `guessProtagonist`；模板 `opening_review`（版本 1，输出同 `chapter_review`）；用例 `app/opening.ts`；迁移 `0021_review_opening.sql`（审核问题的来源增加 `opening`，单章审核与体检不冲掉开篇的问题）；成书页的开篇表单、诊断列表与对比表；AI 助手可发起开篇打磨（`assistant_turn` 版本 20）。
- M6-06 已完成（需求 B83）：人物小传与关系网补全——工作流 `cast_completion`（补齐长篇记忆、找出缺口、小传与关系的草稿、逐项勾选后采用）；`packages/writing` 的 `castGaps`（说明为空、出场却没有关系、第一次出场的章节）；模板 `cast_completion`（版本 1，`CastCompletionOutput`）；用例 `app/cast-completion.ts`（只增不改：锁定的不动，已有说明只在后面补充，同样的关系不重复建，关系带开始成立的章节）；成书页的勾选清单；AI 助手可发起人物补全（`assistant_turn` 版本 21）。
- M6-07 已完成（需求 B79）：扫榜拆书——工作流 `benchmark`（榜单与样章、逐本拆解、对标分析、存为规划技能、删除样章原文），只由作者在成书页开始（AI 助手能查看、不能发起）；不联网抓取，作者粘贴或从 TXT 读入；迁移 `0022_benchmark_sample.sql`（样章表，`schema.ts` 的 `LOCAL_TABLES`：不进作品包与数据导出，跑完或放弃时删除）；`packages/writing` 的 `parseRankList` 与复述检查 `trimOverlap`（与样章相同、长于 30 字的截短）；模板 `benchmark_book`、`benchmark_compare`（版本 1；对比只读拆解，不读原文）；用例 `app/benchmark.ts`；导出时去掉逐本拆解调用记录里的模型输出原文（可能抄了样章）；金丝雀测试确认样章原文不出现在对比、规划请求与作品包里；成书页的粘贴与读入表单、拆解与对标分析的显示，开书方向可以直接开一键成书。M6 的任务代码已全部完成，真实模型的验证待作者确认费用后进行。
- M6-08 已完成（真实试用一次，2026-10-20，中转站 deepseek-v4.1-flash，40 次调用，输入 10.2 万、输出 22.9 万 Token，按官方价约 $0.31，约 20 分钟）：`tools/workflow-eval`（`pnpm workflow:eval`，`--config` 或 `--base-url`，`--workflow` 选一个或全部；配置里的密钥变量没有设置时退回 `FUDIAO_EVAL_KEY`）在 `m3/eval/book.json` 上依次跑一键成书（现写 3 章）、全书体检（第一、三章植入一处跨章矛盾）、开篇打磨（最严重的一条交给写手修订）、人物补全、续写一卷（2 章）与扫榜拆书（样章只用材料与本次写手的正文）；运行前按 `quoteWorkflow`（新增可选的假定作品规模 `assumed`）汇总预计并等确认，报告写在 `m3/runs/`；`tools/m3-eval/run.ts` 抽出 `importBook` 两边共用；不联网的测试用排好的回复走通全部六个工作流。结果见 `m6/RESULTS.md`：五个工作流走通，续写一卷因第五章审核思考用满被截断而停在“写完并审核”；植入的矛盾没有检出（长篇记忆没有记下端砚）；预计输出低估约一半，已在 `quoteWorkflow` 每次调用另计 6,000 Token 思考。待修清单（审核思考过重、跨章检查只看长篇记忆、章节标签漏进作品文字、伏笔账本不随写作更新等）列在该文件。
- 连续处理多章时审核没完成的处理（作者决定 2026-10-20，M6-08 试用清单第 1 项）：`app/review.ts` 的 `reviewWithRetry`（`REVIEW_RETRIES` 为 1，取消与调用失败不重试）；服务层默认的写章节与依次审核钩子、状态层的写手队列与依次审核、试用脚本都改为先重试一次，仍没完成就记下这一章、接着做后面的，结束的那句话列出没审完的章节与原因；写作与长篇记忆没完成照旧停下。施工文档成书流程看板一段同步修改。
- M6-08 试用后的修正（`m6/RESULTS.md` 第 4、5、7 项，2026-10-20）：`packages/writing` 的 `replaceLabels`、`paragraphMention`、`chapterMention`（属性测试），模型照抄的标签在写进作品前换成章节名与段落开头——审核、开篇诊断与跨章连贯问题的说明与建议（`resolveModelIssues` 的 `names`，本章段落自动换，依据由调用方给出称呼），全书体检疑点的 `about`，人物补全草稿的小传与关系说明；一章之内的疑点（前后同一章）不再丢弃，`book_audit` 版本 2 允许前后写同一章，`continuity_check` 版本 2 的 `same` 只给这一章、依据是本章前文的另一段（带版本，那一段改过后过期），问题照常记为 continuity；开篇打磨的诊断记下问题（段落、种类、说明）与作者忽略的问题，“对比前后”按同一段落同一种类比对，写明解决、忽略与复诊新提的条数（`openingIssueChanges`），成书页的对比表显示。
- M6-08 的两个分支并入 main（2026-10-21）时的补充：服务层默认的写章节与依次审核钩子被停下时记为中断（`HookOutcome.cancelled`，与状态层、M6 审查修正的规则一致）；全书体检的范围从中间某章起时，范围首章之内的疑点（前后同一章）定位出的问题补进这一章（`saveContinuityIssues` 的 `append`，与仍待处理的同一处问题不重复），不换掉它与前一章那一对这次没有查的旧问题，范围从全书第一章起时照常换。真实试用的运行记录 `m3/runs/workflow-2026-10-20T02-13-49-423Z/` 已从该分支的工作树转存到主目录（不入库）。
- 模型最大输出的核对与中转站的 DeepSeek 模型名（2026-10-22，作者在桌面应用里遇到：中转站的 `deepseek-v4.1-flash:1017` 没有登记能力，最大输出按保守的 4,096 计，“大纲与人物”的额度被思考用完、收到 0 字）：一键成书的“检查模型”一步核对默认模型登记的最大输出够不够这个工作流的一步要写的内容（骨架随章数、计划每章约 1,200 Token、写手一段最多整章的目标字数；`quickBookOutputNeed`），不够时在花钱之前出错并说明怎么改，只够内容、没有思考余量时在说明里提醒；兼容接口上带版本与构建后缀的 DeepSeek 模型名（`deepseek-v4.1-flash:1017`、`deepseek/DeepSeek-V4-Pro`）按名字里的 flash 或 pro 对到内置条目（`deepseekAlias`），添加时带上内置的能力与价格、显示名保留原名，早先添加的可“采用内置的能力与价格”（中转站的价格可能不同，采用后可再改）。
- 模型的上下文与最大输出不再要手动配（需求 B56、B57 补充，作者要求 2026-10-22）：能力记录增加 `limitsKnown`（上下文长度与最大输出有没有依据；早先的记录与保守值不同的当作有依据），没有依据的是保守值——调用器不按它压请求（`clipOutput`）、上下文按 128,000 估算（`effectiveLimits`，`app/model-limits.ts`）；兼容接口的模型列表读各家自带的字段（`listedLimits`：OpenRouter 与 new-api 的 `context_length`、`top_provider.max_completion_tokens`，vLLM 的 `max_model_len`，LiteLLM 的 `max_input_tokens`、`max_output_tokens`）；能力自检先用连接测试的提示词发一个输出上限极大的探测请求（`probeMaxOutput`），服务拒绝时的报错里写明的最大输出记进能力（来源记为服务）；调用被服务以超限拒绝时 `parseLimitError` 从报错里学到最大输出或上下文长度（OpenAI、Anthropic、DeepSeek、vLLM 的写法），经 `learnModelLimits` 记进模型，最大输出比发出的小时按它自动重发一次，学到上下文长度时错误里附上数字；“能力与价格”里没有依据的两项留空、模型一行写“未登记”，填了数字就是有依据；模型端口拿到的能力不带 `limitsKnown`（请求哈希不变）；测试辅助 `addTestedModel` 用预设的拒绝回复让测试模型学到 4,096。
- M5-17 已完成：助手的现状给出全书字数与有章节计划的章数，`assistant_turn` 版本 10 要求说数字与作品事实只用现状与动作结果里有的（试用中助手编造过“约 30 章”）。评估与待办见 ASSISTANT_REVIEW.md。
- M5-16 已完成（作者要求 2026-10-16 用真实模型试一下助手）：试用脚本 `tools/assistant-eval`（`pnpm assistant:eval`，可用 `--base-url` 指向 OpenAI 兼容服务，Key 取自环境变量 `FUDIAO_EVAL_KEY`）；按两次试用修正：助手写完单章整理长篇记忆、新动作 `build_chapter_memory`；须确认的动作后面的动作随确认执行、拒绝时逐条说明没执行；不在待处理里的审核问题处理时返回原因；`foreshadowsForChapter` 并入账本里写明在本章埋设或回收的伏笔；`assistant_turn` 版本 9（没看过正文与审核结果不下结论）。
- M5-15 已完成（作者问 2026-10-16 助手是否仍有缺陷）：新动作 `get_chapter_memory`、`list_foreshadows`、`update_foreshadow`、`list_review_issues`、`resolve_review_issue`、`revise_review_issue`、`list_skills`、`set_skill`、`stop_background`（`BackgroundJobs.stop`）；`assistant_turn` 版本 8；一轮最多 12 步，走满或停止时说明；之前几轮的动作结果截到 600 字，对话按条数与字数截断；伏笔状态的名称统一到 `labels.ts`。
- M5-14 已完成（作者要求 2026-10-15，依据作者提供的“写作基本功”系列九个讲解视频提炼）：内置写作技能“写作基本功”（`templates/skills/writing-basics.md`，写章节）：去过滤词，句内、句间与段间的关系，少用连接词，长短句与句式随情绪，动词的方向、快慢、力度与焦点，写完每段能一句话概括并与本章计划对上。
- M5-09 已完成（作者要求 2026-10-15，依据作者提供的讲解视频提炼）：内置写作技能“不用副词”（`templates/skills/no-adverbs.md`，写章节）：“……地”加动作换成准确的动词，情绪写看得见的言行，不用程度副词撑形容词；“不、没、都、已经”等照常用。
- M5-10 已完成（需求 B76，作者要求 2026-10-15）：作品封面——迁移 `0015_cover.sql`（`cover`，图片以 data URL 存在作品库，随备份与作品包走）；仓储 `repos/cover.ts`；图片缩放端口 `ImagePort`（`adapters/canvas-image.ts`）；作品信息里上传、更换与去掉封面；`library.json` 缓存缩略图，作品列表的卡片显示封面；没有封面时按书名排出文字封面（`ui/BookCover.tsx`）。
- M5-13 已完成（作者反馈 2026-10-15 助手声称在后台审核、实际什么也没做）：动作 `write_chapters`、`review_chapters` 经 `ToolEvents.background` 把多章写作或审核交给后台（写手队列同步占位、新的依次审核 `reviewChapters`/`reviewQueue`），立即返回“已排上”；`assistant_turn` 版本 7 要求只说动作结果与当前状态能证明的事；成书进度可以“依次审核已写好的章节”并显示审核进度。
- M5-12 已完成（作者反馈 2026-10-15 任务容易被打断、看不到上下文用量）：同一章只有一个写手（`writerUseCases` 的锁，写作期间不能再写或回退）；状态层 `backgroundWork()` 列出正在进行的任务，AI 助手的现状带上它（`assistant_turn` 版本 6，不对正在写的章节再发起写作）；有任务时回到作品列表或关闭窗口先确认（`ui/LeaveDialog.tsx`）；重新打开作品后上下文用量取自调用记录（`latestCallWithUsage`），显示为“上下文 N%”。
- 网络中断的重试（M2-03 补充，2026-10-15）：读回复读到一半连接断了（凭据代理的“error decoding response body”）以前归为未知错误、不重试，写完一章后的审核因此失败、整批停下；现在归为 `network`，调用器外层的 `withRetry` 整次重新请求最多两次（3 秒、10 秒），界面清掉半截文字；凭据代理拒绝的请求归为 `bad_request`；整批写作停下时提示怎样接着做。
- M5-11 已完成（需求 B77，作者要求 2026-10-15）：AI 助手输入框下方的模型选择（即默认模型）、思考深度（偏好 `assistant.effort`，只用于助手自己的每一步）与上下文用量（`onUsage`：每一步的输入 Token 占模型上下文上限的比例）；调用器的结构化任务结果带上 `contextWindow`。
- 全项目审查后的修正（2026-10-15）：从备份恢复后，作品列表里的书名与封面缓存、设定与事实列表及各页缓存的数据随之更新（以前要重开作品才对）；AI 助手替换已有的作品大纲前请作者确认（`assistant_turn` 版本 5，大纲没有历史版本）；“AI 写作”与推演写成正文的候选稿与写手写入一样规范标点。
- 能力自检与“AI 写作”留出思考余量（M2-02b 补充，2026-10-15）：DeepSeek 默认先思考且思考计入输出，自检的 1,024 上限偶尔被思考用完而判为“输出被截断”；`runSelfTest` 增加输出上限与思考深度参数，桌面端按 `THINKING_ALLOWANCE`（移到 `app/thinking.ts`）留出余量、思考深度用 low；选区操作的上限同样加上余量。
- 推演审查后的修正（M0-06 补充，2026-10-19）：轮流对话按感知（领域 `speechAudience`）只让听得清的人拿到台词并决定打断，发生打断时本回合的回应（连同推测与内心片段）作废、轮到时重问，`character_action` 第 10 版不再要求模型“忽略”（作者决定，需求文档第五章与施工文档同步改写）；提案收齐时归约算出全部裁决请求（`RunState.adjudication`），全部确认后才提交，多条裁决中一条暂停后恢复不再缺裁决；截断、拒答、输出不合格等暂停后“继续”时 `RunResumed.retry` 记下重做的对象，步骤键加 `:rN` 重新调用，作者改认知同样换键（`RunState.redo`）；并发调用中一个暂停时其余结果照常写入，证据链整体一个批次、恢复不重复写入；回合内改认知后重记 `ViewBuilt`；导演看不到耳语内容，自动采用的导演事件与自动裁决一样采纳前须复核（`reviewItems`）；写成正文时省略的节拍之后的内心片段不作素材。回归测试见 `packages/engine/src/resume.test.ts`、`recovery.test.ts`（含重试的故障注入与轮流对话金丝雀）。
- 凭据代理与作品包的安全修正（M2-01、M1-07 补充，2026-10-19 审查）：回环源的请求改用不经任何代理的客户端（系统代理或 HTTP_PROXY 会把带凭据与正文的请求转发出本机，`tests/net_proxy.rs`）；先于 `net_fetch` 到达的取消记下来（最多 1,024 条、保留 60 秒），开始时直接结束、不发出；Channel 发送失败时停止读流；每个源一个信号量，上限改变时就地增减名额（收不回的记为欠额），同源不同上限的服务不再绕过上限；并发上限夹到 1 至 64；4xx、5xx 响应体读完（最多 1 MB）后把密钥原文换成 `***` 再转发，响应头同样处理；作品包解包按实际解压出的字节限制大小（不信条目声明的大小），“..”按路径段判断（“等等..他是谁”这样的标题可以导出导入）；备份与迁移的 `now` 只接受 `2026-10-08T01:02:03.000Z` 写法；所有连接禁止 ATTACH（`SQLITE_LIMIT_ATTACHED` 为 0，备份的 `VACUUM INTO` 临时放开；事务中的 ATTACH 也能执行，写连接同样要禁），只读连接去掉 `SQLITE_OPEN_URI`。
- OpenAI 写法兼容已补强（M0-04 补充）：结构化输出能力增加 `json_object`；`OpenAIChatAdapter` 按服务的写法差异处理 `max_tokens`/`max_completion_tokens`、流式用量与 `<think>` 标签；实验配置增加服务种类 `openai`，示例见 `m0/experiments/openai-compatible.example.yaml`。
- 段落来源不再受已保存的拆合影响（M1-10 补充，2026-10-19 审查第 6 项，方案 A）：编辑器的结构变化记录在整次编辑会话里只增不减，以前每次保存都按早已保存过的拆分把段落并组，删改过的 AI 段落一直是“AI 生成”；`deriveProvenance` 现在忽略已落库的变化（拆分出的段落已在上次保存里不并组；被合并的段落只在上次保存与当前文档之一里时才并组，保存过的合并被撤销也算），编辑器扩展未改；属性测试保证分几次保存时，交整次会话的记录与只交上次保存以来的记录得到相同的来源。
- M6 审查后的修正（2026-10-20，写作工作流与五个工作流）：预算在一步之内也起作用（`CallOptions.beforeCall`，达到上限不再开始新的调用，进行中的做完，这一步中断；用量每次调用后写回）；采用前以版本守卫在步骤上记一笔，两处同时采用不再把草稿写进作品两遍；一步里几件事中有没做成的记为中断、继续时接着做同一次（`AppError.interrupted`，核对疑点、拆解、诊断、整理记忆都不再因一次失败重付全部费用）；写手或依次审核被停下时步骤为中断而不是出错；已采用的草稿先撤回再重做；助手 `continue_workflow` 按原样采用会覆盖内容的草稿前请作者确认，后台在做事时拒绝换作品；卷纲采用后记下新卷的标识（`adopt` 可改写结果）；范围体检不冲掉首章来自更早章节的连贯问题，带给疑点查找的事实与关系只到范围末章；开篇的主角推断与出场位置按最长的名字算；人物补全的互为关系不分方向、别名重复的小传丢弃；扫榜拆书的样章在对比一结束就删（打开作品时兜底清理），榜单支持一行一本，复述检查按来源只建一次窗口集合、按码点计字；审核抽屉显示“跨章连贯”“开篇诊断”来源；成书页在采用后刷新作品现状与运行列表，打开没有章节的作品时读取运行，开始表单不能连按两次，步骤出错时任务记为失败，后台刷新不再让按钮闪烁或清掉提示。
- 写作技能的去 AI 味（作者提供资料 2026-10-20：Humanizer-zh、blader/humanizer（都是 MIT）与 De-AI-Prompt-Enhancer-Writer-Booster（没有许可证，只参考思路）；按推荐方案取舍）：内置技能 `polish` 升到版本 3“润色与去 AI 味”（对照壳子、一句话收尾、伪深度与拔高、戏剧化碎片与凑数的排比、重复开头、破折号与限定词、“进行＋动词”与层叠的“的”、被字句与四字词排比、口癖、修订只改表达不添事实不删伏笔），文字自己写，不抄原文；规避词表补上小说里常见的九个套话；文字体检（`proseChecks`）增加“不仅是……更是”“与其说……不如说”、“进行＋动词”、堆叠的限定、接连三句同样的开头、破折号太密五条规则，章尾收束的套话补三条。不采用的：三个仓库里针对说明文与聊天残留的规则（粗体、标题、客服腔、知识边界免责）、英文词表、“一律不用破折号”（中文小说里破折号有正当用法，改为按密度提示）、De-AI 的“作者风格复现引擎”（面向评论与随笔，且无许可证）。写作技法类资料的其余部分仍等作者提供。
- M7-01 已完成（需求 v0.11 新增 B84，作者要求 2026-10-20）：联网搜索——应用设置库的 `search_service`、`search_default`（app 迁移 0002，仓储 `packages/store/src/app/search-services.ts`）；搜索服务（Tavily、Brave Search）的 API Key 存系统凭据管理器、请求经凭据代理（`KeyHeader` 增加 `x_subscription_token`）；Rust `src-tauri/src/web.rs` 的 `web_fetch`（不带凭据、只读公网主机、最多 3 次重定向、2 MB、25 秒、HTML 转文字；`tests/web.rs`）；应用层 `app/web-search.ts`（服务增删改与默认、测试搜索、`webSearch`、`readWebPage`）；AI 助手动作 `web_search`、`read_web_page`（`assistant_turn` 版本 22，共 65 个动作，网页内容是材料不是指令）；扫榜拆书的开始表单可以联网搜榜单；“模型服务”页的“联网搜索”一节；`AppDeps.web`（桌面端、预览与测试各自实现）。B79 改为榜单可由搜索填入、样章仍由作者提供。同日补上 DeepSeek 搜索（作者指出 DeepSeek 也有联网搜索：开放平台 2026-10-17 起的 Search 与 Fetch 接口，每千次成功请求 5 元）：app 迁移 0003 重建 `search_service`（kind 增加 deepseek、`credential_ref` 沿用某个模型服务的 Key，须同一个源）；`runSearch` 的 DeepSeek 写法与 `deepseekFetch`；读网页直接读不到时经 DeepSeek Fetch 在服务端再试；编辑器可选“沿用模型服务的 Key”。
- M7-02 已完成（需求 B84 补充，2026-10-20）：模型自带的联网搜索——第四种搜索服务 `provider`（app 迁移 `0004_search_provider.sql`：`kind` 放宽、`model_id` 引用模型且删除后置空），用 Anthropic（Messages API 的 `web_search_20250305` 服务端工具）或 OpenAI 官方接口（Responses API 的 `web_search` 工具）的模型自己搜索；`packages/llm` 的 `LlmRequest.tools`、`ModelCapabilities.webSearch`、`Prices.webSearch`（每千次）、`LlmResult.webSearch`（次数、结果、错误码），`AnthropicAdapter` 与 `OpenAIAdapter` 按能力声明工具并从结果块与引用整理标题、网址、摘要，`OpenAIChatAdapter` 明确拒绝，契约测试用不联网的 fake fetch（`Scenario.search`）；搜索做成只搜不写 JSON 的单独一次调用（模板 `web_search` 版本 1，任务种类 `web_search`），经调用器（`RunRequest.model`、`tools`）记进 `llm_call`，费用含搜索费；内置能力表标上两家的主流模型；“能力与价格”可勾选并填每千次价格；模型服务页的“联网搜索”可选“模型自带的联网搜索”。DeepSeek 的内置搜索工具只在 v4-pro 上生效，它走 M7-01 补充的 DeepSeek 搜索，不在 provider 种类里。两家当前文档的请求写法、响应块与价格见施工文档 M7-02 的设计。真实模型没有调用，待作者按手工清单验证。
- 2026-10-20 的后续修正：工作流采用到一半失败时按差别把已写入的部分改回（`adoptStep` 经 `ChangeTracker`，不留半套章节或人物）；步骤执行完写回时版本不符再读一次重试（`applyAfterRun`）；成书页的骨架与卷纲草稿改过没保存就切到别的步骤时自动保存（`useDraftSaver`）；“续写一卷”采用计划失败时新建的章节移入回收站；测试依赖增加 `sqlFaults`（注入写入故障）。
- 模型接入的预算与计费修正（M2-03、M0-04 补充，2026-10-19 审查）：预算守卫给进行中的调用预留最坏估计（`BudgetGuard.reserve`、`settle`），引擎同时发出的提案、裁决与判断不再一起越过 `sim_run.budget_usd`；服务没有返回用量、或已经开始回复后出错（`LlmError.partial` 带回已知的部分用量）的调用可能已计费，按请求的最坏估计计入（`chargeOf`、`worstCase`），迁移 `0018_llm_call_estimate.sql` 的 `cost_estimate` 记下估计，推演恢复时接着算，推演页与用量页注明是估计，回复到一半断开的失败调用在用量页算作费用未知；三个适配器在流没有结束标记就关闭时返回 `network` 错误（可以重试），不再把半截文字当作完成。经凭据代理时 `proxy-fetch` 收到 `failed` 事件：读到一半失败时先让读取方读完已经到达的数据块再报错（适配器据此拿到已收到的部分，例如流开头的用量），取消时照旧直接作废（2026-10-20 按推荐方案实施）。

## 工作方式

- 以施工文档第八章的任务编号为单位工作，一个任务一个分支，分支名形如 `m0-02-domain-kernel`。
- 核心模块（领域内核、推演引擎、认知透镜、事件存储与恢复、凭据代理、编辑器段落标识扩展）先给出方案并获得确认，再写代码。
- 领域内核先写测试，再写实现。
- 实现与文档不一致时，先指出差异；经确认后同步修改文档，不要悄悄偏离文档中的决定。
- 本项目以 AGPL-3.0-or-later 发布（见 LICENSE 与 README.md）；作者不希望被闭源商用，不要改为宽松许可证。
- 未经要求，不推送远程仓库，不发布，不新增重量级依赖；新增依赖须说明理由与许可证（只接受 MIT、Apache-2.0、BSD、ISC 等宽松许可证）。新增依赖的许可证还须与 AGPL-3.0 兼容（例如不能引入 GPL-2.0-only 的依赖）。
  - 已确认的例外：`lightningcss`（MPL-2.0），Vite 的必需依赖，只在开发与构建时使用，不随产品分发。
  - 已确认的例外：Tauri 2 的传递依赖 `option-ext`（MPL-2.0，经 `dirs`，随产品分发，未修改，源码见 crates.io），以及 `cssparser`、`selectors`、`dtoa-short`（MPL-2.0，只在 Tauri 的编译期宏与构建脚本中使用，不随产品分发）。

## 技术栈

- 桌面：Tauri 2；前端：React 19 + React Compiler、TypeScript strict、Vite、Zustand；编辑器：TipTap 3（关闭按事务重渲染）；界面组件：Radix UI 原语（菜单、提示气泡等的行为，样式用 `app.css` 的设计变量）与 Lucide 图标；长目录用 TanStack Virtual。
- 数据：SQLite（WAL），桌面端经 Rust（rusqlite）命令访问，Node 端用 better-sqlite3，两端共用迁移 SQL；全文检索用 FTS5 trigram。
- 校验：Zod，同一定义生成类型与模型结构化输出所需的 JSON Schema。
- 模型：TypeScript 适配器（Anthropic 官方 SDK；OpenAI 官方 SDK），Rust 只做凭据代理；所有服务由用户自填 API Key。
- 测试：Vitest、fast-check、cargo test；包管理：pnpm workspace。

## 仓库结构与依赖方向

```text
apps/desktop        Tauri 应用（src 为界面与应用服务层，src-tauri 为 Rust）
apps/m0-cli         M0 命令行
packages/shared     标识、时间、Result、错误类型
packages/domain     领域内核：纯函数，禁止任何 IO
packages/engine     推演编排
packages/context    上下文构建与信息权限过滤
packages/writing    写手与审核的纯函数：计划与伏笔规则、技能组合、审核的程序检查（禁止 IO）
packages/prompts    提示词模板与输出 schema
packages/llm        模型适配器、结构化输出管线、预算守卫
packages/store      迁移、仓储、事件存储
packages/editor     TipTap 扩展
m0/                 M0 场景、实验配置、评估材料与结论
m3/                 M3 评估的短篇材料、配置示例与结果
```

依赖只能向内：`apps → engine / context / writing / store / llm → domain → shared`。`packages/domain` 不得导入 IO 模块、Tauri、数据库或网络库。依赖边界由 dependency-cruiser 在持续集成中检查。

## 常用命令

需要 Node 22.12 及以上与 pnpm 12（版本见根目录 `package.json` 的 `packageManager`）。

```bash
pnpm install
```

类型检查（根目录配置文件与各包分别检查；`domain`、`shared` 等包不加载 Node 类型）：

```bash
pnpm typecheck
```

代码检查（含领域内核禁止 `Math.random`、`Date.now`、`new Date()`，推演相关包禁止 `JSON.parse`）：

```bash
pnpm lint
```

依赖边界检查（规则在 `.dependency-cruiser.cjs`，规则本身由 `tools/depcruise/rules.test.ts` 测试）：

```bash
pnpm depcheck
```

```bash
pnpm test
```

修改 `packages/prompts/templates` 后重新生成模板模块与版本锁（内容变化必须先提升模板版本号）：

```bash
pnpm prompts:build
```

依次运行以上四项检查：

```bash
pnpm check
```

性能基准（测试集：`basic` 或 `serial`；`--txt 文件` 只导出测试集 TXT，结果见 `tools/bench/README.md`）：

```bash
pnpm bench serial
```

M3 评估（调用真实模型，运行前显示预计费用并请你确认；配置与步骤见 `m3/README.md`，运行记录写在 `m3/runs/`，不入库）：

```bash
pnpm m3:eval --config m3/eval/config.json --chapters 2
```

M0 命令行（真实调用前会显示预计费用并请你确认；API Key 从实验配置指定的环境变量读取）：

```bash
pnpm m0 help
```

```bash
pnpm m0 run m0/scenes/warehouse.yaml --runs 1
```

```bash
pnpm m0 narrate <运行标识> --pov shen_yan
```

```bash
pnpm m0 view <运行标识>
```

```bash
pnpm m0 outcomes <运行标识…>
```

运行记录写在 `m0/runs/`（不入库）。

AI 助手的真实模型试用（默认 14 句对话，其间写 3 章并审核；`--scenario` 选其他场景，`--list` 列出；报告写在 `m3/runs/`，不入库）：

```bash
pnpm assistant:eval --base-url https://example.com/v1
```

```bash
pnpm assistant:eval --base-url https://example.com/v1 --scenario long-work
```

写作工作流的真实模型试用（在 `m3/eval/book.json` 上依次跑六个工作流，运行前显示预计费用并请你确认；`--workflow` 只跑一个，`--config` 或 `--base-url` 指定模型；报告写在 `m3/runs/`，不入库；结果与待修清单见 `m6/RESULTS.md`）：

```bash
pnpm workflow:eval --config m3/eval/config.json
```

```bash
pnpm workflow:eval --base-url https://example.com/v1 --workflow book_audit
```

Rust 测试（`generate_context!` 在编译期读取前端产物，首次运行前先构建界面）：

```bash
pnpm --filter @fudiao/desktop build
```

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Rust 格式与静态检查（持续集成同样执行）：

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
```

```bash
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

浏览器预览（只在开发时用：sql.js 内存作品库、演示数据与演示模型，不联网；启动后打开 http://localhost:1430/preview.html，`?screen=library` 停在作品列表，`?theme=dark` 或 `light` 指定外观，`?chapters=800` 在演示作品里再加若干章看长篇的目录）：

```bash
pnpm --filter @fudiao/desktop exec vite --port 1430
```

桌面应用的开发模式与安装包（需要 Rust 工具链；安装包写在 `apps/desktop/src-tauri/target/release/bundle/nsis/`）：

```bash
pnpm --filter @fudiao/desktop tauri dev
```

```bash
pnpm --filter @fudiao/desktop tauri build
```

工作区包的命名为 `@fudiao/<包名>`，以源码形式互相引用（`exports` 指向 `src/index.ts`），不需要构建步骤。

## 硬性规则

违反以下任何一条都视为缺陷，必须修复后才能合并。

### 信息隔离

1. 角色代理的输入只能由 `buildCharacterView` 生成的角色视图构建。角色提示词模板的参数类型是角色视图，不接受世界状态或推演状态。
2. 不得把完整世界状态交给任何代理，再用提示词要求它“忽略”某些信息。
3. 读者代理只能读到截至指定章节的正文；正文的单视角生成只能使用该角色当时的认知。
4. 修改上下文构建、角色视图或提示词模板时，必须运行并通过金丝雀泄露测试。

### 确定性与记录

5. 状态变化只能由 `packages/domain` 中的纯函数计算；模型只提出行动、语义判断与文字，结果经校验后才进入状态。
6. 同一回合的提案按角色标识排序后处理，结果与模型响应的到达顺序无关。
7. 随机数的状态属于推演状态，抽取结果写入事件。
8. 推演事件只追加，不修改、不删除；作者介入也是一条事件。
9. 回放只读取事件记录，不调用模型。
10. 需要模型的步骤使用确定的 step key，调用前先查是否已有完成记录，保证恢复时不重复调用、不重复计费。

### 模型调用

11. 模型输出只能在 `packages/llm` 的结构化输出管线中解析，其他代码不得对模型输出调用 `JSON.parse`。
12. 提示词只存在于 `packages/prompts` 的模板文件中；修改模板必须提升版本号，并更新录制回放样本。
13. 业务代码中不得写死模型名称或假定模型能力；模型选择来自配置，参数按模型能力描述传递。
14. 测试与持续集成不访问任何真实模型服务，使用录制回放适配器。需要真实调用的实验只在本地手动运行，运行前显示预计费用。

### 凭据与安全

15. API Key 只保存在系统凭据管理器，只在 Rust 凭据代理中使用，从不传给 WebView，从不写入日志、数据库、导出文件或测试样本。
16. 凭据只发往该服务配置的主机。
17. 不得复用 Claude Code、Codex CLI、Gemini CLI 等官方工具的登录流程或令牌。
18. 不得提交 `.env`、密钥或真实的模型调用记录。

### 数据

19. 原文定位使用段落标识加锚点，不使用全文字符偏移。
20. 数据库结构变更必须附带迁移脚本与导出导入往返测试。
21. 派生结论（事实、分析、审核问题、候选稿）必须记录来源与来源版本；事实与分析未经作者接受不得写入作品。写手代理写入草稿章节的正文（需求 B60）必须带段落来源标记，并在写入前保存章节快照，作者可直接修改或一键回退。
22. 持久记录（作品、章节、段落、推演运行、事件、调用记录等）的标识用 ULID；推演场景内的实体（角色、区域、物品、机关）使用作者可读的键，在一个场景内唯一。系统时间用 UTC ISO 字符串；故事时间是独立的领域类型，不与系统时间混用。

## 编码约定

- 代码标识符用英文；注释、文档、提交信息与界面文案用中文。界面文案遵循术语表，不使用“降智”等评价性词汇。
- TypeScript 开启 strict，禁止 `any`；领域层只用不可变数据。
- 界面组件不直接调用仓储与模型端口，统一经应用服务层的用例。
- 预期错误用 Result 表达，异常只在边界处捕获。
- 注释只写代码本身表达不了的原因与约束，不复述代码。
- 提交信息首行以任务编号开头，例如 `M0-02 实现区域图与感知计算`；合并请求注明涉及的需求编号与验收项。

## 测试要求

- 领域内核：属性测试覆盖“提案顺序无关”“重放与快照一致”“同一物品最多一个持有者”“资源不为负”。
- 上下文与提示词：金丝雀泄露测试。
- 推演流程：录制回放的端到端测试；故障注入测试（任一阶段中断后恢复，无重复裁决、无重复调用）。
- 存储：迁移与导出导入往返测试。
- 适配器：契约测试（正常、流式、取消、限流、拒答、用量缺失）。

## 完成标准

一个任务满足以下条件才算完成：

1. 类型检查、代码检查、依赖边界检查与全部测试通过。
2. 对应的验收项有自动测试；无法自动化的写入手工清单并执行过一次。
3. 数据结构变更时，迁移与往返测试已更新。
4. 涉及模型调用时，录制回放样本已更新，模板版本已提升。
5. 文档与实现一致。

报告完成时，说明运行了哪些检查、结果如何；未运行或未通过的检查要如实说明。

## 代码审查重点

本项目由 Claude 实现、GPT 交叉审查。审查时优先检查：

1. 信息隔离：是否有任何路径让角色、读者或单视角正文拿到权限之外的信息。
2. 确定性：裁决是否依赖到达顺序、系统时间或未记录的随机数。
3. 恢复：中断后恢复是否会重复裁决、重复调用或丢失事件。
4. 凭据：API Key 是否可能出现在 WebView、日志、数据库或测试样本中。
5. 数据：迁移是否可逆、往返是否一致、锚点是否使用段落标识。
6. 是否违反 DESIGN_PATTERNS.md 第七章“禁止的做法”。

审查意见要指出具体文件与行，说明会导致什么错误；以测试结果为最终依据。

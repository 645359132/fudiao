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
- OpenAI 写法兼容已补强（M0-04 补充）：结构化输出能力增加 `json_object`；`OpenAIChatAdapter` 按服务的写法差异处理 `max_tokens`/`max_completion_tokens`、流式用量与 `<think>` 标签；实验配置增加服务种类 `openai`，示例见 `m0/experiments/openai-compatible.example.yaml`。

## 工作方式

- 以施工文档第八章的任务编号为单位工作，一个任务一个分支，分支名形如 `m0-02-domain-kernel`。
- 核心模块（领域内核、推演引擎、认知透镜、事件存储与恢复、凭据代理、编辑器段落标识扩展）先给出方案并获得确认，再写代码。
- 领域内核先写测试，再写实现。
- 实现与文档不一致时，先指出差异；经确认后同步修改文档，不要悄悄偏离文档中的决定。
- 未经要求，不推送远程仓库，不发布，不新增重量级依赖；新增依赖须说明理由与许可证（只接受 MIT、Apache-2.0、BSD、ISC 等宽松许可证）。
  - 已确认的例外：`lightningcss`（MPL-2.0），Vite 的必需依赖，只在开发与构建时使用，不随产品分发。
  - 已确认的例外：Tauri 2 的传递依赖 `option-ext`（MPL-2.0，经 `dirs`，随产品分发，未修改，源码见 crates.io），以及 `cssparser`、`selectors`、`dtoa-short`（MPL-2.0，只在 Tauri 的编译期宏与构建脚本中使用，不随产品分发）。

## 技术栈

- 桌面：Tauri 2；前端：React 19 + React Compiler、TypeScript strict、Vite、Zustand；编辑器：TipTap 3（关闭按事务重渲染）。
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

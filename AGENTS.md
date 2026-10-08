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
- M0-13（真实实验与 `m0/DECISION.md`）需要作者提供 API Key、确认费用并安排评价者。按施工文档，M1 的脚手架与存储部分可与 M0 并行；M1 的其余任务在 M0 结论为继续或调整后进行。作者决定（2026-10-07）：M0-13 的真实实验暂缓，M1 先行，不等 M0 结论。下一步是 M1-08（设定管理：别名、锁定设定、正文实体高亮与跳转）。
- M1-04 已完成：作品列表（默认作品库“文档\复调”、打开其他位置的作品、归档、丢失提示）、作品信息与写作目标、章节目录（新建、重命名、拖动与上下移动排序、回收站与恢复）。分层为仓储（`packages/store/src/repos`）→ 应用服务层（`apps/desktop/src/app`）→ Zustand 状态（`src/state`）→ 界面（`src/ui`）；分数索引排序键与 ULID 在 `packages/shared`；界面测试用 jsdom 与 Testing Library 驱动真实用例；手工清单见 `apps/desktop/MANUAL_TESTS.md`。
- M1-05 已完成：正文编辑器（TipTap 3，doc > paragraph+，关闭按事务重渲染）；段落标识扩展 `packages/editor/src/paragraph-identity.ts`（拆分、合并、粘贴、撤销后的标识继承，输入法组合期间不改动文档）；保存计划 `packages/store/src/repos/paragraph-plan.ts` 与段落仓储（只写变化的段落、版本守卫、事件关联随拆合继承）；自动保存控制器 `apps/desktop/src/app/autosave.ts`；草稿与意外退出恢复；保存失败时复制全文与导出本章；字数统计 `countWords`（`packages/shared`）。
- M1-06 已完成：章节快照（`packages/store/src/repos/snapshot.ts`）的建立、列表、预览与恢复；恢复前自动把现稿存为快照；快照带来源标记与事件关联，恢复后标识、来源与关联正确；界面为章节的“保存快照”“版本快照”。
- M1-07 已完成：导入 TXT 与 Markdown（Rust 识别编码，`apps/desktop/src/app/text-import.ts` 拆分章节，预览后导入为新作品或追加章节）；导出整本或一章（TXT、Markdown）；作品包（`project-package.ts` 决定内容，Rust `transfer.rs` 打包与校验 zip）及导回；备份（`db/backup.rs`：自动、手动、恢复前，自动备份保留 30 份）与从备份原地恢复。
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
packages/prompts    提示词模板与输出 schema
packages/llm        模型适配器、结构化输出管线、预算守卫
packages/store      迁移、仓储、事件存储
packages/editor     TipTap 扩展
m0/                 M0 场景、实验配置、评估材料与结论
```

依赖只能向内：`apps → engine / context / store / llm → domain → shared`。`packages/domain` 不得导入 IO 模块、Tauri、数据库或网络库。依赖边界由 dependency-cruiser 在持续集成中检查。

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
21. 派生结论（事实、分析、候选稿）必须记录来源与来源版本；未经作者接受的内容不得写入作品。
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

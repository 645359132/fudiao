# 复调

中文长篇小说的写作台：人物各凭所知行动，你决定哪一段写进书里。

复调（英文名 fudiao）是一个 Windows 桌面应用，用 Tauri 2 构建。它把写长篇时要记住的东西——设定、事实、伏笔、人物关系、每章写到哪里——放在一处，并让 AI 在你的掌控下帮你写：写出来的文字都标明来源，写入前留快照，随时可以改或回退。

## 能做什么

- **正文与目录**：按卷与章组织，自动保存，意外退出后找回草稿；章节快照与恢复；正文左侧的色条标出哪些段落是 AI 写的、哪些改过；全文查找。长篇（几百章、上百万字）也流畅。
- **快速成书**：一句话的想法 → 作品骨架（简介、大纲、主要人物与关系）→ 章节计划 → 写手逐章写 → 审核 → 导出。每一步的结果都由你改过再采用。
- **写作技能**：采用通用的 SKILL.md 格式，分“规划”与“写章节”两个阶段。内置雪花写作法、伏笔、详略与节奏、张力、场景、对话、视角、章末钩子、润色、不用副词等，可以停用、改写、自定义，也可以导入导出。
- **审核**：程序检查（规避表达、伏笔提前说破或到期未回收、AI 常见句式、生成退化等）加模型审核，每个问题都定位到原文，可以交给写手只改那一段。
- **设定与记忆**：人物、地点、组织、物品与世界规则（可锁定），世界事实与人物认知，伏笔账本，人物关系网（随章节变化），每章写完后的长篇记忆。
- **角色推演**：设置一个场景，每个角色只依据自己知道的事行动，程序统一裁决结果；你挑选事件，再由它写成正文。
- **AI 助手**：在右侧对话框里用一句话让它开书、建卷建章、写人物卡、做计划、让写手写章、审核、改选中的文字……删除与覆盖类的操作会先请你确认。
- **其他**：作品封面，导入 TXT 与 Markdown，导出 TXT、Markdown 与作品包，自动与手动备份，用量与费用统计。

## 模型与隐私

- 所有模型服务都由你自己填写 API Key 接入：OpenAI、Anthropic、Gemini、DeepSeek 等 OpenAI 兼容接口，以及本机的 Ollama、LM Studio。复调不提供账号登录，也不复用其他工具的登录。
- API Key 保存在 Windows 凭据管理器里，只在应用的 Rust 层发请求时使用，界面拿不到，也不写进日志、作品或导出文件。请求直接发往你配置的服务，不经过任何第三方服务器。
- 作品保存在你的电脑上（默认在“文档\复调”），每部作品一个文件夹，内容在一个 SQLite 数据库里。

## 安装

目前只支持 Windows 10 与 11。每次推送到 `main` 分支，GitHub Actions 会构建 Windows 安装包，可以在对应运行记录的产物（windows-installer）里下载；也可以按下面的方法自己构建。

## 从源码运行

需要 Node.js 22.12 及以上、pnpm 12（版本见 `package.json` 的 `packageManager`）；运行桌面应用还需要 Rust 工具链与 WebView2。

```bash
pnpm install
```

启动桌面应用（开发模式）：

```bash
pnpm --filter @fudiao/desktop tauri dev
```

不装 Rust 也能在浏览器里预览界面（内存里的演示作品与演示模型，不联网），启动后打开 http://localhost:1430/preview.html ：

```bash
pnpm --filter @fudiao/desktop exec vite --port 1430
```

类型检查、代码检查、依赖边界检查与全部测试：

```bash
pnpm check
```

构建安装包（输出在 `apps/desktop/src-tauri/target/release/bundle/nsis/`）：

```bash
pnpm --filter @fudiao/desktop tauri build
```

## 文档

- [REQUIREMENTS.md](REQUIREMENTS.md)：需求、术语表与验收标准
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)：技术选型、架构、数据模型与任务分解
- [DESIGN_PATTERNS.md](DESIGN_PATTERNS.md)：设计模式与禁止的做法
- [AGENTS.md](AGENTS.md)：开发约定、常用命令与硬性规则（写给开发者与 AI 编程助手）

## 协议

复调以 [GNU Affero 通用公共许可证第 3 版或更新版本](LICENSE)（AGPL-3.0-or-later）发布。你可以自由地使用、学习、修改和再发布它；但发布修改后的版本，或者把修改后的版本做成网络服务给别人用时，必须以同一协议公开完整的源代码。

## 致谢

- 一些功能的思路参考了 [oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode) 与 [zenstory](https://github.com/zenstory-ai/zenstory)，内置的规划技能参考了 Randy Ingermanson 的雪花写作法，“不用副词”参考了 Shawn Whitney 关于副词的讲解；只借鉴了思路，文字与代码都是重写的。
- 复调构建在许多开源项目之上，包括 Tauri、React、TipTap 与 ProseMirror、SQLite、Zod、Zustand、Radix UI、Lucide 与 TanStack Virtual。

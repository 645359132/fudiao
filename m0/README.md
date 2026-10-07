# M0 推演验证

M0 回答一个问题：多角色推演能否比直接让模型写一场同类场景，产生明显更好的创作材料（需求文档第八章“M0 推演验证”）。本目录存放实验场景、实验配置、评估清单与结论。

| 路径 | 内容 | 是否入库 |
| --- | --- | --- |
| `scenes/` | 三个实验场景：仓库争夺密信（同时行动）、当铺谈判、雨夜道歉（轮流对话） | 是 |
| `experiments/` | 实验配置：模型服务、各任务的模型与 effort、每次运行的预算 | 是 |
| `evaluation/` | 评估清单 | 是 |
| `runs/` | 运行记录、对照组与候选稿 | 否 |
| `packets/` | 发给评价者的评估包与答案键 | 否 |
| `DECISION.md` | 实验前确定的门槛与实验后的结论 | 是 |

## 实验步骤

1. **确定门槛**：与评价者一同确定“转折质量”“采纳意愿”的判定门槛，以及可接受的单场景费用与等待时间，写入 `DECISION.md`。实验后不调整。
2. **配置**：设置环境变量 `ANTHROPIC_API_KEY`（或实验配置中指定的其他变量）。每条命令在真实调用前都会显示预计费用并请你确认。
3. **实验组**：每个场景运行 3 至 5 次，再为每次运行生成节拍表、候选稿与事件梗概。

   ```bash
   pnpm m0 run m0/scenes/warehouse.yaml --runs 3
   ```

   ```bash
   pnpm m0 narrate <运行标识> --pov shen_yan
   ```

   需要检查某次运行时，生成查看页：

   ```bash
   pnpm m0 view <运行标识>
   ```

4. **对照组**：同一场景的全部设定一次交给同一模型，写出正文与事件梗概。

   ```bash
   pnpm m0 baseline m0/scenes/warehouse.yaml --runs 3
   ```

5. **导演提议与批量推演**：
   - 导演提议有两种触发方式，作为两个实验条件：`stalemate` 只在检测到僵局后提议，`curve` 按张力曲线在每个回合边界提议。条件分别记为 `director_stalemate` 与 `director_curve`。

     ```bash
     pnpm m0 run m0/scenes/warehouse.yaml --runs 3 --director stalemate
     ```

     ```bash
     pnpm m0 run m0/scenes/warehouse.yaml --runs 3 --director curve --curve "前三轮蓄势，第五轮爆发"
     ```

   - 批量推演后由作者挑选（条件记为 `batch_pick`）：并行运行多次，按结局归类，作者从归类结果中选一次运行，再用 `narrate` 生成样本。

     ```bash
     pnpm m0 run m0/scenes/warehouse.yaml --runs 8 --parallel 4
     ```

     ```bash
     pnpm m0 outcomes <运行标识…>
     ```

   归类文件写在 `m0/runs/outcomes-<标识>.md`，列出每种结局的次数、对应的运行与代表运行的关键转折（物品易手、伤势变化、离场、机关触发、导演事件）。僵局检测默认开启，摘要与查看页中会标出检测到的僵局。
6. **生成评估包**：按 `evaluation/round1.example.yaml` 写好清单，生成评估包。每位评价者一个文件夹，答案键在 `_key/`，不要分发。

   ```bash
   pnpm m0 report m0/evaluation/round1.yaml
   ```

7. **汇总**：收回评价者填好的 `评分表.csv`，放回各自的文件夹后汇总，结果写入 `_key/analysis.md`。

   ```bash
   pnpm m0 report analyze --out m0/packets/round1
   ```

8. **结论**：按第 1 步的门槛写出继续、调整或转向的结论（M0-13）。

## 动机可达性检验（I05 可行性）

对一个情节点，采样角色在该处的决策，统计选择指定行动的比例与未选择时的理由：

```bash
pnpm m0 motive-check m0/scenes/warehouse.yaml --actor wei_qi --expect attack:shen_yan --samples 5
```

## 使用 OpenAI 写法的服务

默认配置使用 Anthropic。DeepSeek、通义千问、Kimi、智谱、OpenRouter、OpenAI 官方接口与本地的 Ollama、vLLM 等使用 OpenAI 写法（Chat Completions）的服务，按 `experiments/openai-compatible.example.yaml` 复制一份配置，填好模型、能力与价格后用 `--experiment` 指定：

```bash
pnpm m0 run m0/scenes/warehouse.yaml --experiment m0/experiments/openai-compatible.yaml
```

只支持 JSON 模式的服务把 `structuredOutput` 设为 `json_object`；服务不认识 `max_tokens` 或 `stream_options` 时，在服务配置中调整 `maxTokensField`、`streamUsage`。

## 费用

施工文档估算单次推演（8 回合、约 40 次调用）约 2 至 5 美元，节拍表、候选稿与梗概另需 3 次调用。僵局判断（默认开启）与导演提议（开启时）按调用次数的上限计入运行前的估算。默认配置中每次运行的预算上限为 6 美元，超出时运行以“预算”结束，已完成的结果保留。

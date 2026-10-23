import { mayBeBilled, type LlmCallRow, type UsageTotals } from '@fudiao/store';
import { useApp } from './store-context';

/** 任务种类的中文名（术语表）。 */
const TASKS: Readonly<Record<string, string>> = {
  character_action: '角色行动',
  semantic_ruling: '语义裁决',
  belief_update: '认知更新',
  judgement: '判断',
  scene_draft: '场景配置草稿',
  beat_sheet: '节拍表',
  candidate_text: '候选稿正文',
  selection_edit: '选区操作',
  plan_draft: '章节计划草稿',
  writer: '写手成章',
  memory: '长篇记忆',
  relation_changes: '人物关系变化',
  review: '审核',
  director: '导演提议',
  reader: '读者代理',
  motive_check: '动机检验',
  self_test: '能力自检',
  connection_test: '连接测试',
  web_search: '联网搜索',
};

const STATUS: Readonly<Record<LlmCallRow['status'], string>> = {
  completed: '完成',
  truncated: '截断',
  refused: '拒答',
  cancelled: '已取消',
  error: '失败',
};

const n = (v: number) => v.toLocaleString('zh-CN');
const usd = (v: number) => `$${v.toFixed(4)}`;

/** 费用：按估计计入的与未知的部分明确标出（B19）。 */
function costText(t: UsageTotals): string {
  const unknown = t.unknownCost - t.estimatedCalls;
  if (unknown > 0 && unknown === t.calls) return '未知';
  const parts = [
    ...(t.estimatedCalls > 0 ? [`含 ${t.estimatedCalls} 次按估计计入`] : []),
    ...(unknown > 0 ? [`另有 ${unknown} 次费用未知`] : []),
  ];
  const total = usd(t.cost + t.estimatedCost);
  return parts.length === 0 ? total : `${unknown > 0 ? `${total} 以上` : `约 ${total}`}（${parts.join('，')}）`;
}

/** 一次调用的费用：没有用量的按请求的最坏估计（输入估计加输出上限）注明“估计”；还没开始回复就失败的不计费。 */
function callCost(c: LlmCallRow): string {
  if (c.cost !== null) return usd(c.cost);
  if (!mayBeBilled(c)) return '—';
  return c.costEstimate === null ? '未知' : `估计不超过 ${usd(c.costEstimate)}`;
}

function TotalsCells({ t }: { readonly t: UsageTotals }) {
  return (
    <>
      <td>{n(t.calls)}</td>
      <td>{n(t.inputTokens)}</td>
      <td>{n(t.cacheReadTokens)}</td>
      <td>{n(t.outputTokens)}</td>
      <td>{costText(t)}</td>
    </>
  );
}

const HEAD = (
  <>
    <th scope="col">调用次数</th>
    <th scope="col">输入 Token</th>
    <th scope="col">缓存命中 Token</th>
    <th scope="col">输出 Token</th>
    <th scope="col">费用</th>
  </>
);

/** 用量与费用（需求 B19、B36）：本作品的模型调用汇总与最近的调用记录。 */
export function UsagePanel() {
  const usage = useApp((s) => s.usage);
  const showPanel = useApp((s) => s.showPanel);
  return (
    <section aria-label="用量与费用" className="sources usage">
      <div className="history-head">
        <h2>用量与费用</h2>
        <button type="button" onClick={() => void showPanel('chapter')}>
          返回正文
        </button>
      </div>
      <p className="muted">
        费用按“模型服务”中配置的价格估算。服务没有返回用量、或回复到一半断开（可能已计费）时，按请求估计的上限（输入估计加输出上限）计入并注明是估计；没有配置价格时费用记为未知。实际费用以服务商账单为准。
      </p>
      {usage === null ? null : (
        <>
          <table className="source-table" aria-label="用量合计">
            <thead>
              <tr>
                <th scope="col">范围</th>
                {HEAD}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">本作品</th>
                <TotalsCells t={usage.summary.total} />
              </tr>
              {usage.summary.byTask.map((t) => (
                <tr key={`task-${t.task}`}>
                  <th scope="row">{TASKS[t.task] ?? t.task}</th>
                  <TotalsCells t={t} />
                </tr>
              ))}
              {usage.summary.byModel.map((m) => (
                <tr key={`model-${m.provider}-${m.model}`}>
                  <th scope="row">模型 {m.model}</th>
                  <TotalsCells t={m} />
                </tr>
              ))}
            </tbody>
          </table>
          <h3>最近的调用</h3>
          {usage.recent.length === 0 ? (
            <p className="muted">还没有模型调用。</p>
          ) : (
            <table className="source-table" aria-label="最近的调用">
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">任务</th>
                  <th scope="col">模型</th>
                  <th scope="col">模板</th>
                  <th scope="col">结果</th>
                  <th scope="col">输入 / 输出 Token</th>
                  <th scope="col">费用</th>
                </tr>
              </thead>
              <tbody>
                {usage.recent.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{new Date(c.finishedAt).toLocaleString('zh-CN')}</th>
                    <td>{TASKS[c.taskKind] ?? c.taskKind}</td>
                    <td>{c.servedModel !== null && c.servedModel !== c.model ? `${c.model} → ${c.servedModel}` : c.model}</td>
                    <td>
                      {c.templateId} v{c.templateVersion}
                    </td>
                    <td>{STATUS[c.status]}</td>
                    <td>{c.usage === null ? '未知' : `${n(c.usage.input + c.usage.cacheRead)} / ${n(c.usage.output)}`}</td>
                    <td>{callCost(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

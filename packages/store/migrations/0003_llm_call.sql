-- 模型调用记录（需求 B19、B36，施工文档第四章 llm_call）：每次调用的服务、模型、参数、模板版本、用量、费用与响应。
-- 带步骤键的调用先查这里的完成记录，恢复时不重复调用、不重复计费（硬性规则 10）。不保存请求头与凭据。

CREATE TABLE llm_call (
  id TEXT PRIMARY KEY,
  -- 推演步骤的确定键；选区操作等一次性调用没有步骤键。
  step_key TEXT,
  task_kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  -- 实际提供服务的模型（拒答回退时与 model 不同）；调用失败时为 NULL。
  served_model TEXT,
  -- 发送的参数（输出上限、思考深度等），JSON 对象。
  params TEXT NOT NULL CHECK (json_valid(params) AND json_type(params) = 'object'),
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'truncated', 'refused', 'cancelled', 'error')),
  -- 服务未返回用量时为 NULL（费用记为未知）。
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  -- 美元；价格未配置或用量未知时为 NULL。
  cost REAL,
  -- 调用结果（LlmResult，含文本）或错误（LlmError），JSON。
  response TEXT CHECK (response IS NULL OR json_valid(response)),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  CHECK ((status = 'error') = (error IS NOT NULL)),
  CHECK ((input_tokens IS NULL) = (output_tokens IS NULL))
) STRICT;

CREATE INDEX llm_call_by_step ON llm_call (step_key, finished_at) WHERE step_key IS NOT NULL;
CREATE INDEX llm_call_by_time ON llm_call (finished_at);

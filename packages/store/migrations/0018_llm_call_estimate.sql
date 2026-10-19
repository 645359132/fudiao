-- 调用记录的费用估计（审查 2026-10-19）：服务没有返回用量、或已经开始回复后出错（可能已计费）时，实际费用未知，
-- 按请求的最坏估计（输入估计加输出上限，已知部分用量时输入取实际值）记下美元数。推演的预算接着计入它，
-- 用量页把它与实际费用分开列出并注明是估计。价格未配置、或不可能计费（还没收到回复就失败）时为 NULL。
ALTER TABLE llm_call ADD COLUMN cost_estimate REAL CHECK (cost_estimate IS NULL OR (cost IS NULL AND cost_estimate >= 0));

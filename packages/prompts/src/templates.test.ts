import { describe, expect, it } from 'vitest';
import { TEMPLATE_SOURCES } from './generated/templates';

describe('模板', () => {
  // OpenAI 兼容接口的 JSON 模式（response_format: json_object）要求提示词中出现 “JSON” 一词。
  it.each(Object.entries(TEMPLATE_SOURCES).filter(([, source]) => /^output:/m.test(source)))('%s 的结构化输出提示中提到 JSON', (_, source) => {
    expect(source).toMatch(/json/i);
  });
});

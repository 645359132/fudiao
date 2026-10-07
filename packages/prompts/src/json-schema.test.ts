import { describe, expect, it } from 'vitest';
import { modelJsonSchema } from './json-schema';
import {
  ActionProposal,
  BeatSheetOutput,
  BeliefUpdateOutput,
  EvidenceJudgementOutput,
  SceneDraftOutput,
  SemanticRulingOutput,
} from './schemas';

const all = { ActionProposal, SemanticRulingOutput, BeliefUpdateOutput, EvidenceJudgementOutput, BeatSheetOutput, SceneDraftOutput };

function walk(node: unknown, visit: (n: Readonly<Record<string, unknown>>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node !== null && typeof node === 'object') {
    visit(node as Readonly<Record<string, unknown>>);
    Object.values(node).forEach((n) => walk(n, visit));
  }
}

describe.each(Object.entries(all))('%s 的 JSON Schema', (_name, schema) => {
  const json = modelJsonSchema(schema);

  it('每个对象都禁止额外字段，且全部字段必填', () => {
    walk(json, (node) => {
      if (node['type'] !== 'object' || node['properties'] === undefined) return;
      expect(node['additionalProperties']).toBe(false);
      expect([...(node['required'] as string[])].sort()).toEqual(Object.keys(node['properties'] as object).sort());
    });
  });

  it('不含结构化输出不支持的约束', () => {
    const text = JSON.stringify(json);
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'pattern', '$schema']) {
      expect(text).not.toContain(`"${key}"`);
    }
  });
});

describe('本地校验仍保留被去掉的约束', () => {
  it('相信程度超出 0 到 1 时校验失败', () => {
    const bad = { add: [{ content: 'x', about: [], confidence: 2, concerning: null }], revise: [], retract: [] };
    expect(BeliefUpdateOutput.safeParse(bad).success).toBe(false);
  });
});

// 测试模型：按请求的步骤键与模板生成合法的 JSON，不访问任何模型服务。仅供测试使用。
import { requestHash, CONSERVATIVE_CAPABILITIES, type LlmPort, type LlmRequest, type LlmResult, type ModelProfile } from '@novel-writer/llm';
import type {
  ActionProposal,
  BeatSheetOutput,
  BeliefUpdateOutput,
  EvidenceJudgementOutput,
  SemanticRulingOutput,
} from '@novel-writer/prompts';
import { ok } from '@novel-writer/shared';
import type { RunConfig } from '../config';

export type CallContext = {
  readonly request: LlmRequest;
  /** 步骤键的各段：运行、回合、步骤、对象（角色或裁决请求）、尝试次数。 */
  readonly round: number;
  readonly step: string;
  readonly subject: string;
  readonly attempt: number;
  readonly text: string;
};

export type Policy = {
  readonly character_action?: (ctx: CallContext) => ActionProposal;
  readonly semantic_ruling?: (ctx: CallContext) => SemanticRulingOutput;
  readonly belief_update?: (ctx: CallContext) => BeliefUpdateOutput;
  readonly judgement?: (ctx: CallContext) => EvidenceJudgementOutput;
  readonly beat_sheet?: (ctx: CallContext) => BeatSheetOutput;
  /** 正文类任务直接返回文字。 */
  readonly candidate_text?: (ctx: CallContext) => string;
};

export const waitProposal = (overrides: Partial<ActionProposal> = {}): ActionProposal => ({
  kind: 'wait',
  target: null,
  item: null,
  toZone: null,
  utterance: null,
  interruptAfter: null,
  intent: '先看清局面',
  rationale: '不知道对方的底细，先观望',
  beliefRefs: [],
  innerThought: '心里发紧',
  inferences: [],
  ...overrides,
});

const defaults: Required<Policy> = {
  beat_sheet: (ctx) => ({
    beats: [...new Set([...ctx.text.matchAll(/\[([\w-]+:\d+:\d+)\]/g)].map((m) => m[1] ?? ''))].map((ref) => ({
      ref,
      treatment: 'brief' as const,
      note: '',
      withhold: false,
    })),
  }),
  candidate_text: () => '雨下得更紧了。他没有回头。',
  character_action: () => waitProposal(),
  semantic_ruling: () => ({ rationale: '按常理推断', effects: [], occurrences: [], uncertainties: [] }),
  belief_update: () => ({ add: [], revise: [], retract: [] }),
  judgement: (ctx) => ({
    judgements: [...ctx.text.matchAll(/推测 \[([^\]]+)\]/g)].map((m) => ({
      inference: m[1] ?? '',
      hit: false,
      supported: true,
      explanation: '有线索支持',
    })),
  }),
};

export function contextOf(request: LlmRequest): CallContext {
  const key = (request.stepKey ?? '').split('#')[0] ?? '';
  // 裁决请求的标识本身含冒号（如 1:r0），尝试次数取最后一段，对象取中间各段。
  const parts = key.split(':');
  const [, round = '0', step = ''] = parts;
  const subject = parts.slice(3, -1).join(':');
  const attempt = parts.at(-1) ?? '0';
  const text = [...request.system.map((s) => s.text), ...request.messages.map((m) => m.content)].join('\n');
  return { request, round: Number(round), step, subject, attempt: Number(attempt), text };
}

export function fakeModel(policy: Policy = {}, options: { delay?: (ctx: CallContext) => number } = {}) {
  const calls: CallContext[] = [];
  const port: LlmPort = {
    async complete(request) {
      const ctx = contextOf(request);
      calls.push(ctx);
      const delay = options.delay?.(ctx) ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const p = { ...defaults, ...policy };
      // 评估用的两种结构化输出按输出 schema 区分，其余按任务种类。
      const output =
        request.output?.name === 'BaselineOutput'
          ? { synopsis: ['两人在雨夜对峙', '一方先退了一步'], text: p.candidate_text(ctx) }
          : request.output?.name === 'SynopsisOutput'
            ? { synopsis: ['两人试探', '局面僵持'] }
            : request.task === 'character_action'
          ? p.character_action(ctx)
          : request.task === 'semantic_ruling'
            ? p.semantic_ruling(ctx)
            : request.task === 'belief_update'
              ? p.belief_update(ctx)
              : request.task === 'beat_sheet'
                ? p.beat_sheet(ctx)
                : request.task === 'candidate_text'
                  ? p.candidate_text(ctx)
                  : p.judgement(ctx);
      const result: LlmResult = {
        outcome: 'completed',
        text: typeof output === 'string' ? output : JSON.stringify(output),
        usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        provider: request.model.provider,
        servedModel: request.model.model,
        stopReason: 'end_turn',
        fallbackUsed: false,
        requestHash: requestHash(request),
      };
      return ok(result);
    },
  };
  return { port, calls };
}

export const testProfile: ModelProfile = {
  provider: 'test',
  model: 'test-model',
  capabilities: { ...CONSERVATIVE_CAPABILITIES, structuredOutput: 'native', selfTestPassed: true },
  prices: { input: 4, output: 20 },
};

export function testConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  const model = { profile: testProfile, maxOutputTokens: 2_000 };
  return {
    protocol: 'simultaneous',
    mode: 'auto',
    maxRounds: 3,
    seed: 7,
    maxProposalAttempts: 2,
    maxRepairs: 1,
    models: { character_action: model, semantic_ruling: model, belief_update: model, judgement: model },
    ...overrides,
  };
}

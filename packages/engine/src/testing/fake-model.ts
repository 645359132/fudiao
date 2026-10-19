// 测试模型：按请求的步骤键与模板生成合法的 JSON，不访问任何模型服务。仅供测试使用。
import { requestHash, CONSERVATIVE_CAPABILITIES, type LlmPort, type LlmRequest, type LlmResult, type ModelProfile } from '@fudiao/llm';
import type {
  ActionProposal,
  BeatSheetOutput,
  BeliefUpdateOutput,
  DirectorProposalOutput,
  EvidenceJudgementOutput,
  SemanticRulingOutput,
  StalemateJudgementOutput,
} from '@fudiao/prompts';
import { ok } from '@fudiao/shared';
import type { RunConfig } from '../config';

export type CallContext = {
  readonly request: LlmRequest;
  /** 步骤键的各段：运行、回合、步骤、对象（角色或裁决请求）、尝试次数。 */
  readonly round: number;
  readonly step: string;
  readonly subject: string;
  readonly attempt: number;
  /** 作者继续或改认知后的重做序号（步骤键末尾的 :rN），没有时为 0。 */
  readonly redo: number;
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
  readonly stalemate?: (ctx: CallContext) => StalemateJudgementOutput;
  readonly director?: (ctx: CallContext) => DirectorProposalOutput;
};

export const waitProposal = (overrides: Partial<ActionProposal> = {}): ActionProposal => ({
  kind: 'wait',
  target: null,
  item: null,
  toZone: null,
  utterance: null,
  description: null,
  interruptAfter: null,
  intent: '先看清局面',
  rationale: '不知道对方的底细，先观望',
  beliefRefs: [],
  innerThought: '心里发紧',
  triggered: null,
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
  stalemate: () => ({ type: 'none', explanation: '' }),
  director: () => ({ propose: false, rationale: '局面仍在推进', event: null }),
  character_action: () => waitProposal(),
  semantic_ruling: () => ({ rationale: '按常理推断', effects: [], occurrences: [], uncertainties: [] }),
  belief_update: () => ({ add: [], revise: [], retract: [] }),
  judgement: (ctx) => ({
    judgements: [...ctx.text.matchAll(/推测 \[([^\]]+)\] 对照秘密 \[([^\]]+)\]/g)].map((m) => ({
      inference: m[1] ?? '',
      secret: m[2] ?? '',
      hit: false,
      supported: true,
      explanation: '有线索支持',
    })),
  }),
};

export function contextOf(request: LlmRequest): CallContext {
  const full = (request.stepKey ?? '').split('#')[0] ?? '';
  const redo = /:r(\d+)$/.exec(full);
  const key = redo === null ? full : full.slice(0, -redo[0].length);
  // 裁决请求的标识本身含冒号（如 1:r0），尝试次数取最后一段，对象取中间各段。
  const parts = key.split(':');
  const [, round = '0', step = ''] = parts;
  const subject = parts.slice(3, -1).join(':');
  const attempt = parts.at(-1) ?? '0';
  const text = [...request.system.map((s) => s.text), ...request.messages.map((m) => m.content)].join('\n');
  return { request, round: Number(round), step, subject, attempt: Number(attempt), redo: Number(redo?.[1] ?? 0), text };
}

export type FakeOptions = {
  readonly delay?: (ctx: CallContext) => number;
  /** 让某次调用以截断或拒答结束（输出不完整）。 */
  readonly outcome?: (ctx: CallContext) => 'truncated' | 'refused' | undefined;
};

export function fakeModel(policy: Policy = {}, options: FakeOptions = {}) {
  const calls: CallContext[] = [];
  const port: LlmPort = {
    async complete(request, callOptions = {}) {
      const ctx = contextOf(request);
      calls.push(ctx);
      const delay = options.delay?.(ctx) ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const ended = callOptions.signal?.aborted === true ? 'cancelled' : options.outcome?.(ctx);
      const p = { ...defaults, ...policy };
      // 评估用的两种结构化输出按输出 schema 区分，其余按任务种类。
      const byOutput: Readonly<Record<string, () => unknown>> = {
        BaselineOutput: () => ({ synopsis: ['两人在雨夜对峙', '一方先退了一步'], text: p.candidate_text(ctx) }),
        SynopsisOutput: () => ({ synopsis: ['两人试探', '局面僵持'] }),
        // 僵局判断与证据链判断同属 judgement 任务，按输出区分。
        StalemateJudgementOutput: () => p.stalemate(ctx),
      };
      const byTask: Readonly<Partial<Record<LlmRequest['task'], () => unknown>>> = {
        character_action: () => p.character_action(ctx),
        semantic_ruling: () => p.semantic_ruling(ctx),
        belief_update: () => p.belief_update(ctx),
        beat_sheet: () => p.beat_sheet(ctx),
        candidate_text: () => p.candidate_text(ctx),
        director: () => p.director(ctx),
      };
      const output = (byOutput[request.output?.name ?? ''] ?? byTask[request.task] ?? (() => p.judgement(ctx)))();
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      const result: LlmResult = {
        outcome: ended ?? 'completed',
        text: ended === undefined ? text : text.slice(0, 10),
        usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        provider: request.model.provider,
        servedModel: request.model.model,
        stopReason: ended === 'truncated' ? 'max_tokens' : 'end_turn',
        ...(ended === 'refused' && { refusal: { category: 'test', explanation: null } }),
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
    // 测试默认关闭僵局检测与导演，由专门的测试开启。
    stalemate: { enabled: false, window: 3 },
    director: { enabled: false, trigger: 'curve', tensionCurve: '', maxProposals: 3 },
    models: { character_action: model, semantic_ruling: model, belief_update: model, judgement: model },
    ...overrides,
  };
}

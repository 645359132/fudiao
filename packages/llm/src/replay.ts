import { err, ok, type Result } from '@fudiao/shared';
import { requestHash } from './request-hash';
import type { CallOptions, LlmError, LlmPort, LlmRequest, LlmResult, TaskKind } from './types';

/**
 * 录制回放样本。按请求哈希匹配；只保存请求的描述与模型结果，
 * 不含请求头与凭据（硬性规则 15）。
 */
export type ReplaySample = {
  readonly requestHash: string;
  readonly task: TaskKind;
  readonly template: { readonly id: string; readonly version: string };
  readonly provider: string;
  readonly model: string;
  /** 回放时按原顺序发出的文本片段。 */
  readonly chunks: readonly string[];
  readonly result: Omit<LlmResult, 'requestHash'>;
};

export interface SampleSource {
  find(hash: string): ReplaySample | undefined;
}

export interface SampleSink {
  save(sample: ReplaySample): void | Promise<void>;
}

/** 回放适配器：持续集成与测试使用。找不到样本时报错，不会悄悄联网（硬性规则 14）。 */
export class ReplayAdapter implements LlmPort {
  constructor(private readonly source: SampleSource) {}

  complete(request: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
    const hash = requestHash(request);
    const sample = this.source.find(hash);
    if (sample === undefined) {
      return Promise.resolve(
        err({
          code: 'replay_missing',
          message: `没有录制样本：${request.template.id}@${request.template.version}（${hash.slice(0, 12)}）`,
        }),
      );
    }
    for (const delta of sample.chunks) options.onEvent?.({ type: 'text', delta });
    if (sample.result.usage !== null) options.onEvent?.({ type: 'usage', usage: sample.result.usage });
    return Promise.resolve(ok({ ...sample.result, requestHash: hash }));
  }
}

/** 录制适配器：包装真实适配器，只在本地手动运行的实验中使用。取消的调用不录制。 */
export class RecordingAdapter implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly sink: SampleSink,
  ) {}

  async complete(request: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
    const chunks: string[] = [];
    const result = await this.inner.complete(request, {
      ...options,
      onEvent: (event) => {
        if (event.type === 'text') chunks.push(event.delta);
        options.onEvent?.(event);
      },
    });
    if (result.ok && result.value.outcome !== 'cancelled') {
      const { requestHash: hash, ...rest } = result.value;
      await this.sink.save({
        requestHash: hash,
        task: request.task,
        template: request.template,
        provider: request.model.provider,
        model: request.model.model,
        chunks,
        result: rest,
      });
    }
    return result;
  }
}

/** 内存中的样本集，测试与组装样本文件时使用。 */
export function memorySamples(initial: readonly ReplaySample[] = []) {
  const byHash = new Map(initial.map((s) => [s.requestHash, s]));
  return {
    find: (hash: string) => byHash.get(hash),
    save: (sample: ReplaySample) => {
      byHash.set(sample.requestHash, sample);
    },
    all: (): ReplaySample[] => [...byHash.values()],
  };
}

import type { NetEvent, NetRequest, NetTransport } from '@fudiao/llm';
import type { Invoke } from './tauri-sql';

/** Tauri 的 Channel（`@tauri-apps/api/core`）；以参数注入，测试中替换为假实现。 */
export type ChannelLike<T> = { onmessage: (message: T) => void };

/**
 * 凭据代理的传输层：Rust 命令 `net_fetch` 校验目标地址、注入凭据并转发，响应经 Channel 流式回传；`net_cancel` 中断。
 * 代理拒绝时（`unknown_provider`、`host_not_allowed` 等）invoke 以错误对象拒绝。
 */
export function tauriNet(invoke: Invoke, channel: () => ChannelLike<NetEvent>): NetTransport {
  return {
    async send(request: NetRequest, onEvent) {
      const events = channel();
      events.onmessage = onEvent;
      await invoke<void>('net_fetch', { request, channel: events });
    },
    async cancel(id) {
      await invoke<boolean>('net_cancel', { id });
    },
  };
}

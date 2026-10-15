// 三个服务的适配器（含官方 SDK）。界面经动态导入在第一次调用模型时载入，启动时不必解析 SDK。
export { AnthropicAdapter } from './anthropic';
export { OpenAIChatAdapter } from './openai-chat';
export { OpenAIAdapter } from './openai-responses';

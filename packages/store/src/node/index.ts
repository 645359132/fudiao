// 依赖 Node 文件系统的实现，只在 M0 命令行与测试中使用；桌面端使用 SQLite 实现。
export { jsonlCallLog, jsonlEventStore } from './jsonl';

import { describe, expect, it } from 'vitest';
import { parseCommand } from './commands';

describe('parseCommand', () => {
  it('无参数时显示帮助', () => {
    expect(parseCommand([])).toEqual({ ok: true, value: 'help' });
  });

  it('识别预定的命令', () => {
    expect(parseCommand(['run', 'm0/scenes/warehouse.yaml'])).toEqual({ ok: true, value: 'run' });
  });

  it('未知命令返回错误而不是抛出异常', () => {
    expect(parseCommand(['deploy'])).toEqual({ ok: false, error: '未知命令：deploy' });
  });
});

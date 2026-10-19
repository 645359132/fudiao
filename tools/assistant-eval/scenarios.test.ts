import { rmSync } from 'node:fs';
import { err, ok } from '@fudiao/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppService } from '../../apps/desktop/src/app/service';
import { fsDeps, type TestDeps } from '../../apps/desktop/src/testing/fs-deps';
import { selectionFor } from './scenario';
import { SCENARIOS, withFaults } from './scenarios';

// 大部头的场景要建 120 章与 60 个人物。
vi.setConfig({ testTimeout: 120_000 });

const all: TestDeps[] = [];
afterEach(async () => {
  for (const d of all.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

type Port = Parameters<typeof withFaults>[0];
type Request = Parameters<Port['complete']>[0];

describe('AI 助手试用的场景（M5-24）', () => {
  it('每个场景的作品都能建好（不调用模型），选中的文字在作品里找得到', async () => {
    expect(new Set(SCENARIOS.map((s) => s.key)).size).toBe(SCENARIOS.length);
    for (const scenario of SCENARIOS) {
      expect(scenario.turns.length, scenario.key).toBeGreaterThan(0);
      if (scenario.prepare === undefined) continue;
      const deps = fsDeps();
      all.push(deps);
      const app = createAppService(deps);
      expect((await app.loadLibrary()).ok).toBe(true);
      expect(await scenario.prepare(app), scenario.key).toEqual(ok(undefined));
      for (const turn of scenario.turns) {
        if (turn.select !== undefined) expect(await selectionFor(app, turn.select), turn.say).not.toBeNull();
      }
      expect(deps.llmRequests).toHaveLength(0);
    }
  });

  it('故障只注入在助手的请求上：连接中断后调用器的重试照常发出，不合格的输出之后的修正请求照常发出', async () => {
    const sent: string[] = [];
    const port: Port = {
      complete(request) {
        sent.push(`${request.task}${request.repairOf === undefined ? '' : '（修正）'}`);
        return Promise.resolve(err({ code: 'server', message: '' }));
      },
    };
    const request = (task: string, repair = false) => ({ task, model: { provider: 'p', model: 'm' }, ...(repair && { repairOf: ['不合格'] }) }) as unknown as Request;
    const lines: string[] = [];
    const faulty = withFaults(port, { 1: 'network', 3: 'invalid' }, (l) => lines.push(l));
    expect(await faulty.complete(request('assistant'))).toMatchObject({ ok: false, error: { code: 'network' } });
    // 重试：同一次请求，不再注入。
    await faulty.complete(request('assistant'));
    await faulty.complete(request('writer'));
    await faulty.complete(request('assistant'));
    expect(await faulty.complete(request('assistant'))).toMatchObject({ ok: true, value: { text: expect.stringContaining('没有动作') } });
    await faulty.complete(request('assistant', true));
    await faulty.complete(request('assistant'));
    expect(sent).toEqual(['assistant', 'writer', 'assistant', 'assistant（修正）', 'assistant']);
    expect(lines).toEqual(['  [故障] 第 1 次助手请求：连接中断', '  [故障] 第 3 次助手请求：不合格的输出']);
  });
});

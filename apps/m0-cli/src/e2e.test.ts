import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, type RunConfig } from '@novel-writer/engine';
import { fakeModel, testConfig, waitProposal, type Policy } from '@novel-writer/engine/testing';
import { memoryCallLog, memorySamples, RecordingAdapter, ReplayAdapter } from '@novel-writer/llm';
import { memoryEventStore } from '@novel-writer/store';
import { jsonlCallLog, jsonlEventStore } from '@novel-writer/store/node';
import { afterAll, describe, expect, it } from 'vitest';
import { loadSceneFile } from './scene-file';

// 录制回放的端到端测试：用测试模型跑完三个实验场景并录成样本，再不联网地回放，事件记录一致。

const AT = '2026-10-07T00:00:00.000Z';
const dir = fileURLToPath(new URL('../../../m0/scenes/', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'novel-writer-e2e-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy: Policy = {
  character_action: (ctx) =>
    ctx.round % 2 === 1
      ? waitProposal({ kind: 'speak', utterance: { sentences: ['你先说。', '我听着。'], volume: 'normal' } })
      : waitProposal({ kind: 'observe' }),
};

describe.each(readdirSync(dir).filter((f) => f.endsWith('.yaml')))('%s', (file) => {
  const loaded = loadSceneFile(readFileSync(join(dir, file), 'utf8'));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  const { scene, run } = loaded.value;
  const config: RunConfig = testConfig({
    protocol: run.protocol,
    maxRounds: Math.min(run.maxRounds, 4),
    ...(run.firstSpeaker !== undefined && { firstSpeaker: run.firstSpeaker }),
  });

  it('用测试模型录制，再用录制样本不联网地回放，事件记录一致', async () => {
    const samples = memorySamples();
    const recordingStore = jsonlEventStore(join(root, file));
    const recorder = createEngine({
      llm: new RecordingAdapter(fakeModel(policy).port, samples),
      events: recordingStore,
      calls: jsonlCallLog(join(root, file), 'run1'),
      now: () => AT,
    });
    await recorder.start('run1', scene, config);
    const recorded = await recorder.run('run1', scene);
    expect(recorded.ok && recorded.value.phase).toBe('Ended');
    expect(samples.all().length).toBeGreaterThan(0);

    const replayStore = memoryEventStore();
    const replayer = createEngine({ llm: new ReplayAdapter(samples), events: replayStore, calls: memoryCallLog(), now: () => AT });
    await replayer.start('run1', scene, config);
    const replayed = await replayer.run('run1', scene);
    expect(replayed.ok && replayed.value.phase).toBe('Ended');

    const payloads = async (store: { read(id: string): Promise<readonly { payload: unknown }[]> }) =>
      (await store.read('run1')).map((e) => e.payload);
    expect(await payloads(replayStore)).toEqual(await payloads(recordingStore));
  });
});

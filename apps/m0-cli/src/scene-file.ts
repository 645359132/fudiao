import { ActorId, parseScene, type Scene, type SceneError } from '@fudiao/domain';
import { err, ok, type Result } from '@fudiao/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** 推演运行配置：回合协议与回合上限（B40）。M0-06 起由引擎定义运行配置。 */
export const RunConfig = z.object({
  protocol: z.enum(['simultaneous', 'turn_based']),
  maxRounds: z.number().int().positive(),
  /** 轮流对话中第一个开口的人。 */
  firstSpeaker: ActorId.optional(),
});
export type RunConfig = z.infer<typeof RunConfig>;

export type SceneFile = { readonly scene: Scene; readonly run: RunConfig };

export type SceneFileError =
  | { readonly code: 'yaml'; readonly message: string }
  | { readonly code: 'run'; readonly path: readonly (string | number)[] }
  | { readonly code: 'scene'; readonly errors: readonly SceneError[] };

/** 场景文件：`run` 为运行配置，`scene` 为推演场景配置。 */
export function loadSceneFile(text: string): Result<SceneFile, SceneFileError> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return err({ code: 'yaml', message: error instanceof Error ? error.message : String(error) });
  }
  const doc = (raw ?? {}) as { run?: unknown; scene?: unknown };
  const run = RunConfig.safeParse(doc.run);
  if (!run.success) {
    return err({ code: 'run', path: run.error.issues[0]?.path.filter((p) => typeof p !== 'symbol') ?? [] });
  }
  const scene = parseScene(doc.scene);
  if (!scene.ok) return err({ code: 'scene', errors: scene.error });
  const first = run.data.firstSpeaker;
  if (first !== undefined && !scene.value.actors.some((a) => a.id === first)) {
    return err({ code: 'run', path: ['firstSpeaker'] });
  }
  return ok({ scene: scene.value, run: run.data });
}

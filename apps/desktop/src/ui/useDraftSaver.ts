import { useEffect, useRef } from 'react';
import { useApp } from './store-context';

/**
 * 写作工作流里草稿表单的保存：改过没保存就切到别的步骤（表单卸载）时自动保存，回来时修改还在。
 * 返回保存函数（成功与否）；保存前先记下要保存的内容，卸载时与它比较，刚保存过的不再存一次。
 */
export function useDraftSaver<T>(runId: string, idx: number, output: unknown, draft: T | null, payload: (draft: T) => unknown): (draft: T) => Promise<boolean> {
  const edit = useApp((s) => s.editWorkflowStep);
  const latest = useRef<T | null>(draft);
  const saved = useRef(JSON.stringify(output));
  useEffect(() => {
    latest.current = draft;
  }, [draft]);
  useEffect(
    () => () => {
      const d = latest.current;
      if (d === null) return;
      const value = payload(d);
      if (JSON.stringify(value) !== saved.current) void edit(runId, idx, value);
    },
    [edit, runId, idx, payload],
  );
  return async (d: T) => {
    const value = payload(d);
    const before = saved.current;
    saved.current = JSON.stringify(value);
    const ok = await edit(runId, idx, value);
    if (!ok) saved.current = before;
    return ok;
  };
}

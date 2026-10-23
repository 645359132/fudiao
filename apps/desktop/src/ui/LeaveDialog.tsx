import { AlertDialog } from 'radix-ui';
import { useApp } from './store-context';

/**
 * 有任务在进行时要回到作品列表或关闭窗口：列出这些任务，请作者确认。
 * 停下的任务已写入的部分都保留（写手按段写入、推演事件只追加），下次打开作品可以接着做。
 */
export function LeaveDialog() {
  const leave = useApp((s) => s.leaveConfirm);
  const confirm = useApp((s) => s.confirmLeave);
  const cancel = useApp((s) => s.cancelLeave);
  const canOpenWindows = useApp((s) => s.canOpenWindows);
  const openNewWindow = useApp((s) => s.openNewWindow);
  const exit = leave?.to === 'exit';
  return (
    <AlertDialog.Root
      open={leave !== null}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="dialog leave-dialog">
          <AlertDialog.Title asChild>
            <h2>还有任务在进行</h2>
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div>
              <ul className="leave-tasks">
                {(leave?.tasks ?? []).map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <p className="muted">
                {exit ? '关闭这个窗口' : '回到作品列表'}会停下它们。已经写入的段落、长篇记忆与推演事件都保留，下次打开这部作品可以接着做；正在写的那一段没写完的部分不会保存。
              </p>
              {!exit && canOpenWindows ? <p className="muted">想同时写另一本书：在新窗口里打开作品列表，这本书在这里接着写。</p> : null}
            </div>
          </AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Cancel asChild>
              <button type="button" className="primary">
                留在这里
              </button>
            </AlertDialog.Cancel>
            {!exit && canOpenWindows ? (
              <button type="button" onClick={() => void openNewWindow(null)}>
                在新窗口打开作品列表
              </button>
            ) : null}
            <AlertDialog.Action asChild>
              <button type="button" className="danger" onClick={() => void confirm()}>
                {exit ? '停下并关闭窗口' : '停下并返回作品列表'}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

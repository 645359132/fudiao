import { useApp } from './store-context';

export function MessageBar() {
  const message = useApp((s) => s.message);
  const dismiss = useApp((s) => s.dismissMessage);
  if (message === null) return null;
  return (
    <div className="message-bar" role="alert">
      <span>{message}</span>
      <button type="button" aria-label="关闭提示" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}

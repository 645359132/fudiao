import { useState } from 'react';
import type { BackupKind } from '../app/ports';
import { useApp } from './store-context';

const KIND: Record<BackupKind, string> = {
  auto: '自动备份',
  manual: '手动备份',
  'pre-restore': '恢复前自动备份',
  'pre-migration': '升级前自动备份',
};

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** 作品备份（需求 B06）：备份列表、立即备份、从备份恢复。 */
export function BackupsPanel() {
  const backups = useApp((s) => s.backups);
  const create = useApp((s) => s.createBackup);
  const restore = useApp((s) => s.restoreBackup);
  const showPanel = useApp((s) => s.showPanel);
  const busy = useApp((s) => s.busy);
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <section aria-label="备份与恢复" className="backups">
      <div className="history-head">
        <h2>备份与恢复</h2>
        <button type="button" disabled={busy} onClick={() => void create()}>
          立即备份
        </button>
        <button type="button" onClick={() => void showPanel('chapter')}>
          返回正文
        </button>
      </div>
      <p className="muted">备份放在作品文件夹的 backups 中。打开作品时每天自动备份一次，自动备份保留最近 30 份；其他备份不会自动删除。</p>
      {backups === null || backups.length === 0 ? (
        <p className="muted">还没有备份。</p>
      ) : (
        <ul className="backup-list" aria-label="备份列表">
          {backups.map((b) => (
            <li key={b.name}>
              <span>{new Date(b.createdAt).toLocaleString('zh-CN')}</span>
              <span className="muted">{KIND[b.kind]}</span>
              <span className="muted">{size(b.sizeBytes)}</span>
              {confirming === b.name ? (
                <span className="confirm" role="group" aria-label="确认恢复备份">
                  <span>恢复前会先备份现在的作品。</span>
                  <button type="button" disabled={busy} onClick={() => void restore(b.name).then(() => setConfirming(null))}>
                    确定恢复
                  </button>
                  <button type="button" onClick={() => setConfirming(null)}>
                    取消
                  </button>
                </span>
              ) : (
                <button type="button" disabled={busy} aria-label={`恢复到 ${new Date(b.createdAt).toLocaleString('zh-CN')} 的备份`} onClick={() => setConfirming(b.name)}>
                  恢复到这份备份
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

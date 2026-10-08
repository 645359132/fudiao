import type { OpenError, RepoError } from '@fudiao/store';

export type AppError =
  | { readonly code: 'library'; readonly detail: string }
  /** 模型服务与凭据的设置问题，说明原样显示。 */
  | { readonly code: 'settings'; readonly detail: string }
  /** 作品文件夹已不存在。 */
  | { readonly code: 'missing'; readonly path: string }
  /** 文件夹里没有作品库。 */
  | { readonly code: 'not_a_work'; readonly path: string }
  | { readonly code: 'open_failed'; readonly error: OpenError }
  | { readonly code: 'repo'; readonly error: RepoError }
  | { readonly code: 'no_work' }
  | { readonly code: 'not_found' };

/** 给作者看的错误说明。 */
export function describeError(error: AppError): string {
  switch (error.code) {
    case 'library':
      return `作品列表读写失败：${error.detail}`;
    case 'settings':
      return error.detail;
    case 'missing':
      return `找不到作品文件夹：${error.path}`;
    case 'not_a_work':
      return `这个文件夹里没有作品：${error.path}`;
    case 'no_work':
      return '还没有打开作品';
    case 'not_found':
      return '找不到这一项，请刷新后重试';
    case 'open_failed':
      switch (error.error.code) {
        case 'schema_too_new':
          return '这部作品由更新版本的复调保存，请先升级复调';
        case 'checksum_mismatch':
          return '作品库的结构记录与本程序不一致，为避免损坏没有打开';
        case 'migration_failed':
          return `升级作品库失败，已保留原样：${error.error.detail}`;
        case 'io_error':
          return `无法打开作品库：${error.error.detail}`;
      }
      break;
    case 'repo':
      switch (error.error.code) {
        case 'conflict':
          return '内容已在别处修改，已重新加载';
        case 'not_found':
          return '找不到这一项，请刷新后重试';
        case 'invalid':
          return error.error.detail;
        case 'locked':
          return '这是锁定设定，先解锁才能修改或删除';
        case 'in_use':
          return '还有人物认知或说法以它为持有者，不能删除';
        case 'sql':
          return `保存失败：${error.error.error.code}`;
      }
  }
  return '操作失败';
}

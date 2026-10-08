import type { AppError } from './service';

/** 给作者看的错误说明。 */
export function describeError(error: AppError): string {
  switch (error.code) {
    case 'library':
      return `作品列表读写失败：${error.detail}`;
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
        case 'sql':
          return `保存失败：${error.error.error.code}`;
      }
  }
  return '操作失败';
}

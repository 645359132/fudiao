// 封面图片的缩放（B76）：在 WebView 里用 canvas 解码与缩放，编码为 JPEG 的 data URL。
// 封面保留原图的长宽比，长边不超过 1200 像素；作品列表用的缩略图按 3:4 从中间裁取。
import { err, ok, type Result } from '@fudiao/shared';
import type { CoverImage } from '@fudiao/store';
import type { ImagePort } from '../app/ports';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const COVER_BOX = { width: 900, height: 1200 };
const THUMBNAIL = { width: 180, height: 240 };

type Source = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

function encode(bitmap: ImageBitmap, source: Source, width: number, height: number, quality: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (g === null) throw new Error('无法创建画布');
  // 透明的 PNG 编成 JPEG 时底色会变黑，先铺白。
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, width, height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

export function canvasImages(): ImagePort {
  return {
    async prepareCover(file: Blob): Promise<Result<CoverImage, string>> {
      if (!file.type.startsWith('image/')) return err('请选一张图片（JPG、PNG 或 WebP）');
      if (file.size > MAX_FILE_BYTES) return err('图片太大：请选 20 MB 以内的图片');
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        return err('这张图片打不开，换一张试试');
      }
      try {
        const scale = Math.min(1, COVER_BOX.width / bitmap.width, COVER_BOX.height / bitmap.height);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const image = encode(bitmap, { x: 0, y: 0, width: bitmap.width, height: bitmap.height }, width, height, 0.86);
        const ratio = THUMBNAIL.width / THUMBNAIL.height;
        const cropWidth = Math.min(bitmap.width, bitmap.height * ratio);
        const cropHeight = Math.min(bitmap.height, bitmap.width / ratio);
        const crop = { x: (bitmap.width - cropWidth) / 2, y: (bitmap.height - cropHeight) / 2, width: cropWidth, height: cropHeight };
        const thumbnail = encode(bitmap, crop, THUMBNAIL.width, THUMBNAIL.height, 0.8);
        return ok({ image, thumbnail, width, height });
      } catch {
        return err('这张图片处理失败，换一张试试');
      } finally {
        bitmap.close();
      }
    },
  };
}

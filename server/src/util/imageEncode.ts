/**
 * 缩略图编码：把 Figma 导出的 PNG 转成无损 WebP，显著减小体积。
 *
 * 为什么必须「无损」：画布的像素吸管用 getImageData 读取渲染后图片的逐像素原值
 * （web/src/viewer/Canvas.tsx 的 sampleCanvas）。有损 WebP 会改变像素值，导致取色偏差。
 * 实测：无损 WebP 相比 PNG 省约 60%，且解码后像素与 PNG 逐字节一致（吸管安全）。
 *
 * 失败兜底：sharp 在个别环境（如缺少平台二进制）可能加载失败，此时回退到原始 PNG，
 * 保证导入流程不中断。可通过 THUMB_WEBP=0 全局关闭。
 */
import sharp from 'sharp';
import { config } from '../config.js';

export interface EncodedImage {
  data: Buffer;
  ext: 'webp' | 'png';
  contentType: string;
}

let warned = false;

/** 把图片 buffer 编码为体积最优且吸管安全的格式。 */
export async function encodeThumbnail(png: Buffer): Promise<EncodedImage> {
  if (!config.thumbWebp) {
    return { data: png, ext: 'png', contentType: 'image/png' };
  }
  try {
    const data = await sharp(png).webp({ lossless: true, effort: 4 }).toBuffer();
    // 极端情况下 WebP 反而更大（如已经高度优化的极小图），此时用 PNG
    if (data.length >= png.length) {
      return { data: png, ext: 'png', contentType: 'image/png' };
    }
    return { data, ext: 'webp', contentType: 'image/webp' };
  } catch (err) {
    if (!warned) {
      console.warn('[imageEncode] WebP 转码不可用，回退 PNG:', err instanceof Error ? err.message : String(err));
      warned = true;
    }
    return { data: png, ext: 'png', contentType: 'image/png' };
  }
}

import sharp from 'sharp';
import { safeFetchImage } from './safe-fetch.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;

export function imageCandidates(image) {
  const urls = [];
  if (/^https?:\/\//i.test(image?.url || '')) urls.push(image.url);
  const id = String(image?.emoji_id || '');
  if (/^[a-f0-9]{32}$/i.test(id)) {
    urls.push(`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`);
  }
  return [...new Set(urls)];
}

/** 静态图统一为 PNG；动画最多取九帧，按从左到右、从上到下的时间顺序排列。 */
export async function prepareImage(buffer) {
  if (!buffer?.length || buffer.length > MAX_BYTES) throw new Error('图片为空或超过 3 MiB');
  const options = { limitInputPixels: MAX_PIXELS };
  const metadata = await sharp(buffer, options).metadata();
  const pages = metadata.pages || 1;
  let output;
  if (pages > 1) {
    const count = Math.min(9, pages), cell = 320;
    const frames = [];
    for (let i = 0; i < count; i++) {
      const page = Math.round(i * (pages - 1) / (count - 1));
      const input = await sharp(buffer, { ...options, page, pages: 1 })
        .rotate().resize(cell, cell, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
      frames.push({ input, left: (i % 3) * cell, top: Math.floor(i / 3) * cell });
    }
    output = await sharp({ create: { width: cell * 3, height: cell * Math.ceil(count / 3), channels: 3, background: '#ffffff' } })
      .composite(frames).png().toBuffer();
  } else {
    output = await sharp(buffer, options).rotate()
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  }
  return { url: 'data:image/png;base64,' + output.toString('base64'), animated: pages > 1 };
}

export async function loadImage(image, { download = safeFetchImage } = {}) {
  const signal = AbortSignal.timeout(10000);
  for (const url of imageCandidates(image)) {
    try {
      signal.throwIfAborted();
      const buffer = await download(url, MAX_BYTES, { signal });
      return await prepareImage(buffer);
    } catch { /* 原始地址失效时再试表情 CDN；失败不把不可读图片伪装成已看见。 */ }
  }
  return null;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { extractImages, segsToText } from '../app/src/transport-onebot.js';
import { imageCandidates, loadImage, prepareImage } from '../app/src/image-input.js';

test('QQ小黄脸有具体名称，优先协议名称，未知ID不猜测', () => {
  assert.equal(segsToText([{ type: 'face', data: { id: '14' } }]), '[表情:微笑]');
  assert.equal(segsToText([{ type: 'face', data: { id: '14', raw: { faceText: '/新名称' } } }]), '[表情:新名称]');
  assert.equal(segsToText([{ type: 'face', data: { id: '99999' } }]), '[表情:ID:99999]');
});

test('收藏图片和mface保留描述、标识与sub_type', () => {
  const data = { file: 'meme.gif', url: 'https://example.com/a.gif', summary: '[疑惑]', sub_type: 1,
    emoji_id: 'a'.repeat(32), emoji_package_id: '123', file_size: 200 };
  const chain = [{ type: 'image', data }, { type: 'mface', data }];
  const images = extractImages(chain);
  assert.equal(images.length, 2);
  for (const image of images) {
    assert.equal(image.summary, '[疑惑]');
    assert.equal(image.emoji_id, data.emoji_id);
    assert.equal(image.sub_type, 1);
  }
  assert.match(segsToText(chain), /疑惑/);
});

test('图片链接失败后尝试emoji_id CDN，非法ID不拼接URL', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  const seen = [];
  const result = await loadImage({ url: 'https://example.com/expired', emoji_id: 'a'.repeat(32) }, {
    download: async url => { seen.push(url); if (seen.length === 1) throw new Error('expired'); return png; },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1], 'https://gxh.vip.qq.com/club/item/parcel/item/aa/' + 'a'.repeat(32) + '/raw300.gif');
  assert.match(result.url, /^data:image\/png;base64,/);
  assert.deepEqual(imageCandidates({ emoji_id: '../evil' }), []);
  assert.equal(await loadImage({ url: 'https://example.com/bad' }, { download: async () => Buffer.from('not an image') }), null);
});

test('GIF抽帧保留首尾和时间顺序，转换后的PNG可以被视觉模型读取', async () => {
  const pixels = Buffer.from([255, 0, 0, 0, 0, 255]);
  const gif = await sharp(pixels, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(gif).metadata()).pages, 2);
  const result = await prepareImage(gif);
  assert.equal(result.animated, true);
  const png = Buffer.from(result.url.split(',')[1], 'base64');
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 960); assert.equal(meta.height, 320);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const pixel = x => [...data.subarray((160 * info.width + x) * info.channels, (160 * info.width + x) * info.channels + 3)];
  assert.deepEqual(pixel(160), [255, 0, 0]);
  assert.deepEqual(pixel(480), [0, 0, 255]);
  assert.deepEqual(pixel(800), [255, 255, 255]);
});

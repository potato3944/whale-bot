import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationState } from '../app/src/conversation-state.js';
import { MessageWindow } from '../app/src/message-window.js';
import { handleTurn } from '../app/src/index.js';

function setup(t, limit = 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-image-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ConversationState({ dir, limit });
  const key = 'group:7';
  let id = 0;
  function append(text, images = [], other = {}) {
    const msg = { key, messageId: String(++id), userId: '22', name: '甲', text, images, isGroup: true, ...other };
    msg.conversationSeq = store.append(msg).seq;
    return msg;
  }
  return { dir, store, key, append };
}

async function turn(store, items) {
  let input;
  await handleTurn({ conversations: store, brain: { reply: async value => {
    input = value;
    return { text: '' };
  } } }, items, { engine: 'pi', dryRun: true });
  return input;
}

test('独立图片未唤醒，重启后单独 @ 仍补入图片；地址不进入快照或工具文字', async t => {
  const s = setup(t);
  const image = { url: 'https://example.com/a.png?rkey=private-signature', summary: '原图' };
  const picture = s.append('[图片]', [image]);
  const batches = [];
  const window = new MessageWindow({ dispatch: items => batches.push(items),
    schedule: () => 0, cancel() {} });
  assert.equal(window.add(picture, false), false);
  const trigger = s.append('@机器人 评价这张图');
  window.add(trigger, true);
  window.flush(s.key);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1, 'image was not in the triggering batch');
  const restored = new ConversationState({ dir: s.dir });
  const input = await turn(restored, batches[0]);
  assert.equal(input.images.length, 1);
  assert.equal(input.images[0].url, image.url);
  assert.ok(input.text.includes(`附件 1：甲（QQ 22，消息序号 ${picture.conversationSeq}）`));
  assert.ok(!input.text.includes('private-signature'));
  assert.ok(!JSON.stringify(input.snapshot).includes('private-signature'));
  assert.equal(restored.read(s.key).readThroughSeq, 0, 'supplying images does not mark them read');
  for (const name of ['qq_get_recent_messages', 'qq_get_unread_messages']) {
    const result = await input.qq.tools.find(tool => tool.name === name).execute(name, {});
    assert.ok(!JSON.stringify(result).includes('private-signature'));
  }
});

test('旧未读与当前批次图片按顺序合并，当前图片不重复，每轮最多3张', async t => {
  const s = setup(t);
  const image = n => ({ url: `https://example.com/${n}.png` });
  s.append('[图片1]', [image(1)]);
  const current = s.append('@机器人 看图', [image(2), image(3), image(4)]);
  const input = await turn(s.store, [current]);
  assert.deepEqual(input.images.map(i => i.url), [image(1).url, image(2).url, image(3).url]);
  assert.ok(input.text.includes('另有 1 张图片超过本轮 3 张上限'));
  assert.equal((input.text.match(/附件 2：/g) || []).length, 1);
});

test('不补入已读图片、其他群图片及触发消息之后的图片', async t => {
  const s = setup(t);
  s.append('[已读图]', [{ url: 'https://example.com/read.png' }]);
  s.store.markRead(s.key, 1);
  s.append('[其他群图]', [{ url: 'https://example.com/other.png' }], { key: 'group:8' });
  const trigger = s.append('@机器人 说话');
  s.append('[后到图]', [{ url: 'https://example.com/future.png' }]);
  const input = await turn(s.store, [trigger]);
  assert.deepEqual(input.images, []);
});

test('快照预算未展示的未读图片不会额外补入', async t => {
  const s = setup(t);
  s.append('先展示的文字'.repeat(20));
  const maxChars = JSON.stringify(s.store.read(s.key).messages[0]).length;
  s.append('[预算外图片]', [{ url: 'https://example.com/hidden.png' }]);
  const trigger = s.append('@机器人 看看');
  const snapshot = s.store.snapshot.bind(s.store);
  s.store.snapshot = (key, options) => snapshot(key, { ...options, maxChars });
  const input = await turn(s.store, [trigger]);
  assert.equal(input.snapshot.partial, true);
  assert.ok(!input.snapshot.messages.some(message => message.hasImages));
  assert.deepEqual(input.images, []);
});

test('附件引用随消息淘汰，旧版仅 hasImages 的缓存仍可读取', t => {
  const s = setup(t, 2);
  s.append('[图片]', [{ url: 'https://example.com/old.png' }]);
  s.append('普通消息');
  s.append('淘汰第一条');
  assert.deepEqual(s.store.read(s.key).imageRefs, {});
  assert.deepEqual(s.store.attachments(s.key, [1]), []);
  const state = s.store.read(s.key);
  delete state.imageRefs;
  state.messages[0].hasImages = true;
  s.store.write(s.key, state);
  assert.deepEqual(new ConversationState({ dir: s.dir }).attachments(s.key, [2]), []);
});

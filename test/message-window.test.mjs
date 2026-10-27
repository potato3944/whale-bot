import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageWindow } from '../app/src/message-window.js';
import { Waker } from '../app/src/wake.js';
import { handleTurn, loadConfig } from '../app/src/index.js';

function clock(opts = {}) {
  let time = 0, id = 0;
  const timers = new Map(), batches = [];
  const window = new MessageWindow({
    initialMs: opts.initialMs ?? 5000,
    extensionMs: opts.extensionMs ?? 3000,
    maxExtensions: opts.maxExtensions ?? 4,
    now: () => time,
    schedule: (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id; },
    cancel: timer => timers.delete(timer),
    dispatch: items => batches.push(items),
  });
  return { window, batches, timers,
    tick(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      time = end;
    },
    jump(ms) { time += ms; },
  };
}
const msg = (text, key = 'group:7', extra = {}) => ({ key, isGroup: true, userId: '11', name: '甲', text, ...extra });

test('初始等5秒；补充消息在原截止时间加3秒，文字和图片一并收集', () => {
  const c = clock();
  assert.equal(c.window.add(msg('路过'), false), false);
  c.window.add(msg('@bot'), true);
  c.tick(2000);
  const image = { url: 'https://example.com/meme.gif' };
  c.window.add(msg('[图片]', 'group:7', { userId: '22', images: [image] }), false);
  assert.equal(c.window.pending.get('group:7').deadline, 8000);
  c.tick(5999); assert.equal(c.batches.length, 0);
  c.tick(1);
  assert.equal(c.batches.length, 1);
  assert.equal(c.batches[0].length, 2);
  assert.deepEqual(c.batches[0][1].images, [image]);
  assert.equal(c.window.pending.size, 0);
  assert.equal(c.timers.size, 0);
});

test('延长按旧截止时间相加，不按消息到达时间重置', () => {
  const c = clock();
  c.window.add(msg('@bot'), true);
  c.tick(4000);
  c.window.add(msg('第一条补充'), true);
  assert.equal(c.window.pending.get('group:7').deadline, 8000); // 不是4+5=9秒。
  c.tick(1000);
  c.window.add(msg('第二条补充'), true);
  assert.equal(c.window.pending.get('group:7').deadline, 11000); // 不是5+5=10秒。
  c.tick(6000);
  assert.equal(c.batches.length, 1);
  assert.equal(c.batches[0].length, 3);
});

test('最多延长4次：持续发言仍在第17秒提交，截止前消息全部保留', () => {
  const c = clock();
  c.window.add(msg('@bot'), true);
  for (let i = 0; i < 4; i++) {
    c.tick(1000); c.window.add(msg('补充' + i), true);
    assert.equal(c.window.pending.get('group:7').deadline, 5000 + (i + 1) * 3000);
  }
  for (let i = 0; i < 3; i++) {
    c.tick(4000); c.window.add(msg('次数用完后继续' + i), true);
    assert.equal(c.window.pending.get('group:7').deadline, 17000);
  }
  c.tick(999); assert.equal(c.batches.length, 0);
  c.tick(1);
  assert.equal(c.batches.length, 1);
  assert.equal(c.batches[0].length, 8);
  c.window.add(msg('@bot 第二轮'), true);
  c.tick(5000);
  assert.equal(c.batches.length, 2);
});

test('私聊初始5秒，第一条不消耗延长次数，无补充时直接提交', () => {
  const c = clock();
  c.window.add(msg('你好', 'private:1'), true);
  assert.equal(c.window.pending.get('private:1').extensions, 0);
  c.tick(4999); assert.equal(c.batches.length, 0);
  c.tick(1);
  assert.equal(c.batches.length, 1);
  assert.equal(c.batches[0].length, 1);
});

test('不同会话独立；事件循环延迟不把过期消息混进上一批', () => {
  const c = clock();
  c.window.add(msg('@bot'), true);
  c.tick(1000); c.window.add(msg('@bot', 'group:8'), true);
  c.tick(4000); assert.equal(c.batches[0][0].key, 'group:7');
  c.tick(1000); assert.equal(c.batches[1][0].key, 'group:8');
  c.window.add(msg('@bot'), true);
  c.jump(6000);
  assert.equal(c.window.add(msg('过期普通消息'), false), false);
  assert.equal(c.batches.length, 3);    // 过期窗口先派发，普通消息不开启新窗
  c.window.add(msg('@bot 新一轮'), true);
  c.tick(5000); assert.equal(c.batches.length, 4);
});

test('群聊只由主人、@或关键词触发；同一消息多条件只产生一次判定', () => {
  const waker = new Waker({ ownerIds: ['99'], keywords: ['小鲸鱼'] });
  waker.setConfig('group:7', { nameMention: false, question: false, poke: false, probability: 0 });
  assert.equal(waker.shouldWake(msg('怎么做？')).wake, false);
  assert.equal(waker.shouldWake(msg('普通话', 'group:7', { userId: '99' })).reason, 'owner');
  assert.equal(waker.shouldWake(msg('小鲸鱼')).wake, true);
  assert.equal(waker.shouldWake(msg('@bot 小鲸鱼', 'group:7', { isAtMe: true })).reason, 'atMention');
});

test('群聊使用触发者身份，末尾其他群友的图片与内容一并送模型', async () => {
  const image = { url: 'https://example.com/meme.gif', summary: '疑惑' };
  let input;
  await handleTurn({ brain: { reply: async value => { input = value; return { text: '' }; } } }, [
    msg('@bot 看看', 'group:7', { triggered: true, conversationSeq: 1 }),
    msg('[图片]', 'group:7', { userId: '22', name: '乙', images: [image], conversationSeq: 2 }),
  ], { engine: 'legacy' });
  assert.equal(input.userId, '11');
  assert.equal(input.userName, '甲');
  assert.ok(input.text.includes('乙（QQ 22）'));
  assert.ok(input.text.includes('附件 1：乙（QQ 22，消息序号 2）'));
  assert.deepEqual(input.images, [image]);
});

test('配置示例：群聊私聊都初始5秒，每次加3秒，最多4次', () => {
  for (const file of ['../app/config.mock.json', '../app/config.example.json']) {
    const cfg = loadConfig(new URL(file, import.meta.url).pathname);
    assert.equal(cfg.wake.groupWindowMs, 5000);
    assert.equal(cfg.wake.privateWindowMs, 5000);
    assert.equal(cfg.wake.windowExtensionMs, 3000);
    assert.equal(cfg.wake.windowMaxExtensions, 4);
    assert.equal(cfg.wake.groupMaxWindowMs, undefined);
    assert.equal(cfg.wake.groupExtensionMs, undefined);
  }
});

test('私聊按配置延长：两秒后补充一句，截止为第8秒', () => {
  const cfg = loadConfig(new URL('../app/config.example.json', import.meta.url).pathname);
  const c = clock({ initialMs: cfg.wake.privateWindowMs,
    extensionMs: cfg.wake.windowExtensionMs, maxExtensions: cfg.wake.windowMaxExtensions });
  c.window.add(msg('第一句', 'private:1'), true);
  c.tick(2000);
  c.window.add(msg('补充一句', 'private:1'), true);
  c.tick(5999);
  assert.equal(c.batches.length, 0);
  c.tick(1);
  assert.equal(c.batches.length, 1);
  assert.deepEqual(c.batches[0].map(item => item.text), ['第一句', '补充一句']);
});

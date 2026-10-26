import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupWindow } from '../app/src/group-window.js';
import { Waker } from '../app/src/wake.js';
import { handleTurn, loadConfig } from '../app/src/index.js';

function clock() {
  let time = 0, id = 0;
  const timers = new Map(), batches = [];
  const window = new GroupWindow({
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

test('6秒收齐所有群友消息和图片，普通消息不延时，不会因满6条提前发送', () => {
  const c = clock();
  assert.equal(c.window.add(msg('路过'), false), false);
  c.window.add(msg('@bot'), true);
  c.tick(2000);
  const image = { url: 'https://example.com/meme.gif' };
  c.window.add(msg('[图片]', 'group:7', { userId: '22', images: [image] }), false);
  for (let i = 0; i < 8; i++) c.window.add(msg('聊天' + i), false);
  c.tick(3999); assert.equal(c.batches.length, 0);
  c.tick(1);
  assert.equal(c.batches.length, 1);
  assert.equal(c.batches[0].length, 10);
  assert.deepEqual(c.batches[0][1].images, [image]);
  assert.equal(c.window.pending.size, 0);
  assert.equal(c.timers.size, 0);
});

test('每条触发只延1秒，累计最长10秒；普通消息不会开启下一轮', () => {
  const c = clock();
  c.window.add(msg('@bot'), true);
  c.tick(4000);
  c.window.add(msg('@bot 小鲸鱼'), true);
  assert.equal(c.window.pending.get('group:7').deadline, 7000);
  c.tick(2000); assert.equal(c.batches.length, 0);
  for (let i = 0; i < 12; i++) c.window.add(msg('主人发言'), true);
  assert.equal(c.window.pending.get('group:7').deadline, 10000);
  c.tick(3999); assert.equal(c.batches.length, 0);
  c.tick(1); assert.equal(c.batches.length, 1);
  c.window.add(msg('普通消息'), false); assert.equal(c.window.pending.size, 0);
  c.window.add(msg('@bot 第二轮'), true);
  c.tick(6000); assert.equal(c.batches.length, 2);
});

test('不同群独立；到期后新触发独立开窗；事件循环延迟不混入过期窗口', () => {
  const c = clock();
  c.window.add(msg('@bot'), true);
  c.tick(1000); c.window.add(msg('@bot', 'group:8'), true);
  c.tick(5000); assert.equal(c.batches[0][0].key, 'group:7');
  c.tick(1000); assert.equal(c.batches[1][0].key, 'group:8');
  c.window.add(msg('@bot'), true);
  c.jump(7000);
  assert.equal(c.window.add(msg('过期普通消息'), false), false);
  assert.equal(c.batches.length, 3);
  c.window.add(msg('@bot 新一轮'), true);
  c.tick(6000); assert.equal(c.batches.length, 4);
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

test('配置缺省值为6秒、每次1秒、最长10秒', () => {
  const cfg = loadConfig(new URL('../app/config.mock.json', import.meta.url).pathname);
  assert.equal(cfg.wake.groupExtensionMs, 1000);
  assert.equal(cfg.wake.groupMaxWindowMs, 10000);
});

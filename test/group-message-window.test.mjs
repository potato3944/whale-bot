import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GroupMessageWindow } from '../app/src/message-window.js';
import { ConversationState, SerialQueue } from '../app/src/conversation-state.js';
import { Waker } from '../app/src/wake.js';
import { handleTurn } from '../app/src/index.js';

const msg = (userId, text, extra = {}) => ({ key: 'group:7', isGroup: true, userId, name: userId, text, ...extra });

function clock(options = {}) {
  let time = 0, id = 0;
  const timers = new Map(), batches = [];
  const window = new GroupMessageWindow({
    initialMs: 5000, extensionMs: 3000, maxExtensions: 4, capture: options.capture,
    now: () => time,
    schedule: (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id; },
    cancel: timer => timers.delete(timer),
    dispatch: (items, request) => {
      batches.push({ items, request, at: time });
      if (options.dispatch) return options.dispatch(items, request);
      request.onStart?.();
    },
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

test('只有发起人续时，旁观消息保留为背景且不开新请求', () => {
  const c = clock();
  assert.equal(c.window.add(msg('22', '路过'), false), false);
  c.window.add(msg('11', '@机器人'), true);
  c.tick(4000);
  c.window.add(msg('22', '旁观者发言'), false);
  c.tick(1000);
  assert.equal(c.batches.length, 1);
  assert.equal(c.batches[0].at, 5000);
  assert.equal(c.batches[0].request.requesterId, '11');
  assert.deepEqual(c.batches[0].items.map(item => item.triggered), [true, false]);
});

test('同时维护多个窗口；同一人连续 @ 合并，后到窗口已到期则按FIFO直接提交', () => {
  const c = clock();
  c.window.add(msg('11', '@机器人 A'), true);
  c.tick(1000); c.window.add(msg('22', '@机器人 B'), true);
  c.tick(1000); c.window.add(msg('22', '@机器人 B补充'), true);
  assert.equal(c.window.pending.size, 2);
  c.tick(1000); c.window.add(msg('11', 'A继续说'), false);
  c.tick(1000); c.window.add(msg('11', 'A再补充'), false);
  c.tick(5000); // B 在9秒到期，A经两次延长需等到11秒。
  assert.equal(c.batches.length, 0);
  c.tick(2000);
  assert.deepEqual(c.batches.map(batch => batch.request.requesterId), ['11', '22']);
  assert.deepEqual(c.batches.map(batch => batch.at), [11000, 11000]);
  assert.equal(c.batches[0].items.filter(item => item.triggered).length, 1);
  assert.equal(c.batches[1].items.filter(item => item.triggered).length, 2);
  assert.ok(c.batches[1].items.filter(item => item.triggered).every(item => item.userId === '22'));
  assert.equal(c.window.pending.size, 0);
  assert.equal(c.window.queues.size, 0);
  assert.equal(c.timers.size, 0);
});

test('owner每条普通消息都能开窗或续自己的窗口，不延长别人的窗口', () => {
  const c = clock(), waker = new Waker({ ownerIds: ['99'] });
  c.window.add(msg('11', '@机器人'), true);
  c.tick(1000);
  const first = msg('99', 'owner普通消息');
  c.window.add(first, waker.shouldWake(first).wake);
  c.tick(1000);
  const second = msg('99', 'owner继续说');
  c.window.add(second, waker.shouldWake(second).wake);
  c.tick(3000);
  assert.deepEqual(c.batches.map(batch => [batch.request.requesterId, batch.at]), [['11', 5000]]);
  c.tick(4000);
  assert.deepEqual(c.batches.map(batch => [batch.request.requesterId, batch.at]), [['11', 5000], ['99', 9000]]);
  assert.equal(c.batches[1].items.filter(item => item.triggered).length, 2);
});

test('每人最多延长4次，17秒封存；阻塞后新消息不进入过期窗口', () => {
  const c = clock();
  c.window.add(msg('11', '@机器人 A'), true);
  c.tick(1000); c.window.add(msg('22', '@机器人 B'), true);
  for (let i = 0; i < 4; i++) {
    c.tick(500); c.window.add(msg('11', 'A补充' + i), false);
  }
  for (let i = 0; i < 3; i++) {
    c.tick(4000); c.window.add(msg('11', 'A继续' + i), false);
  }
  assert.equal(c.batches.length, 0);
  c.tick(2000);
  assert.deepEqual(c.batches.map(batch => [batch.request.requesterId, batch.at]), [['11', 17000], ['22', 17000]]);
  c.window.add(msg('11', '@机器人 新一轮'), true);
  c.jump(6000);
  assert.equal(c.window.add(msg('11', '过期普通消息'), false), false);
  assert.equal(c.batches.length, 3);
  assert.ok(!c.batches[2].items.some(item => item.text === '过期普通消息'));
});

test('不同群独立计时，不被另一个群较早入队的窗口阻塞', () => {
  const c = clock();
  c.window.add(msg('11', '@机器人 A'), true);
  c.tick(1000); c.window.add(msg('11', '@机器人 B', { key: 'group:8' }), true);
  c.tick(1000); c.window.add(msg('11', 'A继续说'), false);
  c.tick(4000);
  assert.equal(c.batches[0].items[0].key, 'group:8');
  c.tick(2000);
  assert.equal(c.batches[1].items[0].key, 'group:7');
});

test('生成期间排队的到期窗口，前一轮结束后直接执行，不重等5秒', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const queue = new SerialQueue(), tasks = [], started = [];
  const c = clock({ dispatch: (_items, request) => tasks.push(queue.run(async () => {
    request.onStart();
    started.push(request.requesterId);
    if (request.requesterId === '11') await blocked;
  })) });
  c.window.add(msg('11', '@机器人 A'), true);
  c.tick(1000); c.window.add(msg('22', '@机器人 B'), true);
  c.tick(4000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['11']);
  c.tick(1000);
  assert.equal(tasks.length, 2);
  assert.deepEqual(started, ['11']);
  release();
  await Promise.all(tasks);
  assert.deepEqual(started, ['11', '22']);
  assert.equal(c.timers.size, 0);
});

test('群共享已读不跳过其他人的请求；身份、入队时图片均保留，附件去重', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-group-windows-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ConversationState({ dir }), key = 'group:7';
  let id = 0;
  function incoming(userId, text, images = []) {
    const value = msg(userId, text, { images, messageId: String(++id) });
    value.conversationSeq = store.append(value).seq;
    return value;
  }
  const picture = { url: 'https://example.com/b.png' };
  incoming('22', '[图片]', [picture]);
  const c = clock({ capture: value => ({ attachments: store.attachments(key,
    store.snapshot(key, { throughSeq: value.conversationSeq }).messages.map(message => message.seq)) }) });
  c.window.add(incoming('11', '@机器人 A'), true);
  c.tick(1000); c.window.add(incoming('22', '@机器人 看我的图片'), true);
  c.tick(1000); c.window.add(incoming('11', 'A补充'), false);
  c.tick(6000);
  const calls = [];
  const brain = { reply: async input => {
    calls.push(input);
    assert.equal(input.images.length, 1);
    assert.equal(input.images[0].url, picture.url);
    const mark = input.qq.tools.find(tool => tool.name === 'qq_mark_read');
    await mark.execute('ack', { throughSeq: input.snapshot.readThroughSeq });
    return { text: '' };
  } };
  for (const batch of c.batches) {
    await handleTurn({ conversations: store, brain }, batch.items, { engine: 'pi', dryRun: false }, batch.request);
  }
  assert.deepEqual(calls.map(input => input.userId), ['11', '22']);
  assert.ok(calls[1].situation.includes('本轮回应对象：22（QQ 22）'));
  assert.equal(calls[1].snapshot.messages.length, 0, 'shared unread was already acknowledged by A');
});

test('已封存但仍在本群FIFO排队：同一用户后续触发丢弃，封存内容不变', () => {
  const c = clock();
  c.window.add(msg('11', '@机器人 A'), true);
  c.tick(1000); c.window.add(msg('22', '@机器人 B原问题'), true);
  c.tick(1000); c.window.add(msg('11', 'A补充1'), false);
  c.tick(1000); c.window.add(msg('11', 'A补充2'), false);
  c.tick(3000); // B已在6秒封存，A等到11秒。
  assert.equal(c.window.isQueued('group:7', '22'), true);
  c.window.add(msg('22', '@机器人 B重复1'), true);
  c.tick(1000); c.window.add(msg('22', '@机器人 B重复2'), true);
  assert.equal(c.window.pending.has('group:7:22'), false);
  c.tick(4000);
  assert.deepEqual(c.batches.map(batch => batch.request.requesterId), ['11', '22']);
  assert.deepEqual(c.batches[1].items.filter(item => item.triggered).map(item => item.text), ['@机器人 B原问题']);
  assert.equal(c.window.queued.size, 0);
});

test('已提交到全局处理队列但还未开始：重复触发不产生新窗口或模型回合', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const queue = new SerialQueue(), tasks = [], started = [];
  const c = clock({ dispatch: (_items, request) => {
    const task = queue.run(async () => {
      request.onStart();
      started.push(request.requesterId);
      if (request.requesterId === '11') await blocked;
    });
    tasks.push(task); return task;
  } });
  c.window.add(msg('11', '@机器人 A'), true);
  c.tick(1000); c.window.add(msg('22', '@机器人 B'), true);
  c.tick(4000);
  await new Promise(resolve => setImmediate(resolve));
  c.tick(1000);
  assert.equal(c.window.isQueued('group:7', '22'), true);
  assert.equal(c.window.add(msg('22', '@机器人 不要再开一轮'), true), false);
  c.tick(10000);
  assert.equal(tasks.length, 2);
  assert.equal(c.window.pending.size, 0);
  assert.deepEqual(started, ['11']);
  release(); await Promise.all(tasks);
  assert.deepEqual(started, ['11', '22']);
  assert.equal(c.window.queued.size, 0);
});

test('owner排队后普通消息也去重；同一账号在其他群不受影响', () => {
  const c = clock({ dispatch() {} }); // 模拟全局队列暂不执行任何请求。
  const waker = new Waker({ ownerIds: ['99'] });
  const owner = msg('99', 'owner第一次');
  c.window.add(owner, waker.shouldWake(owner).wake);
  c.tick(5000);
  const again = msg('99', 'owner排队时又说话');
  assert.equal(c.window.add(again, waker.shouldWake(again).wake), false);
  const other = msg('99', '其他群独立触发', { key: 'group:8' });
  assert.equal(c.window.add(other, waker.shouldWake(other).wake), true);
  c.tick(5000);
  assert.equal(c.batches.length, 2);
  assert.equal(c.window.isQueued('group:7', '99'), true);
  assert.equal(c.window.isQueued('group:8', '99'), true);
});

test('开始执行后允许新一轮；旧任务完成不能清掉新一轮的排队占位', async () => {
  let releaseOld, releaseNext;
  const old = new Promise(resolve => { releaseOld = resolve; });
  const next = new Promise(resolve => { releaseNext = resolve; });
  const c = clock({ dispatch: (_items, request) => {
    if (c.batches.length === 1) { request.onStart(); return old; }
    return next;
  } });
  c.window.add(msg('11', '@机器人 第一轮'), true);
  c.tick(5000);
  assert.equal(c.window.isQueued('group:7', '11'), false);
  assert.equal(c.window.add(msg('11', '@机器人 已开始处理后新一轮'), true), true);
  c.tick(5000);
  assert.equal(c.window.isQueued('group:7', '11'), true);
  releaseOld(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.window.isQueued('group:7', '11'), true);
  assert.equal(c.window.add(msg('11', '@机器人 第三轮应丢弃'), true), false);
  releaseNext(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.window.isQueued('group:7', '11'), false);
});

test('全局队列拒收时释放去重占位，允许用户后续重新触发', async () => {
  const c = clock({ dispatch: () => Promise.reject(new Error('queue full')) });
  c.window.add(msg('11', '@机器人'), true);
  c.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.window.isQueued('group:7', '11'), false);
  assert.equal(c.window.add(msg('11', '@机器人 重试'), true), true);
});

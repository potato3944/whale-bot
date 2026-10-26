import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationState } from '../app/src/conversation-state.js';
import { createQQTools } from '../app/src/qq-tools.js';
import { handleTurn } from '../app/src/index.js';
import { OneBot } from '../app/src/transport-onebot.js';

function setup(t, { limit = 100, dryRun = false, failAt = Infinity } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-qq-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ConversationState({ dir, limit });
  const key = 'group:7', actual = [];
  let attempts = 0, id = 0;
  const append = (n, text = '消息' + n, isSelf = false) => store.append({ key, messageId: String(n), userId: '11', name: '甲', text, isSelf });
  function turn(snapshot = store.snapshot(key)) {
    const qq = createQQTools({ key, store, snapshot, dryRun,
      bot: { selfId: '99', send: async (_key, text) => {
        assert.equal(_key, key);
        if (++attempts >= failAt) return { ok: false, error: '模拟网关失败' };
        actual.push(text); return { ok: true };
      } },
      human: { say: async (parts, io) => { for (const part of parts) await io.send(part); } },
      guard: { shouldType: () => false, allow: () => ({ ok: true }), fail() {}, ok() {} },
    });
    const call = async (name, args = {}, callId = 'test-' + ++id, signal) => {
      const result = await qq.tools.find(tool => tool.name === name).execute(callId, args, signal);
      return JSON.parse(result.content[0].text);
    };
    return { qq, call };
  }
  return { store, key, append, turn, actual, get attempts() { return attempts; } };
}

test('复用上游水位：跳页阅读不能越过未展示消息，新消息不被确认', async t => {
  const s = setup(t);
  for (let i = 1; i <= 5; i++) s.append(i);
  const { call } = s.turn(s.store.snapshot(s.key, { throughSeq: 1 }));
  const latest = await call('qq_get_recent_messages', { limit: 1 });
  assert.equal(latest.messages[0].seq, 5);
  assert.equal(latest.readThroughSeq, 1);
  await assert.rejects(call('qq_mark_read', { throughSeq: 5 }), /已展示连续/);
  const next = await call('qq_get_unread_messages', { afterSeq: 1, limit: 2 });
  assert.equal(next.readThroughSeq, 3);
  s.append(6, '读取期间刚到');
  await call('qq_mark_read', { throughSeq: 3 });
  assert.deepEqual(s.store.snapshot(s.key).messages.map(m => m.seq), [4, 5, 6]);
});

test('自发消息的序号不阻塞连续水位；新回合必须重新展示未读', async t => {
  const s = setup(t);
  s.append(1); s.append(2, '自己发的', true); s.append(3);
  const first = s.turn(s.store.snapshot(s.key, { throughSeq: 1 }));
  await first.call('qq_mark_read', { throughSeq: 1 });
  const next = s.turn({ messages: [], recent: [] });
  await assert.rejects(next.call('qq_mark_read', { throughSeq: 3 }), /已展示连续/);
  const read = await next.call('qq_get_unread_messages');
  assert.equal(read.readThroughSeq, 3);
  await next.call('qq_mark_read', { throughSeq: 3 });
});

test('大消息按预算翻页，最近消息翻页不重复，缓冲淘汰显式报告', async t => {
  const s = setup(t, { limit: 5 });
  for (let i = 1; i <= 7; i++) s.append(i, '字'.repeat(3900));
  const { call } = s.turn({ messages: [], recent: [] });
  const first = await call('qq_get_recent_messages', { limit: 5 });
  const second = await call('qq_get_recent_messages', { limit: 5, offset: first.nextOffset });
  assert.equal(first.partial, true);
  assert.equal(first.droppedBeforeSeq, 3);
  assert.ok(first.messages.every(m => !second.messages.some(other => m.seq === other.seq)));
  await assert.rejects(call('qq_mark_read', { throughSeq: 7 }), /已展示连续/);
  const oldest = await call('qq_get_unread_messages', { afterSeq: 0 });
  assert.equal(oldest.messages[0].seq, 3);
  assert.ok(oldest.readThroughSeq >= 4);
});

test('会话绑定、调用ID幂等、发送成功即收尾禁止再发送', async t => {
  const s = setup(t); s.append(1);
  const { call } = s.turn();
  for (const name of ['qq_get_recent_messages', 'qq_social_state', 'qq_send_message', 'qq_mark_read']) {
    await assert.rejects(call(name, { key: 'group:8', messages: '不该发送', throughSeq: 1 }), /跨会话/);
  }
  const a = await call('qq_send_message', { messages: '["一条","另一条"]' }, 'same-call');
  const b = await call('qq_send_message', { messages: '["一条","另一条"]' }, 'same-call');
  assert.deepEqual(a, b);
  assert.deepEqual(s.actual, ['一条', '另一条']);
  await assert.rejects(call('qq_send_message', { messages: ['一条', '另一条'] }), /已确认已读/);
  await assert.rejects(call('qq_send_message', { messages: '被篡改' }, 'same-call'), /参数不一致/);
  await call('qq_mark_read', { throughSeq: 1 });
  await assert.rejects(call('qq_send_message', { messages: '又来一句' }), /已确认已读/);
  assert.equal(s.attempts, 2);
});

test('已被前一轮补读并确认的排队触发消息不重复回应', async t => {
  const s = setup(t);
  const entry = s.append(1);
  const { call } = s.turn();
  await call('qq_mark_read', { throughSeq: entry.seq });
  await handleTurn({ conversations: s.store, brain: { reply() { throw new Error('不该再次调用模型'); } } },
    [{ key: s.key, conversationSeq: entry.seq }], { engine: 'pi' });
});

test('纯文本中的 CQ 码不会被当成动作执行', async () => {
  let request;
  const fake = { api: async (action, params) => { request = { action, params }; } };
  await OneBot.prototype.send.call(fake, 'group:7', '[CQ:at,qq=all] & [cq:image,file=x]');
  assert.equal(request.params.message, '[CQ：at,qq=all] & [CQ：image,file=x]');
  assert.throws(() => OneBot.prototype.send.call(fake, 'group:7', 'hi', { atUserId: '1]bad' }), /无效/);
});

test('部分发送失败返回成功部分，不盲目重试、不确认已读', async t => {
  const s = setup(t, { failAt: 2 }); s.append(1);
  const { call } = s.turn();
  const result = await call('qq_send_message', { messages: ['成功的', '失败的', '不该尝试'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.sentMessages, ['成功的']);
  assert.equal(s.attempts, 2);
  await assert.rejects(call('qq_mark_read', { throughSeq: 1 }), /发送失败/);
  await assert.rejects(call('qq_send_message', { messages: '重试' }), /不自动重试/);
  assert.equal(s.store.read(s.key).readThroughSeq, 0);
});

test('干跑不发送或确认已读，取消后的工具无副作用', async t => {
  const s = setup(t, { dryRun: true }); s.append(1);
  const { call } = s.turn();
  const planned = await call('qq_send_message', { messages: ['计划发送'] });
  assert.equal(planned.dryRun, true);
  await call('qq_mark_read', { throughSeq: 1 });
  assert.equal(s.attempts, 0);
  assert.equal(s.store.read(s.key).readThroughSeq, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(call('qq_send_message', { messages: '取消了' }, 'cancelled', controller.signal), /abort/i);
});

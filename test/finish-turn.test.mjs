import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PiConversations } from '../app/src/pi-conversations.js';
import { ConversationState } from '../app/src/conversation-state.js';
import { createQQTools } from '../app/src/qq-tools.js';

const send = ['qq_send_message', { messages: ['在呢', '咋了'] }];
const mark = ['qq_mark_read', { throughSeq: 1 }];
const read = ['qq_get_unread_messages', { afterSeq: 0 }];

test('真实 Pi SDK 的显式收尾策略与持久化', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-finish-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let plan = [], requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const index = requests.length; requests.push(payload);
    const batch = plan[index];
    const delta = batch ? { role: 'assistant', tool_calls: batch.map(([name, args], i) => ({
      index: i, id: `call-${index}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
    })) } : { role: 'assistant', content: '普通内部收尾文字' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'test', choices: [{ index: 0, delta }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: batch ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const options = dir => ({ apiKey: 'test', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock', dir, timeoutMs: 10000 });
  let counter = 0;
  function setup(batches, failSend = false) {
    plan = batches; requests = [];
    const dir = path.join(root, String(++counter));
    const store = new ConversationState({ dir: path.join(dir, 'state') });
    const key = 'private:1'; store.append({ key, messageId: '1', userId: '1', text: '在吗' });
    const sent = [];
    function tools() {
      return createQQTools({ key, store, snapshot: store.snapshot(key),
        bot: { selfId: '99', send: async (_key, text) => {
          if (failSend) return { ok: false, error: '发送失败' };
          sent.push(text); return { ok: true };
        } },
        human: { say: async (parts, io) => { for (const p of parts) await io.send(p); } },
        guard: { shouldType: () => false, allow: () => ({ ok: true }), ok() {}, fail() {} },
      });
    }
    const qq = tools();
    const runner = new PiConversations(options(path.join(dir, 'pi')));
    const input = { key, systemPrompt: '遵守QQ工具协议', prompt: '测试', qq, remember() {} };
    return { runner, input, qq, sent, store, key, dir, tools };
  }

  await t.test('同批发送与确认只用一次请求；结果完整落盘，恢复时回传', async () => {
    const s = setup([[send, mark]]);
    const result = await s.runner.reply(s.input);
    assert.equal(requests.length, 1);
    assert.equal(result.endedByAcknowledgement, true);
    assert.equal(result.text, '');
    assert.deepEqual(s.sent, ['在呢', '咋了']);
    assert.equal(s.store.read(s.key).readThroughSeq, 1);
    const pointer = JSON.parse(fs.readFileSync(path.join(s.dir, 'pi/sessions/private-1/current.json'), 'utf8'));
    const messages = fs.readFileSync(pointer.file, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).filter(entry => entry.type === 'message').map(entry => entry.message);
    assert.equal(messages.at(-1).role, 'toolResult');
    assert.equal(messages.at(-1).toolName, 'qq_mark_read');
    assert.equal(messages.at(-1).details.ok, true);
    assert.ok(messages.some(m => m.toolName === 'qq_send_message' && m.details.ok === true));
    plan = [[mark]]; requests = [];
    const restarted = new PiConversations(options(path.join(s.dir, 'pi')));
    await restarted.reply({ ...s.input, qq: s.tools(), prompt: '下一轮' });
    assert.equal(requests.length, 1);
    const previousResults = requests[0].messages.filter(m => m.role === 'tool');
    assert.equal(previousResults.length, 2);
    assert.ok(previousResults.every(m => JSON.parse(m.content).ok === true));
  });

  await t.test('发送成功即自动确认已读并收尾：一次请求结束', async () => {
    const s = setup([[send]]);
    const result = await s.runner.reply(s.input);
    assert.equal(result.endedByAcknowledgement, true);
    assert.equal(requests.length, 1);
    assert.deepEqual(s.sent, ['在呢', '咋了']);
    assert.equal(s.qq.closed, true);
    assert.equal(s.store.read(s.key).readThroughSeq, 1);
  });

  await t.test('只读不终止：读完后继续发送并自动收尾', async () => {
    const s = setup([[read], [send]]);
    await s.runner.reply(s.input);
    assert.equal(requests.length, 2);
    assert.equal(s.qq.closed, true);
    assert.equal(s.store.read(s.key).readThroughSeq, 1);
  });

  await t.test('选择不发言、只确认已读：一次请求结束', async () => {
    const s = setup([[mark]]);
    assert.equal((await s.runner.reply(s.input)).endedByAcknowledgement, true);
    assert.equal(requests.length, 1);
    assert.deepEqual(s.sent, []);
  });

  await t.test('发送失败反馈给模型，不提前收尾或确认已读', async () => {
    const s = setup([[send, mark]], true);
    assert.equal((await s.runner.reply(s.input)).endedByAcknowledgement, false);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some(m => m.role === 'tool' && m.content.includes('发送失败')));
    assert.equal(s.store.read(s.key).readThroughSeq, 0);
  });

  await t.test('同批已读成功但另一工具报错，仍反馈错误', async () => {
    const s = setup([[mark, send]]);
    assert.equal((await s.runner.reply(s.input)).endedByAcknowledgement, false);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some(m => m.role === 'tool' && m.content.includes('不能再发送')));
    assert.deepEqual(s.sent, []);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Brain } from '../app/src/brain.js';
import { Memory } from '../app/src/memory.js';
import { Role } from '../app/src/role.js';
import { Humanizer } from '../app/src/humanize.js';
import { ConversationState } from '../app/src/conversation-state.js';
import { handleTurn } from '../app/src/index.js';

async function setup(t, { plan, key = 'group:1130256040', failAt = Infinity, dryRun = false, lateMessage = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-completion-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [], sent = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const step = plan[requests.length]; requests.push(JSON.parse(body));
    if (!step) { res.writeHead(500).end('Unexpected model request'); return; }
    if (step.error) { res.writeHead(400).end(JSON.stringify({ error: { message: '模拟模型错误' } })); return; }
    const delta = { role: 'assistant', content: step.text || '' };
    if (step.reasoning) delta.reasoning_content = step.reasoning;
    if (step.calls) delta.tool_calls = step.calls.map(([name, args], index) => ({
      index, id: `call-${requests.length}-${index}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step.finishReason || (step.calls ? 'tool_calls' : 'stop') }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const store = new ConversationState({ dir: path.join(dir, 'state') });
  const incoming = { key, isGroup: key.startsWith('group:'), userId: '11', name: '发起人',
    text: '@机器人 来打个招呼', messageId: '1', triggered: true, images: [] };
  incoming.conversationSeq = store.append(incoming).seq;
  const rolePath = path.join(dir, 'role.md');
  fs.writeFileSync(rolePath, '你是小鲸鱼，按QQ工具协议回复。');
  const brain = new Brain({ apiKey: 'mock', model: 'mock', timeoutMs: 10000,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, role: new Role({ cardPath: rolePath }),
    memory: new Memory({ dir: path.join(dir, 'data') }), pi: { thinkingLevel: 'off' }, web: { enabled: false } });
  let qq, result, attempts = 0, allowed = 0;
  const reply = brain.reply.bind(brain);
  brain.reply = async input => { qq = input.qq; result = await reply(input); return result; };
  const deps = { brain, conversations: store, memory: brain.memory, human: new Humanizer({ enabled: false }),
    bot: { selfId: '99', send: async (target, text) => {
      assert.equal(target, key);
      attempts++;
      if (lateMessage && attempts === 1) store.append({ ...incoming, messageId: '2', text: '生成时新来的消息' });
      if (attempts >= failAt) return { ok: false, error: '模拟发送失败' };
      sent.push(text); return { ok: true };
    } },
    guard: { shouldType: () => false, allow: () => { allowed++; return { ok: true }; }, ok() {}, fail() {} },
    waker: { wake() {} } };
  return { requests, sent, store, key,
    run: () => handleTurn(deps, [incoming], { engine: 'pi', dryRun }, incoming.isGroup ? { requesterId: '11' } : {}),
    entries: () => {
      const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'data/pi/sessions', key.replace(':', '-'), 'current.json'), 'utf8'));
      return fs.readFileSync(pointer.file, 'utf8').trim().split('\n').map(JSON.parse);
    },
    get qq() { return qq; }, get result() { return result; }, get attempts() { return attempts; }, get allowed() { return allowed; },
  };
}

const send = text => ({ calls: [['qq_send_message', { messages: [text] }]] });
const mark = { calls: [['qq_mark_read', { throughSeq: 1 }]] };
const read = { calls: [['qq_get_recent_messages', { limit: 1 }]] };
const reminders = s => s.entries().filter(e => e.type === 'custom_message' && e.customType === 'qq_completion_reminder');

test('新群漏调用工具后只提醒一次：下一次请求带有提醒、最终回复及真实工具记录', async t => {
  const s = await setup(t, { plan: [
    { reasoning: '内部推理不应发送', text: '小鲸鱼在，有啥事说' }, send('真正通过工具发出的回复'),
  ] });
  await s.run();
  assert.equal(s.requests.length, 2);
  assert.deepEqual(s.sent, ['真正通过工具发出的回复']);
  assert.equal(s.qq.closed, true);
  assert.equal(s.store.read(s.key).readThroughSeq, 1);
  assert.equal(s.result.text, s.sent[0]);
  assert.ok(s.requests[1].messages.some(m => m.role === 'assistant' && m.content === '小鲸鱼在，有啥事说'));
  assert.ok(s.requests[1].messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('【程序收尾提醒】')));
  assert.equal(reminders(s).length, 1);
  const entries = s.entries();
  assert.equal(entries.filter(e => e.message?.role === 'assistant').length, 2);
  assert.equal(entries.filter(e => e.message?.toolName === 'qq_send_message' && e.message.details.ok).length, 1);
});

test('正常工具发送一次请求，不转发说明、不插入提醒', async t => {
  const s = await setup(t, { plan: [{ text: '内部发送计划，不应发到QQ', ...send('工具发的回复') }] });
  await s.run();
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.sent, ['工具发的回复']);
  assert.equal(reminders(s).length, 0);
});

test('明确不发言、只确认已读一次请求；提醒后也允许选择不发言', async t => {
  for (const plan of [[mark], [{ text: '不回复了' }, mark]]) {
    const s = await setup(t, { plan });
    await s.run();
    assert.equal(s.requests.length, plan.length);
    assert.equal(s.attempts, 0);
    assert.equal(s.store.read(s.key).readThroughSeq, 1);
    assert.equal(reminders(s).length, plan.length - 1);
  }
});

test('读取工具正常继续；后续仅返回正文时再提醒一次', async t => {
  const s = await setup(t, { plan: [read, { text: '看到了' }, send('在呢')] });
  await s.run();
  assert.equal(s.requests.length, 3);
  assert.deepEqual(s.sent, ['在呢']);
  assert.equal(reminders(s).length, 1);
});

test('提醒后仍只输出正文或仅调用读取工具：停止、报错、保留未读', async t => {
  for (const last of [{ text: '还是普通正文' }, read]) {
    const s = await setup(t, { plan: [{ text: '第一轮正文' }, last] });
    await assert.rejects(s.run(), /QQ 回合未完成.*保留未读/);
    assert.equal(s.requests.length, 2);
    assert.equal(s.attempts, 0);
    assert.equal(s.store.read(s.key).readThroughSeq, 0);
    assert.equal(reminders(s).length, 1);
    // 最后的工具结果也必须保存，不能因强制结束丢失记录。
    if (last === read) assert.equal(s.entries().at(-1).message.toolName, 'qq_get_recent_messages');
  }
});

test('工具部分发送失败后，不追加收尾提醒、不重发或确认已读', async t => {
  const s = await setup(t, { failAt: 2, plan: [{ calls: [
    ['qq_send_message', { messages: ['已发出', '会失败'] }],
  ] }, { text: '不能拿这个正文重试' }] });
  await s.run();
  assert.equal(s.requests.length, 2);
  assert.deepEqual(s.sent, ['已发出']);
  assert.equal(s.attempts, 2);
  assert.equal(s.qq.failed, true);
  assert.equal(s.store.read(s.key).readThroughSeq, 0);
  assert.equal(reminders(s).length, 0);
});

test('提醒后发送失败就结束，连失败解释也不再请求模型', async t => {
  const s = await setup(t, { failAt: 1, plan: [{ text: '第一句' }, send('会发送失败')] });
  await s.run();
  assert.equal(s.requests.length, 2);
  assert.equal(s.attempts, 1);
  assert.equal(s.qq.failed, true);
  assert.equal(s.store.read(s.key).readThroughSeq, 0);
  assert.equal(s.entries().at(-1).message.details.ok, false);
});

test('私聊同样检查收尾；发送期间新到消息继续未读', async t => {
  const s = await setup(t, { key: 'private:11', lateMessage: true, plan: [{ text: '私聊正文' }, send('私聊回复')] });
  await s.run();
  assert.equal(s.requests.length, 2);
  assert.deepEqual(s.sent, ['私聊回复']);
  assert.equal(s.store.read(s.key).readThroughSeq, 1);
  assert.deepEqual(s.store.snapshot(s.key).messages.map(m => m.text), ['生成时新来的消息']);
});

test('干跑提醒后只计划工具消息，不发送或推进已读', async t => {
  const s = await setup(t, { dryRun: true, plan: [{ text: '干跑正文' }, send('干跑回复')] });
  await s.run();
  assert.equal(s.requests.length, 2);
  assert.equal(s.attempts, 0);
  assert.deepEqual(s.qq.plannedMessages, ['干跑回复']);
  assert.equal(s.qq.closed, true);
  assert.equal(s.store.read(s.key).readThroughSeq, 0);
});

test('空正文也只补充一次，不自动制造发送内容', async t => {
  const s = await setup(t, { plan: [{ text: '  \n ' }, { text: '' }] });
  await assert.rejects(s.run(), /QQ 回合未完成/);
  assert.equal(s.requests.length, 2);
  assert.equal(s.attempts, 0);
});

test('模型错误和输出截断不触发收尾提醒；已提醒的模型错误也不再续跑', async t => {
  for (const plan of [[{ error: true }], [{ text: '截断输出', finishReason: 'length' }], [{ text: '正文' }, { error: true }]]) {
    const s = await setup(t, { plan });
    await assert.rejects(s.run());
    assert.equal(s.requests.length, plan.length);
    assert.equal(s.attempts, 0);
    assert.equal(s.store.read(s.key).readThroughSeq, 0);
    assert.equal(reminders(s).length, plan.length - 1);
  }
});

test('失败后恢复同一会话：上一轮提醒已持久化，每个新回合各限一次', async t => {
  const s = await setup(t, { plan: [
    { text: '第一轮正文' }, { text: '仍未收尾' },
    { text: '下一轮正文' }, send('下一轮通过工具发送'),
  ] });
  await assert.rejects(s.run(), /QQ 回合未完成/);
  await s.run();
  assert.equal(s.requests.length, 4);
  assert.equal(reminders(s).length, 2);
  assert.equal(s.requests[2].messages.filter(m => JSON.stringify(m.content).includes('【程序收尾提醒】')).length, 1);
  assert.deepEqual(s.sent, ['下一轮通过工具发送']);
  assert.equal(s.store.read(s.key).readThroughSeq, 1);
});

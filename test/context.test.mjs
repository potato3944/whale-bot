import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConversationState, SerialQueue } from '../app/src/conversation-state.js';
import { Brain } from '../app/src/brain.js';
import { Memory } from '../app/src/memory.js';
import { Role } from '../app/src/role.js';
import { handleTurn } from '../app/src/index.js';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const msg = (id, text, key = 'group:7') => ({ key, messageId: String(id), userId: '11', name: '测试者', text });

test('缓存去重、重启恢复、预算截断与生成期间的新消息水位', t => {
  const dir = temp(t);
  const store = new ConversationState({ dir, limit: 3 });
  store.append(msg(1, '没有叫机器人的话题'));
  assert.equal(store.append(msg(1, '重复事件')), null);
  store.append(msg(2, '@机器人 接着说'));
  const snapshot = store.snapshot('group:7');
  store.append(msg(3, '生成过程中补充'));
  store.markRead('group:7', snapshot.throughSeq);
  const restored = new ConversationState({ dir });
  assert.deepEqual(restored.snapshot('group:7').messages.map(m => m.text), ['生成过程中补充']);
  assert.equal(restored.snapshot('private:11').messages.length, 0);
  const bounded = restored.snapshot('group:7', { maxChars: 1 });
  assert.equal(bounded.partial, true);
  assert.equal(bounded.throughSeq, snapshot.throughSeq);
  assert.throws(() => store.markRead('group:7', 1000));
  assert.throws(() => store.read('../../escape'));
  store.append(msg(4, '第四条'));
  assert.equal(store.read('group:7').messages.length, 3);
});

test('队列限制并发且失败后仍继续', async () => {
  const queue = new SerialQueue(2);
  let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }));
  const second = queue.run(() => { throw new Error('expected'); });
  const rejection = assert.rejects(second, /expected/);
  await assert.rejects(queue.run(() => {}), /队列已满/);
  await new Promise(resolve => setImmediate(resolve));
  release(); await first; await rejection;
  assert.equal(await queue.run(() => 42), 42);
});

test('Pi 真实 SDK：新进程恢复、会话隔离、工具白名单和 remember 绑定', async t => {
  const dir = temp(t);
  const rolePath = path.join(dir, 'role.md');
  fs.writeFileSync(rolePath, '你是小鲸鱼。说话自然，不要生硬。');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); calls.push(payload);
    assert.deepEqual(payload.tools.map(tool => tool.function.name), ['remember']);
    const last = JSON.stringify(payload.messages.at(-1));
    let delta;
    if (last.includes('remember-me')) delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'remember', arguments: '{"fact":"喜欢蓝色"}' } }] };
    else delta = { role: 'assistant', content: '收到' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'test', choices: [{ index: 0, delta }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock', timeoutMs: 10000 };
  const memory = new Memory({ dir: path.join(dir, 'data') });
  const brain = new Brain({ ...config, role: new Role({ cardPath: rolePath }), memory });
  await brain.reply({ key: 'private:11', userId: '11', userName: '甲', text: '独立口令 alpha-912' });
  // 新进程；只给新的问题，不向子进程传旧口令。
  const worker = `import {Brain} from ${JSON.stringify(new URL('../app/src/brain.js', import.meta.url).href)};
    import {Memory} from ${JSON.stringify(new URL('../app/src/memory.js', import.meta.url).href)};
    import {Role} from ${JSON.stringify(new URL('../app/src/role.js', import.meta.url).href)};
    const b=new Brain({...${JSON.stringify(config)},memory:new Memory({dir:${JSON.stringify(memory.dir)}}),role:new Role({cardPath:${JSON.stringify(rolePath)}})});
    await b.reply({key:'private:11',userId:'11',text:'之前的口令是什么'});`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', worker], { timeout: 20000 });
  assert.ok(JSON.stringify(calls[1].messages).includes('alpha-912'));
  assert.ok(calls[1].messages.some(m => m.role === 'assistant' && m.content === '收到'));
  await brain.reply({ key: 'group:7', userId: '11', text: '同一个人换到群聊' });
  assert.ok(!JSON.stringify(calls[2].messages).includes('alpha-912'));
  await brain.reply({ key: 'private:11', userId: '11', text: 'remember-me' });
  assert.ok(memory.person('11').facts.includes('喜欢蓝色'));
  assert.ok(!memory.person('22').facts.includes('喜欢蓝色'));
  assert.equal(calls.at(-1).messages.at(-1).role, 'tool');
  const models = fs.readFileSync(path.join(memory.dir, 'pi/agent/models.json'), 'utf8');
  assert.ok(!models.includes('test-key'));
});

test('发送失败不确认已读；成功仅确认快照水位', async t => {
  const store = new ConversationState({ dir: temp(t) });
  const incoming = msg(1, '之前的普通聊天'); store.append(incoming);
  const trigger = msg(2, '@机器人'); store.append(trigger);
  let ok = false;
  const deps = {
    conversations: store,
    brain: { reply: async ({ snapshot }) => {
      assert.ok(snapshot.messages.some(m => m.text === incoming.text));
      if (!store.read(trigger.key).recentIds.includes('3')) store.append(msg(3, '后到的消息'));
      return { text: '回答' };
    } },
    bot: { selfId: '99', send: async () => ({ ok }) },
    human: { say: async (text, io) => { await io.send(text); return { sent: 1, parts: [text] }; } },
    guard: { shouldType: () => false, allow: () => ({ ok: true }), fail() {}, ok() {} },
    waker: { wake() {} }, memory: { touch() {} },
  };
  await handleTurn(deps, [trigger], {});
  assert.equal(store.read(trigger.key).readThroughSeq, 0);
  ok = true;
  await handleTurn(deps, [trigger], {});
  assert.equal(store.read(trigger.key).readThroughSeq, 3);
});

test('模型超时释放会话和队列，后续请求仍可完成', async t => {
  const dir = temp(t);
  const rolePath = path.join(dir, 'role.md'); fs.writeFileSync(rolePath, '只回答收到');
  let hang = true;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume body */ }
    if (hang) return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: '收到' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const brain = new Brain({ apiKey: 'test', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'mock', timeoutMs: 300, role: new Role({ cardPath: rolePath }), memory: new Memory({ dir: path.join(dir, 'data') }) });
  await assert.rejects(brain.reply({ key: 'private:1', userId: '1', text: '会超时' }), /超时|abort|timed out/i);
  hang = false;
  assert.equal((await brain.reply({ key: 'private:1', userId: '1', text: '继续' })).text, '收到');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConversationState } from '../app/src/conversation-state.js';
import { SocialMemory } from '../app/src/social-memory.js';
import { createQQTools } from '../app/src/qq-tools.js';
import { Humanizer } from '../app/src/humanize.js';
import { Proactive } from '../app/src/proactive.js';
import { Memory } from '../app/src/memory.js';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}

test('网关确认操作成功后才算成功，并忽略自身消息回声', async t => {
  const server = http.createServer((req, res) => {
    const responses = {
      '/bad-json': '<html>gateway error</html>',
      '/failed': JSON.stringify({ retcode: 100, message: '拒绝发送' }),
      '/async': JSON.stringify({ status: 'async', retcode: 1 }),
      '/success': JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }),
    };
    res.writeHead(200).end(responses[req.url]);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    const event = { post_type: 'message', message_type: 'private', self_id: 99,
      message: [{ type: 'text', data: { text: '在吗' } }] };
    ws.send(JSON.stringify({ ...event, user_id: 99, message_id: 1 }));
    ws.send(JSON.stringify({ ...event, user_id: 11, message_id: 2 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); server.close(); });
  const base = `127.0.0.1:${server.address().port}`;
  const source = `import {OneBot} from ${JSON.stringify(new URL('../app/src/transport-onebot.js', import.meta.url).href)};
    const seen=[]; const bot=new OneBot({wsUrl:${JSON.stringify('ws://' + base)}, httpUrl:${JSON.stringify('http://' + base)},onMessage:m=>seen.push(m.userId)});
    const results=[];for(const name of ['bad-json','failed','async','success'])results.push((await bot.api(name)).ok);
    for(let i=0;i<50&&!seen.includes('11');i++)await new Promise(r=>setTimeout(r,5));
    console.log('RESULT:'+JSON.stringify({results,seen}));process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 5000 });
  const data = JSON.parse(stdout.split('RESULT:')[1].trim());
  assert.deepEqual(data.results, [false, false, false, true]);
  assert.deepEqual(data.seen, ['11']);
});

test('读过的历史消息可作为记忆来源，不误当未读，也不允许伪造来源', async t => {
  const dir = temp(t), key = 'private:11';
  const store = new ConversationState({ dir: path.join(dir, 'messages') });
  const socialMemory = new SocialMemory({ dir: path.join(dir, 'memory') });
  store.append({ key, userId: '11', text: '我喜欢蓝色', messageId: '1', replyTo: 'older-id' });
  store.markRead(key, 1);
  store.append({ key, userId: '11', text: '把上次的喜好记下来', messageId: '2' });
  const qq = createQQTools({ key, store, snapshot: store.snapshot(key), socialMemory, actor: { userId: '11', seq: 2 } });
  let id = 0;
  const call = async (name, args) => {
    const r = await qq.tools.find(t => t.name === name).execute(String(++id), args); return r.details;
  };
  await call('qq_get_recent_messages', {});
  const saved = await call('qq_memory_upsert', { category: 'fact', content: '喜欢蓝色', sourceSeq: 1 });
  assert.equal(saved.memory.source.seq, 1);
  assert.equal(store.read(key).readThroughSeq, 1);
  assert.equal(store.read(key).messages[0].replyTo, 'older-id');
  await assert.rejects(call('qq_memory_upsert', { category: 'fact', content: '伪造', sourceSeq: 1000 }), /来源/);
});

test('Humanizer收到发送失败时停止后续消息，不虚报成功', async () => {
  for (const enabled of [true, false]) {
    const attempted = [];
    const human = new Humanizer({ enabled });
    const result = await human.say(['成功', '失败', '不应发送'], { sleep: async () => {}, send: async msg => { attempted.push(msg); return msg !== '失败'; } });
    assert.equal(result.sent, 1);
    assert.deepEqual(attempted, ['成功', '失败']);
  }
});

test('主动消息发送失败不消耗成功次数，也不写入成功记录', async t => {
  const dir = temp(t), memory = new Memory({ dir });
  const proactive = new Proactive({ memory, ownerId: '11', cfg: { enabled: false }, log() {},
    brain: { reply: async () => ({ text: '一条\n第二条' }) },
    human: new Humanizer({ enabled: false }), bot: { send: async () => ({ ok: false, error: '失败' }) },
    guard: { shouldType: () => false, allow: () => ({ ok: true }), fail() {}, ok() {} },
  });
  assert.equal((await proactive.fire()).sent, 0);
  assert.deepEqual(memory.recentTurns(), []);
  assert.equal(fs.existsSync(path.join(dir, 'proactive.json')), false);
});

/**
 * 全链路群聊模拟：真实 bot 子进程 + OneBot WS/HTTP + 真实 Pi SDK + 本地假模型。
 * 使用示例配置中的真实窗口计时，模型固定延迟3秒；不连接真实QQ或模型供应商。
 * node mock/group-chat-simulation.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../app/src/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wake = loadConfig(path.join(repo, 'app/config.example.json')).wake;
const groupMs = wake.groupWindowMs;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-group-simulation-'));
const selfId = '99999', groupId = '700', token = 'local-simulation-only';
const names = { '10001': 'owner', '10002': 'A', '10003': 'B', '10004': 'C' };
const events = [
  [0, '10002', true, '帮我规划杭州一日游'],
  [groupMs * 0.1, '10003', true, '帮我看一下 Go 的 map 并发'],
  [groupMs * 0.3, '10004', false, '我去吃饭了'],
  [groupMs * 0.4, '10002', false, '预算只有300元'],
  [groupMs * 0.5, '10001', false, '解释一下 TCP 的三次握手'],
  [groupMs * 0.7, '10001', false, '用一句话说'],
  [groupMs * 0.8, '10003', false, '主要是并发读写会怎样'],
  [groupMs, '10004', false, '你们继续聊'],
  [groupMs * 1.2, '10002', false, '不要安排爬山'],
  [groupMs * 1.6, '10004', false, '我又回来围观了'],
  [groupMs * 1.8, '10003', true, 'B已封存还在本群排队，这次应丢弃'],
  [groupMs + 2 * wake.windowExtensionMs + 2000, '10003', true, 'B已进入全局队列但未开始，这次也应丢弃'],
];
let origin = performance.now(), botLog = '', socket, child;
const timeline = [], requests = [], sent = [], timers = [];
const elapsed = () => Number(((performance.now() - origin) / 1000).toFixed(3));
function record(kind, data) {
  const entry = { at: elapsed(), kind, ...data };
  timeline.push(entry);
  console.log(JSON.stringify(entry));
  return entry;
}
async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function waitFor(check, timeoutMs) {
  const end = performance.now() + timeoutMs;
  while (!check()) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('bot exited: ' + botLog);
    if (performance.now() > end) throw new Error('simulation timed out: ' + botLog);
    await delay(30);
  }
}
function messageText(message) {
  return typeof message.content === 'string' ? message.content :
    (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}

const api = http.createServer(async (req, res) => {
  const payload = await body(req);
  assert.equal(req.headers.authorization, 'Bearer ' + token);
  if (req.url === '/send_group_msg') {
    const entry = record('reply', { text: payload.message });
    sent.push(entry);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9000 + sent.length } }));
});
const wsHttp = http.createServer((_req, res) => res.writeHead(426).end());
const ws = new WebSocketServer({ server: wsHttp });
ws.on('connection', (connected, req) => {
  assert.equal(req.headers.authorization, 'Bearer ' + token);
  socket = connected;
  connected.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle',
    self_id: Number(selfId), time: Math.floor(Date.now() / 1000) }));
});
const model = http.createServer(async (req, res) => {
  const payload = await body(req);
  const prompt = messageText(payload.messages.findLast(message => message.role === 'user'));
  const actor = /本轮回应对象：(.+?)（QQ (\d+)）/.exec(prompt);
  assert.ok(actor, 'bot must bind each round to the requesting person');
  const trigger = prompt.split('【本次触发消息】')[1] || '';
  const windowMessages = trigger.split('\n').filter(line => /（QQ \d+）/.test(line));
  const ownMessages = windowMessages.filter(line => line.startsWith(`${actor[1]}（QQ ${actor[2]}）`))
    .map(line => line.slice(line.indexOf('：') + 1));
  const snapshotLine = prompt.split('【会话消息快照】')[1].split('\n')[1];
  const snapshot = JSON.parse(snapshotLine);
  const entry = record('model_start', { actor: actor[1], actorId: actor[2], ownMessages, windowMessages,
    unreadCount: snapshot.unreadCount });
  requests.push({ ...entry, payload });
  const callId = 'simulation-' + requests.length;
  const reply = `【模拟回应 ${actor[1]}】已合并：${ownMessages.join('；')}`;
  // 假模型的输出按实际收到的本轮输入生成，用固定延迟模拟推理耗时。
  timers.push(setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant',
      tool_calls: [{ index: 0, id: callId, type: 'function', function: {
        name: 'qq_send_message', arguments: JSON.stringify({ messages: reply }),
      } }] } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  }, 3000));
});

let result;
try {
  const [httpPort, wsPort, modelPort] = await Promise.all([listen(api), listen(wsHttp), listen(model)]);
  const role = path.join(dir, 'role.md');
  fs.writeFileSync(role, '你是小鲸鱼测试机器人。说话简短自然，不编造事实，按当前请求发起人的问题回复。');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ provider: 'custom', apiKey: 'local-test-only',
    baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: 'mock', engine: 'pi',
    roleCard: role, privateRoleCard: role, dataDir: path.join(dir, 'data'),
    ownerIds: ['10001'], ownerNames: { '10001': 'owner' }, names: ['小鲸鱼'], keywords: ['小鲸鱼'],
    wake,
    humanize: { enabled: false }, guard: { typing: { enabled: false } },
    proactive: { enabled: false }, web: { enabled: false }, socialMemory: false, globalRelationships: false,
    pi: { thinkingLevel: 'off' },
    onebot: { httpUrl: `http://127.0.0.1:${httpPort}`, wsUrl: `ws://127.0.0.1:${wsPort}`, accessToken: token },
  }));
  child = spawn(process.execPath, ['app/src/index.js', '--config', config], {
    cwd: repo, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { botLog += chunk; });
  child.stderr.on('data', chunk => { botLog += chunk; });
  await waitFor(() => socket && botLog.includes('[onebot] 已连接'), 10000);
  await delay(100);
  origin = performance.now();
  events.forEach(([at, userId, mention, text], index) => {
    timers.push(setTimeout(() => {
      record('input', { actor: names[userId], mention, text });
      socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal',
        self_id: Number(selfId), group_id: Number(groupId), user_id: Number(userId),
        message_id: 1000 + index, time: Math.floor(Date.now() / 1000),
        sender: { user_id: Number(userId), nickname: names[userId] },
        message: [...(mention ? [{ type: 'at', data: { qq: selfId } }] : []),
          { type: 'text', data: { text } }],
      }));
    }, at));
  });
  await waitFor(() => sent.length === 3 && (botLog.match(/工具实际发出 1 条；已读确认=true/g) || []).length === 3, 45000);
  assert.deepEqual(requests.map(entry => entry.actor), ['A', 'B', 'owner']);
  assert.deepEqual(requests.map(entry => entry.ownMessages.length), [3, 2, 2]);
  const windows = [
    [0, groupMs + 2 * wake.windowExtensionMs],
    [groupMs * 0.1, groupMs * 0.1 + groupMs + wake.windowExtensionMs],
    [groupMs * 0.5, groupMs * 0.5 + groupMs + wake.windowExtensionMs],
  ];
  for (const [index, [start, end]] of windows.entries()) {
    const expected = events.filter(([at]) => at >= start && at < end);
    assert.deepEqual(requests[index].windowMessages.map(line => line.slice(line.indexOf('：') + 1)),
      expected.map(([_at, _userId, mention, text]) => (mention ? '@' + selfId : '') + text),
      'every person\'s window messages must reach the actual model request, in order');
    requests[index].windowMessages.forEach((line, j) => {
      const userId = expected[j][1];
      assert.ok(line.startsWith(`${names[userId]}（QQ ${userId}）`));
    });
  }
  const aDeadline = (groupMs + 2 * wake.windowExtensionMs) / 1000;
  assert.ok(requests[0].at >= aDeadline - 0.2 && requests[0].at < aDeadline + 1.5,
    'C must not extend A beyond the deadline set by A\'s own last message');
  assert.ok(requests[1].at - sent[0].at < 1, 'B starts directly after A, without another debounce');
  assert.ok(requests[2].at - sent[1].at < 1, 'owner starts directly after B');
  assert.equal(requests[1].unreadCount, 0, 'B is not skipped even after shared unread was acknowledged');
  assert.equal(requests[2].unreadCount, 0, 'owner is not skipped after shared unread was acknowledged');
  assert.ok(!requests.some(entry => entry.actor === 'C'));
  assert.equal((botLog.match(/\[忽略·已排队\]/g) || []).length, 2,
    'both same-group FIFO and global-queue duplicates must be discarded');
  result = { pass: true, modelCalls: requests.length, replies: sent.length, checks: [
    'A/B/owner 各一轮，C普通发言不触发', '同一人的补充合并，其他人不续时',
    '窗口内所有人的消息按顺序进入实际模型请求，不只包含发起人',
    '已封存排队时重复触发丢弃，覆盖本群FIFO和全局处理队列',
    '按入队顺序处理，已到期窗口不重新等待', '共享已读不吞掉其他人的请求',
  ] };
  console.log('PASS ' + JSON.stringify(result));
} catch (error) {
  result = { pass: false, error: error.stack };
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const timer of timers) clearTimeout(timer);
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  for (const client of ws.clients) client.terminate();
  ws.close();
  for (const server of [api, model, wsHttp]) { server.closeAllConnections(); server.close(); }
  fs.writeFileSync(path.join(dir, 'bot.log'), botLog);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ result, timeline, requests }, null, 2));
  const rows = timeline.map(entry => `| ${entry.at.toFixed(2)}s | ${entry.kind} | ${entry.actor || ''} | ${entry.text || (entry.windowMessages ? `输入${entry.windowMessages.length}条全员消息；本人内容：${entry.ownMessages.join(' / ')}` : '')} |`);
  fs.writeFileSync(path.join(dir, 'report.md'), [
    '# 群聊全链路模拟', '',
    '真实 bot 子进程、Pi SDK、OneBot WS/HTTP；仅模型服务为本地脚本。未连接真实 QQ 或模型供应商。',
    `群聊初始${groupMs / 1000}秒，每条本人补充加${wake.windowExtensionMs / 1000}秒，最多${wake.windowMaxExtensions}次，假模型固定延迟3秒，关闭拟人发送延迟。`, '',
    `结果：${result?.pass ? 'PASS' : 'FAIL'}；模型请求 ${requests.length} 次，发送回复 ${sent.length} 条。`, '',
    '| 相对时间 | 事件 | 发起人 | 内容 |', '|---|---|---|---|', ...rows, '',
    '## 每轮实际发给模型的窗口消息', '',
    ...requests.flatMap(entry => [`### ${entry.actor}：${entry.windowMessages.length}条`, '',
      '```text', ...entry.windowMessages, '```', '']),
    '回复由脚本根据收到的输入生成，只验证收集、队列、身份和发送链路，不验证模型理解或聊天质量。',
  ].join('\n'));
  console.log('Report: ' + path.join(dir, 'report.md'));
}

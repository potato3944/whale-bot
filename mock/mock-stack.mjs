/**
 * 本地 mock 栈 · 在没有真 QQ、没有 API key 的情况下验证整条链路
 * ─────────────────────────────────────────────────────────────
 * 起三样东西：
 *   ① OneBot v11 WebSocket 服务端（13001）—— 收 bot 的连接，注入消息事件
 *   ② OneBot v11 HTTP 服务端（13000）     —— 接 bot 的 send_private_msg 等动作
 *   ③ OpenAI 兼容的假模型（11435）         —— 接 bot 的 /chat/completions
 *
 * 然后拉起 companion 子进程，跑一遍完整回路：
 *   注入一条私聊消息 → bot 调模型 → bot 分条发送 → mock 收到 → 判定 PASS
 *
 * 用法：node mock/mock-stack.mjs [--no-spawn] [--keep]
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..', 'app');

const PORT_HTTP = 13000;
const PORT_WS = 13001;
const PORT_LLM = 11435;
const TOKEN = 'mock-only-token-not-for-production';
const SELF_ID = 99999;
const OWNER_ID = 10001;

const args = process.argv.slice(2);
const noSpawn = args.includes('--no-spawn');
const keep = args.includes('--keep');

const log = (...a) => console.log('[mock]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 状态 ──────────────────────────────────────────────────────
const state = {
  botConnected: false,
  llmCalls: [],
  sentMessages: [],      // bot 发出来的消息
  typingCalls: 0,
  lifecycleSeen: false,
};

// ── ① OneBot HTTP 服务端 ─────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const action = req.url.replace(/^\//, '');
    const auth = req.headers.authorization;
    if (auth !== 'Bearer ' + TOKEN) {
      log('✗ 鉴权失败：', req.url, 'auth=', auth);
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'failed', message: 'unauthorized' }));
      return;
    }

    let params = {};
    try { params = body ? JSON.parse(body) : {}; } catch { /* 空体 */ }

    log('← HTTP', action, JSON.stringify(params).slice(0, 120));

    if (action === 'send_private_msg' || action === 'send_group_msg') {
      state.sentMessages.push({ action, message: params.message });
      log('  💬 收到回复：' + params.message);
    } else if (action === 'set_input_status') {
      state.typingCalls++;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});

// ── ② OneBot WebSocket 服务端 ────────────────────────────────
// 用 http server 托管，避免 WebSocketServer({port}) 的 listening 事件在监听器挂上之前就触发
const wsHttp = http.createServer((_, res) => res.writeHead(426).end());
const wss = new WebSocketServer({ server: wsHttp });

wss.on('connection', (sock, req) => {
  const auth = req.headers.authorization;
  if (auth !== 'Bearer ' + TOKEN) {
    log('✗ WS 鉴权失败：', auth);
    sock.close();
    return;
  }
  state.botConnected = true;
  log('✓ bot 已连上 WS（鉴权通过）');

  sock.send(JSON.stringify({
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    self_id: SELF_ID,
    time: Math.floor(Date.now() / 1000),
  }));
  state.lifecycleSeen = true;

  // 等 bot 把连接处理好，再注入一条私聊消息
  setTimeout(() => injectPrivateMessage(sock), 800);
});

function injectPrivateMessage(sock) {
  const evt = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: SELF_ID,
    user_id: OWNER_ID,
    message_id: 1001,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: OWNER_ID, nickname: '平安' },
    raw_message: '在吗',
    message: [{ type: 'text', data: { text: '在吗' } }],
  };
  log('→ 注入私聊消息：「在吗」');
  sock.send(JSON.stringify(evt));
}

// ── ③ 假模型（OpenAI 兼容）───────────────────────────────────
const llmServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* ignore */ }
    state.llmCalls.push(payload);

    const sys = payload.messages?.find((m) => m.role === 'system')?.content || '';
    const hasRoleCard = sys.includes('小鲸鱼');
    log('← LLM 调用 #' + state.llmCalls.length,
        'messages=' + (payload.messages?.length || 0),
        '角色卡已注入=' + hasRoleCard);

    // 按提示词内容返回对应风格的假回复
    let content;
    if (/只输出\s*JSON|JSON/.test(sys) && /日记|记录|心情|title/.test(sys)) {
      content = JSON.stringify({
        title: '他突然冒泡',
        mood: '踏实',
        tags: ['日常'],
        text: '今天他突然冒泡，问我还在不在。\n我说在啊。\n其实没什么事，就是想确认一下。',
      });
    } else if (/日记|diary/i.test(sys)) {
      content = '今天他突然冒泡，问我还在不在。\n我说在啊。\n其实没什么事，就是想确认一下。';
    } else if (/记住|记忆/.test(sys) && /工具|tool/i.test(sys)) {
      content = '记住了。';
    } else {
      content = '在呢\n说';
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    }));
  });
});

// ── 启动 ──────────────────────────────────────────────────────
function listen(server, port, name) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { log(name + ' 已监听 127.0.0.1:' + port); resolve(); });
  });
}

let child = null;

function verdict() {
  const checks = [
    ['bot 连上 OneBot WS', state.botConnected],
    ['收到 lifecycle 事件', state.lifecycleSeen],
    ['模型被调用', state.llmCalls.length > 0],
    ['角色卡注入 system prompt', state.llmCalls.some((c) =>
      c.messages?.some((m) => m.role === 'system' && String(m.content).includes('小鱼')))],
    ['bot 发出至少一条消息', state.sentMessages.length > 0],
    ['消息带 Bearer 鉴权通过', state.sentMessages.length > 0],
  ];
  let pass = true;
  console.log('\n════════ 端到端结果 ════════');
  for (const [name, ok] of checks) {
    console.log((ok ? '  ✅ ' : '  ❌ ') + name);
    if (!ok) pass = false;
  }
  console.log('────────────────────────────');
  console.log('  LLM 调用次数: ' + state.llmCalls.length);
  console.log('  发出消息条数: ' + state.sentMessages.length);
  console.log('  消息内容: ' + state.sentMessages.map((m) => JSON.stringify(m.message)).join(' '));
  console.log('  输入态调用: ' + state.typingCalls);
  console.log(pass ? '\n  ✅ PASS — 全链路通了\n' : '\n  ❌ FAIL\n');
  return pass;
}

async function main() {
  await listen(httpServer, PORT_HTTP, 'OneBot HTTP');
  await listen(llmServer, PORT_LLM, '假模型 LLM');
  await listen(wsHttp, PORT_WS, 'OneBot WS');

  if (!noSpawn) {
    log('拉起 companion 子进程…');
    child = spawn(process.execPath, ['src/index.js', '--config', './config.mock.json'], {
      cwd: APP,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env },
    });
    child.on('exit', (code) => log('companion 退出，code=' + code));
  }

  // 等结果：收到第一条后，再等到"安静下来"（连续 4 秒没有新消息）才算一轮结束
  const deadline = Date.now() + 40000;
  let lastSeen = Date.now();
  let seen = 0;
  while (Date.now() < deadline) {
    if (state.sentMessages.length > seen) { seen = state.sentMessages.length; lastSeen = Date.now(); }
    else if (seen > 0 && Date.now() - lastSeen > 4000) break;
    await sleep(200);
  }
  await sleep(500);

  const pass = verdict();

  if (!keep) {
    child?.kill('SIGTERM');
    wss.close();
    httpServer.close();
    llmServer.close();
    process.exit(pass ? 0 : 1);
  }
}

main().catch((e) => { console.error('[mock] 启动失败', e); process.exit(1); });

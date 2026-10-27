import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiConversations } from '../app/src/pi-conversations.js';

test('真实 Pi SDK：恢复旧群聊时提前压缩，私聊保持原策略', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-compaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {
      role: 'assistant', content: 'Recent topic: testing group context. Keep the latest discussion.',
    } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  let counter = 0;
  function setup(key, options = {}) {
    requests = [];
    const dir = path.join(root, String(++counter));
    const sessionDir = path.join(dir, 'sessions', key.replace(':', '-'));
    fs.mkdirSync(sessionDir, { recursive: true });
    const manager = SessionManager.create(root, sessionDir);
    // ~40k tokens of real text, below the original ~123k private threshold.
    for (let i = 0; i < 24; i++) {
      manager.appendMessage({ role: 'user', content: [{ type: 'text',
        text: `old-round-${i}: ` + 'past words '.repeat(600) }], timestamp: Date.now() - 10000 + i * 2 });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Noted.' }],
        api: 'openai-completions', provider: 'whale', model: 'mock', stopReason: 'stop',
        usage: { input: (i + 1) * 1700, output: 5, cacheRead: 0, cacheWrite: 0,
          totalTokens: (i + 1) * 1700 + 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now() - 10000 + i * 2 + 1 });
    }
    const file = manager.getSessionFile();
    fs.writeFileSync(path.join(sessionDir, 'current.json'), JSON.stringify({ file }));
    const runner = new PiConversations({ dir, apiKey: 'test', model: 'mock', timeoutMs: 10000,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      options: { thinkingLevel: 'off', ...options } });
    const input = { key, systemPrompt: 'Chat briefly.', prompt: 'NEW_TRIGGER', remember() {} };
    const entries = () => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { runner, input, entries };
  }

  await t.test('默认群聊：旧历史先摘要，实际聊天请求不再包含全部旧原文', async () => {
    const s = setup('group:1');
    await s.runner.reply(s.input);
    assert.equal(requests.length, 2, 'one summary request plus one chat request');
    const summary = JSON.stringify(requests[0].messages);
    const chat = JSON.stringify(requests[1].messages);
    assert.ok(summary.includes('old-round-0'));
    assert.ok(!chat.includes('old-round-0'));
    assert.ok(chat.includes('old-round-23'));
    assert.ok(chat.includes('NEW_TRIGGER'));
    assert.ok(chat.length < summary.length / 2, 'actual chat context is materially smaller');
    assert.equal(s.entries().filter(e => e.type === 'compaction').length, 1);
    assert.ok(s.entries().some(e => JSON.stringify(e).includes('old-round-0')), 'raw history stays on disk');
    requests = [];
    await s.runner.reply({ ...s.input, prompt: 'SECOND_TRIGGER' });
    assert.equal(requests.length, 1, 'restored compacted context needs no redundant summary');
    assert.ok(!JSON.stringify(requests[0].messages).includes('old-round-0'));
  });

  await t.test('私聊：相同旧历史不触发新的群聊压缩策略', async () => {
    const s = setup('private:1');
    await s.runner.reply(s.input);
    assert.equal(requests.length, 1);
    assert.ok(JSON.stringify(requests[0].messages).includes('old-round-0'));
    assert.equal(s.entries().filter(e => e.type === 'compaction').length, 0);
  });

  await t.test('群聊门槛可通过 pi 配置覆盖', async () => {
    const s = setup('group:2', { groupCompactAtTokens: 65536, groupKeepRecentTokens: 4096 });
    await s.runner.reply(s.input);
    assert.equal(requests.length, 1);
    assert.equal(s.entries().filter(e => e.type === 'compaction').length, 0);
  });
});

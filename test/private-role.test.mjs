import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Brain } from '../app/src/brain.js';
import { Memory } from '../app/src/memory.js';
import { Role, PRIVATE_RULES } from '../app/src/role.js';

test('私聊及主动私聊独立选卡，原群聊卡不会混入', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-private-role-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const groupPath = path.join(dir, 'group.md'); fs.writeFileSync(groupPath, 'GROUP_ONLY_SENTINEL');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收到' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cardPath = new URL('../app/role.private.md', import.meta.url).pathname;
  const privateRole = new Role({ cardPath, baseRules: PRIVATE_RULES });
  assert.equal(privateRole.lint().ok, true);
  const brain = new Brain({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    role: new Role({ cardPath: groupPath }), privateRole, memory: new Memory({ dir: path.join(dir, 'data') }) });
  for (const key of ['private:1', 'group:7', 'proactive:1']) {
    await brain.reply({ key, userId: '1', text: '在吗', record: false });
  }
  const systems = calls.map(call => call.messages[0].content);
  for (const i of [0, 2]) {
    assert.ok(systems[i].includes('【私聊基本规矩】'));
    assert.ok(systems[i].includes(privateRole.read()));
    assert.ok(!systems[i].includes('GROUP_ONLY_SENTINEL'));
  }
  assert.ok(systems[1].includes('GROUP_ONLY_SENTINEL'));
  assert.ok(!systems[1].includes(privateRole.read()));
});

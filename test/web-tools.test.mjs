import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createWebTools, pageText } from '../app/src/web-tools.js';
import { isPrivateIp, validateFetchUrl } from '../app/src/safe-fetch.js';
import { normalizeSearchResults, webSearch, buildSearchRequest, clearSearchCache } from '../app/src/web-search.js';
import { PiConversations } from '../app/src/pi-conversations.js';

const page = { statusCode: 200, url: 'https://example.com/story', body: '<h1>网络词义</h1><script>恶意脚本</script><p>解释 &amp; 用法</p>' };

test('公网读取拒绝本机、内网、伪装IPv6、URL凭据和非HTTP协议', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '198.18.0.1', '::1', '::ffff:127.0.0.1', '64:ff9b::c0a8:101']) {
    assert.equal(isPrivateIp(address), true, address);
  }
  for (const url of ['http://127.1/', 'http://0x7f000001/', 'http://[::ffff:7f00:1]/', 'http://localhost/', 'http://host.local/', 'file:///etc/passwd', 'https://name:secret@example.com/']) {
    await assert.rejects(validateFetchUrl(url), undefined, url);
  }
  assert.equal(isPrivateIp('1.1.1.1'), false);
});

test('没有搜索凭据或配置其他后端时直接失败，不调用备用搜索', async () => {
  await assert.rejects(webSearch('新梗', { config: { apiKeyEnv: 'WHALE_TEST_UNSET_SEARCH_KEY' } }), /没有可用的 Tavily 搜索 API key/);
  await assert.rejects(webSearch('新梗', { config: { provider: 'bing' } }), /仅使用 Tavily/);
});

test('搜索保留来源和时间，去重并过滤无效链接；网页不包含脚本', () => {
  assert.deepEqual(normalizeSearchResults({ results: [
    { title: '解释', url: 'https://example.com/a', published_date: '2026-10-26', content: '解释正文' },
    { title: '重复', url: 'https://example.com/a' }, { url: 'javascript:alert(1)' },
  ] }), [{ title: '解释', url: 'https://example.com/a', snippet: '解释正文', sources: ['tavily'], publishedAt: '2026-10-26' }]);
  assert.equal(pageText(page.body), '网络词义 解释 & 用法');
});

test('联网额度按轮隔离，已读后禁止联网，失败不泄漏密钥', async () => {
  let searches = 0, fetches = 0, closed = false;
  const dependencies = {
    search: async () => { searches++; return { results: [] }; },
    fetchPage: async () => { fetches++; return page; }, isClosed: () => closed,
  };
  const tools = createWebTools({}, dependencies);
  for (let i = 0; i < 3; i++) {
    const result = await tools[0].execute(String(i), { query: '显眼包 是什么意思' });
    assert.equal(result.details.ok, i < 2);
  }
  assert.equal(searches, 2);
  assert.equal((await tools[1].execute('p1', { url: page.url })).details.text, '网络词义 解释 & 用法');
  await tools[1].execute('p2', { url: page.url });
  assert.equal((await tools[1].execute('p3', { url: page.url })).isError, true);
  assert.equal(fetches, 2);
  const fresh = createWebTools({}, dependencies);
  assert.equal((await fresh[0].execute('fresh', { query: '新梗' })).details.ok, true);
  closed = true;
  assert.equal((await fresh[1].execute('closed', { url: page.url })).isError, true);
  assert.equal(fetches, 2);
  const secret = 'test-secret-never-return';
  const failing = createWebTools({ apiKey: secret }, { search: async () => { throw new Error(secret); } });
  assert.ok(!JSON.stringify(await failing[0].execute('bad', { query: '梗' })).includes(secret));
  assert.deepEqual(createWebTools({ enabled: false }), []);
  const binary = createWebTools({}, { fetchPage: async () => ({ ...page, contentType: 'application/pdf' }) });
  assert.equal((await binary[1].execute('pdf', { url: page.url })).isError, true);
});

test('累计联网预算用完后不再发请求；取消传递给网络请求', async () => {
  let clock = 0, searches = 0;
  const tools = createWebTools({}, { now: () => clock, search: async () => { searches++; clock += 26000; return { results: [] }; } });
  await tools[0].execute('one', { query: '新闻' });
  assert.equal((await tools[0].execute('two', { query: '新闻' })).isError, true);
  assert.equal(searches, 1);
  const controller = new AbortController();
  const cancelled = createWebTools({}, { search: async (_query, { config }) => new Promise((_, reject) => {
    config.signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
    controller.abort();
  }) });
  assert.equal((await cancelled[0].execute('cancel', { query: '新闻' }, controller.signal)).isError, true);
});

test('真实Pi SDK完成搜索、阅读、回答的多轮工具调用', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-web-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); const index = requests.length; requests.push(payload);
    const call = index === 0 ? ['web_search', { query: '显眼包 意思' }] : index === 1 ? ['web_fetch', { url: page.url }] : null;
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: 'assistant', content: '查到这个词的含义了' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const runner = new PiConversations({ dir, apiKey: 'mock', model: 'mock', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 10000 });
  const webTools = createWebTools({}, { search: async () => ({ results: [{ title: '词义', url: page.url }] }), fetchPage: async () => page });
  const result = await runner.reply({ key: 'group:7', systemPrompt: '可以搜索查梗', prompt: '显眼包什么意思', remember() {}, webTools });
  assert.equal(result.text, '查到这个词的含义了');
  assert.equal(requests.length, 3);
  assert.ok(requests[2].messages.some(m => m.role === 'tool' && m.content.includes('网络词义')));
});

test('Tavily固定basic且不自动升级；中文查询优先中文和中国地区', () => {
  const tv = buildSearchRequest('显眼包是什么梗', { apiKey: 'tvly-test' });
  assert.equal(tv.headers.authorization, 'Bearer tvly-test');
  assert.equal(tv.endpoint, 'https://api.tavily.com/search');
  assert.equal(JSON.parse(tv.body).search_depth, 'basic');
  assert.equal(JSON.parse(tv.body).auto_parameters, false);
  assert.equal(JSON.parse(tv.body).language, 'zh-cn');
  assert.equal(JSON.parse(tv.body).country, 'china');
});

test('成功结果短期缓存；失败不缓存且不泄漏Key', async () => {
  clearSearchCache();
  const config = { apiKey: 'tvly-test' };
  let calls = 0, fail = false;
  const requestJSON = async () => {
    calls++;
    if (fail) throw new Error('unavailable tvly-test');
    return { results: [{ title: '来源', url: 'https://example.com/common', content: '词义' }], usage: { credits: 1 } };
  };
  const first = await webSearch('合并来源', { config, requestJSON });
  assert.equal(first.provider, 'tavily');
  assert.equal((await webSearch('合并来源', { config, requestJSON })).cached, true);
  assert.equal(calls, 1);
  fail = true;
  await assert.rejects(webSearch('失败重试', { config, requestJSON }), error => !error.message.includes('tvly-test'));
  fail = false;
  assert.equal((await webSearch('失败重试', { config, requestJSON })).results.length, 1);
  assert.equal(calls, 3);
});

test('不接受其他搜索服务；错配查询响应被拒绝', async () => {
  let requests = 0;
  await assert.rejects(webSearch('隔离凭据测试', { provider: 'deepseek', cache: false,
    config: { apiKey: 'tavily-only' }, requestJSON: async () => { requests++; return { results: [] }; } }), /仅使用 Tavily/);
  assert.equal(requests, 0);
  await assert.rejects(webSearch('正确查询', { cache: false, config: { apiKey: 'mock' },
    requestJSON: async () => ({ query: '错误查询', results: [] }) }), /查询词与请求不一致/);
});

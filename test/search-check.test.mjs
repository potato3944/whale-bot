import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSearch, comparisonMarkdown } from '../scripts/check-search.mjs';

test('对比脚本跳过缺凭据的服务，不发送真实请求；同题同参数且不命中缓存', async () => {
  const calls = [];
  const report = await compareSearch({
    config: { provider: 'tavily', apiKey: 'mock' },
    cases: [{ id: 'one', query: '显眼包', category: '梗' }],
    search: async (query, options) => {
      calls.push({ query, options });
      return { results: [{ title: '显眼包的解释', url: 'https://example.com/', snippet: '词义' }], runs: [{ usage: { credits: 1 } }] };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cache, false);
  assert.equal(calls[0].options.config.maxResults, 5);
  assert.equal(report.records[0].status, 'results');
  assert.ok(!JSON.stringify(report).includes('mock'));
  assert.ok(comparisonMarkdown(report).includes('Tavily搜索检查'));
  const skipped = await compareSearch({ config: { apiKeyEnv: 'WHALE_COMPARE_UNSET_TAVILY' }, cases: [{ id: 'one', query: '显眼包' }], search: async () => { throw new Error('must not call'); } });
  assert.equal(skipped.records[0].status, 'not_configured');
});

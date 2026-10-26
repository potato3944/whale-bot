import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webSearch, providerConfig, resolveSearchApiKey, redactSearchError } from '../app/src/web-search.js';

export const SEARCH_CASES = [
  { id: 'meme-xianyanbao', category: '常见中文梗', query: '显眼包 是什么梗 意思 来源' },
  { id: 'meme-banwei', category: '中文语境', query: '班味 是什么意思 网络用语' },
  { id: 'meme-dianzizhacai', category: '词语歧义', query: '电子榨菜 是什么梗 意思' },
  { id: 'meme-city', category: '中英混合梗', query: 'city不city 什么意思 来源' },
  { id: 'recent-memes', category: '时效性', query: '2026年10月 网络热梗 最近流行 来源' },
  { id: 'source-check', category: '事实与原始来源', query: 'DeepSeek V4.1 Flash 发布 日期 官方' },
];

const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

export async function compareSearch({ config, providers = ['tavily'], search = webSearch, cases = SEARCH_CASES, onResult = () => {} }) {
  if (providers.some(provider => provider !== 'tavily')) throw new Error('搜索仅使用 Tavily');
  const records = [];
  for (const item of cases) {
    // Matched questions run together; cases run sequentially to limit burst and cost.
    const batch = await Promise.all(providers.map(async provider => {
      const scoped = providerConfig(config);
      if (!resolveSearchApiKey(scoped).key) return { caseId: item.id, query: item.query, provider, status: 'not_configured' };
      const started = Date.now();
      try {
        const result = await search(item.query, { provider, cache: false,
          config: { ...config, maxResults: 5, timeoutMs: 15000, signal: AbortSignal.timeout(25000) } });
        return { caseId: item.id, query: item.query, provider, status: result.results.length ? 'results' : 'empty',
          elapsedMs: Date.now() - started, results: result.results, usage: result.runs?.[0]?.usage };
      } catch (error) {
        return { caseId: item.id, query: item.query, provider, status: 'error', elapsedMs: Date.now() - started,
          error: redactSearchError(error, config) };
      }
    }));
    records.push(...batch);
    for (const record of batch) onResult(record);
  }
  return { generatedAt: new Date().toISOString(), cases, providers, records,
    note: 'Tavily搜索检查，不调用聊天模型，不发送QQ消息，不自动判定答案正确。not_configured不计为服务失败。' };
}

export function comparisonMarkdown(report) {
  const lines = ['# Tavily搜索检查', '', report.note, '', `生成时间：${report.generatedAt}`, '',
    '| 问题 | 服务 | 状态 | 耗时 | 结果数 | API credits |', '|---|---|---|---:|---:|---:|'];
  for (const r of report.records) lines.push(`| ${cell(r.query)} | ${r.provider} | ${r.status} | ${r.elapsedMs ?? '—'} | ${r.results?.length ?? '—'} | ${r.usage?.credits ?? '—'} |`);
  lines.push('', '## 人工核验标准', '',
    '逐题检查前3条结果是否相关、是否真的解释了词义/来源、时间是否符合问题、有没有可打开的依据。不要将返回非空等同于正确。', '');
  for (const r of report.records) {
    lines.push(`## ${r.caseId} / ${r.provider}`, '', `查询：${r.query}`, '', `状态：${r.status}`, '');
    if (r.error) lines.push(`错误：${r.error}`, '');
    for (const result of r.results || []) lines.push(`- [${cell(result.title)}](<${result.url}>)${result.publishedAt ? `（${cell(result.publishedAt)}）` : ''}\n  ${cell(result.snippet)}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const configPath = path.resolve(flag('--config', 'app/config.json'));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')).web || {};
  const providers = flag('--providers', 'tavily').split(',');
  const report = await compareSearch({ config, providers, onResult: r => console.log(`${r.caseId} / ${r.provider}: ${r.status}, ${r.elapsedMs ?? '—'}ms, ${r.results?.length ?? 0} results`) });
  const output = path.resolve(flag('--out', `logs/search-check-${Date.now()}`));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(output + '.md', comparisonMarkdown(report), { mode: 0o600 });
  console.log(`Report: ${output}.md`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

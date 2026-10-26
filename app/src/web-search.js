// Adapted from qq-bridge (MIT); see THIRD_PARTY_NOTICES.md.
import https from 'node:https';
import { URL } from 'node:url';
import { resolveSafeAddresses } from './safe-fetch.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
/** Tavily is the sole search provider; read legacy nested Tavily settings too. */
export function providerConfig(config = {}) {
  if (config.provider && config.provider !== 'tavily') throw new Error('搜索仅使用 Tavily');
  return { endpoint: 'https://api.tavily.com/search', apiKeyEnv: 'TAVILY_API_KEY',
    ...config, ...(config.providers?.tavily || {}), provider: 'tavily' };
}

export function resolveSearchApiKey(config = {}) {
  const c = providerConfig(config);
  const key = String(c.apiKey || process.env[c.apiKeyEnv] || '').trim();
  return { key, source: key ? 'configured' : 'none' };
}

export function redactSearchError(error, config = {}) {
  let message = String(error?.message || '联网搜索失败');
  const c = { ...config, ...(config.providers?.tavily || {}) };
  for (const secret of [config.apiKey, c.apiKey, process.env[c.apiKeyEnv || 'TAVILY_API_KEY']]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.slice(0, 300);
}

function normalizeSearchUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  const cleaned = s;
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** Normalize only documented structured result fields, preserving source attribution. */
export function normalizeSearchResults(response, maxResults = 5) {
  if (!Array.isArray(response?.results)) throw new Error('Tavily 搜索响应缺少 results 数组');
  const results = [], seen = new Set();
  for (const item of response.results) {
    if (!item || typeof item !== 'object') continue;
    const url = normalizeSearchUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = item.content;
    const publishedAt = item.published_date;
    results.push({ title: String(item.title || url).slice(0, 200), url,
      snippet: String(snippet || '').slice(0, 1500), sources: ['tavily'],
      ...(publishedAt ? { publishedAt: String(publishedAt).slice(0, 80) } : {}),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** 校验搜索端点：https + 公网地址。返回 { url, addresses }。 */
async function validateSearchEndpoint(baseURL) {
  let url;
  try {
    url = new URL(String(baseURL ?? '').trim());
  } catch {
    throw new Error('搜索 endpoint 无效');
  }
  if (url.protocol !== 'https:') throw new Error('搜索 endpoint 必须是 https（API key 只能发给加密端点）');
  if (url.username || url.password) throw new Error('搜索 endpoint 不能包含凭据');
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, addresses };
}

/**
 * 向搜索端点 POST JSON（单个已校验地址）。
 * 不复用 safeFetch（它只做 GET）：这里需要 POST、禁止重定向，并把 key 只交给校验过的地址。
 * 网络层失败（连接/超时/中断）由 postJson() 换地址重试；HTTP 状态是结果，不在这里重试。
 */
function postJsonOnce(url, address, { headers, body, timeoutMs, signal, maxBytes = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, timeoutMs);
    try {
      req = https.request({
        hostname: address,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        signal,
        headers: {
          ...headers,
          host: url.host,
          'content-length': Buffer.byteLength(body)
        },
        // 证书校验用真实域名（SNI/Host 与站点一致），连接目标才是固定 IP。
        servername: url.hostname,
        rejectUnauthorized: true,
        timeout: timeoutMs
      }, (res) => {
        response = res;
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          finish(new Error(`联网搜索端点返回重定向（HTTP ${status}），已拒绝跟随`));
          res.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error('联网搜索响应体过大，已中止'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('联网搜索响应中断')));
        res.on('close', () => { if (!res.complete) finish(new Error('联网搜索响应中断')); });
        res.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          finish(null, { status, text });
        });
      });
      req.on('timeout', () => {
        const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

/** 依次尝试前两个已校验地址（同一失败形态：DNS 先给 IPv6、本机没有 IPv6 出口）。 */
async function postJson(url, addresses, options) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error('没有任何可用地址');
  const deadline = Date.now() + options.timeoutMs;
  const attempts = Math.min(list.length, 2);
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    const budget = attempts === 1 ? options.timeoutMs : Math.min(remaining, Math.ceil(options.timeoutMs / 2));
    try {
      return await postJsonOnce(url, list[i], { ...options, timeoutMs: budget });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('联网搜索请求失败');
}

/** These are raw Search APIs: no auxiliary model turn and no silent fallback. */
export function buildSearchRequest(query, config = {}) {
  const c = providerConfig(config);
  const { key } = resolveSearchApiKey(c);
  if (!key) throw Object.assign(new Error('没有可用的 Tavily 搜索 API key'), { code: 'NO_KEY' });
  const count = Math.min(10, Math.max(1, Math.floor(Number(config.maxResults) || 5)));
  const payload = {
    query, search_depth: 'basic', max_results: count, topic: 'general',
    include_answer: false, include_raw_content: false, auto_parameters: false, include_usage: true,
    include_published_date: true,
    ...(/[\p{Script=Han}]/u.test(query) ? { language: c.language || 'zh-cn', country: c.country || 'china' } : {}),
  };
  return { endpoint: c.endpoint, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload), timeoutMs: config.timeoutMs || 15000, signal: config.signal };
}

async function requestSearchJSON(request) {
  const { url, addresses } = await validateSearchEndpoint(request.endpoint);
  const response = await postJson(url, addresses, request);
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(new Error(`搜索接口 HTTP ${response.status}`), { code: 'HTTP_ERROR', status: response.status });
  }
  try { return JSON.parse(response.text); }
  catch { throw new Error('搜索接口返回了无法解析的响应'); }
}

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const cache = new Map(); // `${provider}|${query}` -> { at, value }

export function clearSearchCache() {
  cache.clear();
}

/** Tavily only; successful public results are cached in memory for five minutes. */
export async function webSearch(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q || [...q].length > 128) throw new Error('查询词必须为1～128字符');
  const config = options.config || {};
  const c = providerConfig(config);
  if (options.provider && options.provider !== 'tavily') throw new Error('搜索仅使用 Tavily');
  const cacheKey = JSON.stringify([c.endpoint, c.language, c.country, q, config.maxResults || 5]);
  const cached = options.cache !== false && cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.value, cached: true };
  const started = Date.now();
  let response;
  try {
    response = await (options.requestJSON || requestSearchJSON)(buildSearchRequest(q, config));
    if (response.query !== undefined && String(response.query).trim() !== q) throw new Error('Tavily 返回的查询词与请求不一致');
  } catch (error) { throw new Error(redactSearchError(error, config)); }
  const results = normalizeSearchResults(response, config.maxResults || 5);
  const value = { query: q, provider: 'tavily', results,
    runs: [{ ok: true, provider: 'tavily', elapsedMs: Date.now() - started, resultCount: results.length,
      ...(response.usage ? { usage: { credits: response.usage.credits } } : {}) }],
    ...(results.length ? {} : { note: '没有搜到结果，可换关键词；仍为空就不要重复搜索。' }),
  };
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}

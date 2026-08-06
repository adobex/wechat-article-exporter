import { setTimeout as sleep } from 'node:timers/promises';
import { load } from 'cheerio';
import {
  extractWechatAssignedString,
  getPublicArticleDiscoveryProfile,
  PUBLIC_ARTICLE_CANDIDATE_LIMIT,
  PUBLIC_ARTICLE_LIST_SOURCE,
  type PublicArticleDiscoveryArticle,
  type PublicArticleDiscoveryResponse,
} from '#shared/utils/public-article-discovery';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const SOGOU_ORIGIN = 'https://wx.sogou.com';
const SOGOU_ALLOWED_HOSTS = new Set(['wx.sogou.com', 'weixin.sogou.com']);
const SEARCH_INTERVAL_MS = 3_500;
const WECHAT_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface SearchCandidate {
  accountName: string;
  cookie: string;
  documentId: string;
  epoch: number;
  evidenceUrl: string;
  guardOffset: number;
  redirectUrl: string;
  title: string;
}

export interface PublicDiscoveryRuntime {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  searchIntervalMs?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  wechatIntervalMs?: number;
}

export interface PublicDiscoveryInput {
  accountName: string;
  expectedBiz: string;
  notBefore: number;
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEpoch(script: string): number {
  return Number(script.match(/timeConvert\(['"](\d{10})['"]\)/)?.[1] || 0);
}

function getResponseCookies(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.() || [];
  return cookies
    .map(cookie => cookie.split(';', 1)[0])
    .filter(Boolean)
    .join('; ');
}

function assertSogouRedirectUrl(rawUrl: string): URL {
  const url = new URL(rawUrl, SOGOU_ORIGIN);
  if (url.protocol !== 'https:' || !SOGOU_ALLOWED_HOSTS.has(url.hostname) || url.pathname !== '/link') {
    throw new Error('Sogou result did not provide an allowed redirect URL');
  }
  return url;
}

function assertWechatArticleUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.pathname !== '/s') {
    throw new Error('Sogou redirect did not resolve to an allowed WeChat article URL');
  }
  return url;
}

export function parseSogouSearchPage(html: string, evidenceUrl: string, cookie = ''): SearchCandidate[] {
  const $ = load(html);
  const guardOffset = Number(html.match(/a\+4\+parseInt\(["'](\d+)["']\)\+b/)?.[1] || 0);
  if (!guardOffset) return [];

  const results: SearchCandidate[] = [];
  $('ul.news-list > li').each((_, element) => {
    const item = $(element);
    const anchor = item.find('h3 a').first();
    const href = anchor.attr('href') || '';
    if (!href) return;
    try {
      results.push({
        accountName: cleanText(item.find('.s-p .all-time-y2').first().text()),
        cookie,
        documentId: cleanText(item.attr('d')),
        epoch: parseEpoch(item.find('.s2 script').first().text()),
        evidenceUrl,
        guardOffset,
        redirectUrl: assertSogouRedirectUrl(href).toString(),
        title: cleanText(anchor.text()),
      });
    } catch {
      // Ignore malformed or off-origin links from an untrusted search page.
    }
  });
  return results;
}

export function isSogouSearchResultPage(html: string): boolean {
  return /var\s+toolParas\s*=\s*\{/.test(html) && !html.includes('/antispider/');
}

export function hasNextSogouSearchPage(html: string): boolean {
  return load(html)('#sogou_next').length > 0;
}

function getCandidateIdentity(candidate: SearchCandidate): string {
  return candidate.documentId || `${candidate.accountName}\n${candidate.epoch}\n${candidate.title}`;
}

function getShanghaiYear(epochSeconds: number): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(
      new Date(epochSeconds * 1000)
    )
  );
}

export function buildSogouClickUrl(rawUrl: string, guardOffset: number): string {
  const url = assertSogouRedirectUrl(rawUrl);
  const original = url.toString();
  const marker = original.indexOf('url=');
  if (marker < 0 || !Number.isSafeInteger(guardOffset) || guardOffset <= 0 || guardOffset > 100) {
    throw new Error('Sogou redirect guard is invalid');
  }

  let key = 37;
  let hash = original.charAt(marker + 4 + guardOffset + key);
  if (!hash) {
    key = 1;
    hash = original.charAt(marker + 4 + guardOffset + key);
  }
  if (!hash) throw new Error('Sogou redirect guard could not be satisfied');
  url.searchParams.set('k', String(key));
  url.searchParams.set('h', hash);
  return url.toString();
}

function decodeScriptFragment(value: string): string {
  return value
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([\\'"/bfnrt])/g, (_, escaped: string) => {
      const controls: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      return controls[escaped] ?? escaped;
    });
}

export function parseSogouRedirectTarget(html: string): string {
  const fragments = Array.from(html.matchAll(/\burl\s*\+=\s*'((?:\\.|[^'])*)'/g), match =>
    decodeScriptFragment(match[1])
  );
  if (fragments.length === 0) throw new Error('Sogou redirect page did not contain a target URL');
  return assertWechatArticleUrl(fragments.join('')).toString();
}

function scriptValue(html: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

export function parseVerifiedWechatArticle(
  html: string,
  expectedBiz: string,
  evidenceUrl: string,
  acquisitionUrl = evidenceUrl
): PublicArticleDiscoveryArticle {
  if (html.includes('环境异常') || html.includes('访问过于频繁')) {
    throw new Error('WeChat article verification was frequency controlled');
  }

  const $ = load(html);
  const biz = extractWechatAssignedString(html, 'biz');
  if (!biz || biz !== expectedBiz) throw new Error('WeChat article account identity did not match');

  const mid = Number(extractWechatAssignedString(html, 'mid'));
  const idx = Number(extractWechatAssignedString(html, 'idx'));
  const sn = extractWechatAssignedString(html, 'sn');
  const publishTime = Number(
    scriptValue(html, [/var\s+oriCreateTime\s*=\s*["'](\d{10})["']/, /\bori_create_time:\s*["'](\d{10})["']/])
  );
  const content = $('#js_content').first();
  const hasContent = content.length > 0 && (cleanText(content.text()).length > 0 || content.find('img').length > 0);
  if (!mid || !idx || !publishTime || !hasContent) {
    throw new Error('WeChat article page was incomplete');
  }

  const title = cleanText($('meta[property="og:title"]').attr('content') || $('.rich_media_title').first().text());
  const accountName = cleanText($('#js_name').first().text() || $('.profile_nickname').first().text());
  if (!title || !accountName) throw new Error('WeChat article metadata was incomplete');

  const canonical = new URL('https://mp.weixin.qq.com/s');
  canonical.searchParams.set('__biz', biz);
  canonical.searchParams.set('mid', String(mid));
  canonical.searchParams.set('idx', String(idx));
  if (sn) canonical.searchParams.set('sn', sn);
  const canonicalLink = canonical.toString();
  const link = assertWechatArticleUrl(acquisitionUrl).toString();

  return {
    accountName,
    aid: `${mid}_${idx}`,
    author: cleanText($('meta[name="author"]').attr('content')),
    biz,
    canonicalLink,
    cover: cleanText($('meta[property="og:image"]').attr('content')),
    digest: cleanText($('meta[name="description"]').attr('content')).slice(0, 240),
    evidenceUrl,
    idx,
    link,
    mid,
    publishTime,
    source: PUBLIC_ARTICLE_LIST_SOURCE,
    title,
  };
}

function makeGate(intervalMs: number, sleepImpl: (milliseconds: number) => Promise<void>) {
  let lastRequestAt = 0;
  return async () => {
    const remaining = intervalMs - (Date.now() - lastRequestAt);
    if (lastRequestAt && remaining > 0) await sleepImpl(remaining);
    lastRequestAt = Date.now();
  };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverPublicWechatArticles(
  input: PublicDiscoveryInput,
  runtime: PublicDiscoveryRuntime = {}
): Promise<PublicArticleDiscoveryResponse> {
  const fetchImpl = runtime.fetchImpl || fetch;
  const sleepImpl = runtime.sleepImpl || (milliseconds => sleep(milliseconds));
  const requestTimeoutMs = runtime.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const gateSogou = makeGate(runtime.searchIntervalMs ?? SEARCH_INTERVAL_MS, sleepImpl);
  const gateWechat = makeGate(runtime.wechatIntervalMs ?? WECHAT_INTERVAL_MS, sleepImpl);
  const profile = getPublicArticleDiscoveryProfile(
    input.accountName,
    input.expectedBiz,
    getShanghaiYear(Math.floor(Date.now() / 1000)),
    getShanghaiYear(input.notBefore)
  );
  const warnings = ['公开索引仅用于发现可检索文章，覆盖范围不完整，不能据此判定公众号历史已同步完成。'];
  const allCandidates: SearchCandidate[] = [];
  let searchPageRequests = 0;
  let successfulSearchPages = 0;

  for (const query of profile.queries) {
    for (let page = 1; page <= profile.searchPages; page++) {
      const searchUrl = new URL('/weixin', SOGOU_ORIGIN);
      searchUrl.search = new URLSearchParams({ type: '2', query, page: String(page), ie: 'utf8' }).toString();
      try {
        searchPageRequests++;
        await gateSogou();
        const response = await fetchWithTimeout(
          fetchImpl,
          searchUrl,
          {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              Referer: `${SOGOU_ORIGIN}/`,
            },
            redirect: 'manual',
          },
          requestTimeoutMs
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        if (!isSogouSearchResultPage(html)) throw new Error('unexpected or rate-limited result page');
        successfulSearchPages++;
        allCandidates.push(...parseSogouSearchPage(html, searchUrl.toString(), getResponseCookies(response)));
        if (!hasNextSogouSearchPage(html)) break;
      } catch (error) {
        warnings.push(`搜狗查询失败: ${query} 第 ${page} 页 (${(error as Error).message})`);
        break;
      }
    }
  }

  let emptyResultRetries = 0;
  const hasExactInRangeCandidate = allCandidates.some(
    candidate =>
      candidate.accountName === input.accountName && (candidate.epoch === 0 || candidate.epoch >= input.notBefore)
  );
  if (!hasExactInRangeCandidate && successfulSearchPages > 0 && profile.queries.length > 0) {
    const query = profile.queries[0];
    const searchUrl = new URL('/weixin', SOGOU_ORIGIN);
    searchUrl.search = new URLSearchParams({ type: '2', query, page: '1', ie: 'utf8' }).toString();
    emptyResultRetries++;
    searchPageRequests++;
    try {
      await gateSogou();
      const response = await fetchWithTimeout(
        fetchImpl,
        searchUrl,
        {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Referer: `${SOGOU_ORIGIN}/`,
          },
          redirect: 'manual',
        },
        requestTimeoutMs
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (!isSogouSearchResultPage(html)) throw new Error('unexpected or rate-limited result page');
      successfulSearchPages++;
      allCandidates.push(...parseSogouSearchPage(html, searchUrl.toString(), getResponseCookies(response)));
      warnings.push('公开索引首次扫描没有精确候选，已自动复核首页。');
    } catch (error) {
      warnings.push(`公开索引空结果复核失败: ${query} 第 1 页 (${(error as Error).message})`);
    }
  }

  const exactAccountCandidates = allCandidates.filter(candidate => candidate.accountName === input.accountName);
  const exactCandidates = Array.from(
    new Map(
      exactAccountCandidates
        .filter(candidate => candidate.epoch === 0 || candidate.epoch >= input.notBefore)
        .map(candidate => [getCandidateIdentity(candidate), candidate])
    ).values()
  )
    .sort((left, right) => right.epoch - left.epoch)
    .slice(0, PUBLIC_ARTICLE_CANDIDATE_LIMIT);

  if (exactAccountCandidates.length > PUBLIC_ARTICLE_CANDIDATE_LIMIT) {
    warnings.push(`精确账号候选超过单轮上限 ${PUBLIC_ARTICLE_CANDIDATE_LIMIT}，其余候选留待下一轮。`);
  }

  const articles: PublicArticleDiscoveryArticle[] = [];
  let rejectedCandidates = 0;
  for (const candidate of exactCandidates) {
    try {
      await gateSogou();
      const clickResponse = await fetchWithTimeout(
        fetchImpl,
        buildSogouClickUrl(candidate.redirectUrl, candidate.guardOffset),
        {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Cookie: candidate.cookie,
            Referer: candidate.evidenceUrl,
          },
          redirect: 'manual',
        },
        requestTimeoutMs
      );
      let target = '';
      if (clickResponse.status >= 300 && clickResponse.status < 400) {
        target = assertWechatArticleUrl(clickResponse.headers.get('location') || '').toString();
      } else {
        if (!clickResponse.ok) throw new Error(`Sogou redirect HTTP ${clickResponse.status}`);
        target = parseSogouRedirectTarget(await clickResponse.text());
      }

      await gateWechat();
      const articleResponse = await fetchWithTimeout(
        fetchImpl,
        target,
        {
          headers: { 'User-Agent': USER_AGENT, Referer: `${SOGOU_ORIGIN}/` },
          redirect: 'manual',
        },
        requestTimeoutMs
      );
      if (!articleResponse.ok) throw new Error(`WeChat article HTTP ${articleResponse.status}`);
      const article = parseVerifiedWechatArticle(
        await articleResponse.text(),
        input.expectedBiz,
        candidate.evidenceUrl,
        target
      );
      if (article.publishTime < input.notBefore) continue;
      articles.push(article);
    } catch (error) {
      rejectedCandidates++;
      warnings.push(`候选校验失败: ${candidate.title} (${(error as Error).message})`);
    }
  }

  const uniqueArticles = Array.from(new Map(articles.map(article => [article.aid, article])).values()).sort(
    (left, right) => right.publishTime - left.publishTime
  );
  if (successfulSearchPages > 0 && exactCandidates.length === 0) {
    warnings.push('公开索引中没有发现指定时间范围内、来源账号精确匹配的文章。');
  }

  const allCandidateVerificationFailed =
    exactCandidates.length > 0 && rejectedCandidates === exactCandidates.length && uniqueArticles.length === 0;

  return {
    base_resp:
      successfulSearchPages === 0
        ? { ret: -1, err_msg: '所有公开索引查询均失败' }
        : allCandidateVerificationFailed
          ? { ret: -1, err_msg: '所有公开索引候选校验均失败' }
          : { ret: 0 },
    source: PUBLIC_ARTICLE_LIST_SOURCE,
    coverage: 'partial',
    articles: uniqueArticles,
    queries: profile.queries,
    warnings,
    metrics: {
      candidates: allCandidates.length,
      emptyResultRetries,
      exactAccountCandidates: exactCandidates.length,
      rejectedCandidates,
      searchPageRequests,
      searchPages: successfulSearchPages,
      verifiedArticles: uniqueArticles.length,
    },
  };
}

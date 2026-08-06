import { setTimeout as sleep } from 'node:timers/promises';
import { load } from 'cheerio';

const KCHUHAI_ORIGIN = 'https://www.kchuhai.com';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_INTERVAL_MS = 500;
const MAX_SEARCH_RESULTS = 5;

export const KCHUHAI_MIRROR_SOURCE = 'kchuhai_public_mirror' as const;

export interface KchuhaiMirrorArticle {
  accountName: string;
  bodyHtml: string;
  mirrorUrl: string;
  originalUrl: string;
  publishDate: string;
  title: string;
}

export interface KchuhaiMirrorDiscoveryResponse {
  base_resp: { ret: number; err_msg?: string };
  candidates: Array<Omit<KchuhaiMirrorArticle, 'bodyHtml'>>;
  coverage: 'partial';
  source: typeof KCHUHAI_MIRROR_SOURCE;
  warnings: string[];
}

export interface KchuhaiMirrorRuntime {
  fetchImpl?: typeof fetch;
  requestIntervalMs?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function assertKchuhaiMirrorUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.kchuhai.com' ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/report\/view-\d+\.html$/.test(url.pathname)
  ) {
    throw new Error('镜像地址不是受信任的快出海文章');
  }
  url.search = '';
  url.hash = '';
  return url;
}

function assertWechatOriginalUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    !/^\/s(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname) ||
    url.username ||
    url.password
  ) {
    throw new Error('镜像没有提供有效的微信原文地址');
  }
  url.hash = '';
  return url;
}

export function parseKchuhaiMirrorArticle(html: string, mirrorUrl: string): KchuhaiMirrorArticle {
  const trustedMirrorUrl = assertKchuhaiMirrorUrl(mirrorUrl).toString();
  const $ = load(html);
  const title = cleanText($('h1').first().text());
  const labels = $('div')
    .toArray()
    .map(element => cleanText($(element).text()))
    .filter(text => text.length <= 160);
  const sourceLabel = labels
    .filter(text => text.startsWith('来源：'))
    .sort((left, right) => left.length - right.length)[0];
  const accountName = cleanText(sourceLabel?.slice('来源：'.length));
  const publishDate = cleanText(labels.find(text => /^时间：\d{4}-\d{2}-\d{2}$/.test(text))?.slice('时间：'.length));
  const originalAnchor = $('a[href*="mp.weixin.qq.com/s"]').first();
  const originalUrl = assertWechatOriginalUrl(originalAnchor.attr('href') || '').toString();
  const content = $('.kch-detailBox').first().clone();
  content.find('script, style, link, noscript, iframe').remove();
  const bodyHtml = content.html() || '';
  const hasContent = cleanText(content.text()).length > 0 || content.find('img').length > 0;
  if (!title || !accountName || !/^\d{4}-\d{2}-\d{2}$/.test(publishDate) || !hasContent) {
    throw new Error('镜像文章元数据或正文不完整');
  }

  return { accountName, bodyHtml, mirrorUrl: trustedMirrorUrl, originalUrl, publishDate, title };
}

export function parseKchuhaiSearchResults(html: string, expectedTitle: string): string[] {
  const $ = load(html);
  const urls = new Set<string>();
  $('a[href*="/report/view-"]').each((_, element) => {
    const anchor = $(element);
    if (cleanText(anchor.attr('title') || anchor.text()) !== cleanText(expectedTitle)) return;
    try {
      urls.add(assertKchuhaiMirrorUrl(anchor.attr('href') || '').toString());
    } catch {
      // Ignore malformed and off-origin search results.
    }
  });
  return Array.from(urls).slice(0, MAX_SEARCH_RESULTS);
}

async function readBoundedHtml(response: Response, label: string): Promise<string> {
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error(`${label}响应过大`);
  const html = await response.text();
  if (html.length > MAX_RESPONSE_BYTES) throw new Error(`${label}响应过大`);
  return html;
}

export async function discoverKchuhaiMirrorArticles(
  expectedTitle: string,
  expectedAccountName: string,
  notBefore: string,
  runtime: KchuhaiMirrorRuntime = {}
): Promise<KchuhaiMirrorDiscoveryResponse> {
  const title = cleanText(expectedTitle);
  const accountName = cleanText(expectedAccountName);
  const fetchImpl = runtime.fetchImpl || fetch;
  const sleepImpl = runtime.sleepImpl || (milliseconds => sleep(milliseconds));
  const warnings = ['公开镜像只用于恢复已核实缺口，不能证明公众号历史完整。'];

  try {
    const searchResponse = await fetchImpl(`${KCHUHAI_ORIGIN}/Process/handler_searchpage.ashx`, {
      body: new URLSearchParams({ action: 'all', key_word: title, page: '1' }),
      headers: {
        Accept: 'text/html,*/*',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      },
      method: 'POST',
      redirect: 'manual',
    });
    const resultUrls = parseKchuhaiSearchResults(await readBoundedHtml(searchResponse, '快出海搜索'), title);
    const candidates: Array<Omit<KchuhaiMirrorArticle, 'bodyHtml'>> = [];
    for (const mirrorUrl of resultUrls) {
      if ((runtime.requestIntervalMs ?? REQUEST_INTERVAL_MS) > 0) {
        await sleepImpl(runtime.requestIntervalMs ?? REQUEST_INTERVAL_MS);
      }
      try {
        const detailResponse = await fetchImpl(mirrorUrl, {
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          },
          redirect: 'manual',
        });
        const article = parseKchuhaiMirrorArticle(await readBoundedHtml(detailResponse, '快出海文章'), mirrorUrl);
        if (article.title !== title || article.accountName !== accountName || article.publishDate < notBefore) continue;
        const { bodyHtml: _bodyHtml, ...candidate } = article;
        candidates.push(candidate);
      } catch (error) {
        warnings.push(`镜像候选校验失败: ${(error as Error).message}`);
      }
    }
    return {
      base_resp: { ret: 0 },
      candidates,
      coverage: 'partial',
      source: KCHUHAI_MIRROR_SOURCE,
      warnings,
    };
  } catch (error) {
    return {
      base_resp: { ret: -1, err_msg: (error as Error).message },
      candidates: [],
      coverage: 'partial',
      source: KCHUHAI_MIRROR_SOURCE,
      warnings,
    };
  }
}

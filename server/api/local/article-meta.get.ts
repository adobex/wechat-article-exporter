import * as cheerio from 'cheerio';

const ALLOWED_HOSTS = new Set(['mp.weixin.qq.com']);

function parseArticleUrl(rawUrl: string): URL {
  const url = new URL(rawUrl.trim());
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error('请提供有效的微信公众号文章链接');
  }
  return url;
}

export default defineEventHandler(async event => {
  const query = getQuery<{ url: string }>(event);

  if (!query.url) {
    return { success: false, error: 'url 不能为空' };
  }

  try {
    const url = parseArticleUrl(decodeURIComponent(query.url));
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://mp.weixin.qq.com/',
      },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return { success: false, error: '微信文章发生重定向，已拒绝跟随' };
    }
    if (!response.ok) {
      return { success: false, error: `获取文章元数据失败: HTTP ${response.status}` };
    }

    const html = await response.text();

    const $ = cheerio.load(html);

    const first = (selectors: string[], fallback = '') => {
      for (const sel of selectors) {
        const text = $(sel).first().text().replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      return fallback;
    };

    const title = first(['.rich_media_title', '#activity-name', 'h1'], '');
    const author = first(['#js_author_name', '#js_name'], '');
    const accountName = first(['.profile_nickname', '#js_name'], '');
    const publishDate = first(['#publish_time', '.publish_time'], '');
    const cover =
      $('meta[property="og:image"]').attr('content') || $('meta[property="twitter:image"]').attr('content') || '';
    const digest = $('#js_content').text().replace(/\s+/g, ' ').trim().slice(0, 160);

    return { success: true, title, author, accountName, publishDate, cover, digest };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
});

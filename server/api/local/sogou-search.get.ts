import { load } from 'cheerio';
import { PUBLIC_ARTICLE_SEARCH_PAGE_LIMIT } from '#shared/utils/public-article-discovery';
import { isSogouSearchResultPage } from '~/server/utils/sogou-public-discovery';

interface SogouSearchResult {
  title: string;
  url: string;
  account: string;
  abstract: string;
  cover: string;
  time: string;
}

export default defineEventHandler(async event => {
  const query = getQuery<{ query?: string; page?: string }>(event);
  const keyword = String(query.query || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!keyword || keyword.length > 80) {
    return { base_resp: { ret: -1, err_msg: 'query 不能为空' }, results: [] };
  }

  const page = Number(query.page) || 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > PUBLIC_ARTICLE_SEARCH_PAGE_LIMIT) {
    return { base_resp: { ret: -1, err_msg: `page 必须在 1-${PUBLIC_ARTICLE_SEARCH_PAGE_LIMIT} 之间` }, results: [] };
  }
  const searchUrl = new URL('https://wx.sogou.com/weixin');
  searchUrl.search = new URLSearchParams({ type: '2', query: keyword, page: String(page), ie: 'utf8' }).toString();

  const response = await fetch(searchUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Referer: 'https://wx.sogou.com/',
    },
    redirect: 'manual',
  });
  if (!response.ok) {
    return { base_resp: { ret: -1, err_msg: `搜狗搜索 HTTP ${response.status}` }, results: [], page };
  }
  const html = await response.text();
  if (!isSogouSearchResultPage(html)) {
    return { base_resp: { ret: -1, err_msg: '搜狗返回了异常或频控页面' }, results: [], page };
  }

  const $ = load(html);
  const results: SogouSearchResult[] = [];

  $('.news-list li .txt-box').each((_, el) => {
    const $el = $(el);
    const $title = $el.find('h3 a');
    const title = $title.text().trim();
    const href = $title.attr('href') || '';
    const url = href.startsWith('http') ? href : `https://wx.sogou.com${href}`;
    const account =
      $el.find('.s-p .all-time-y2, .s-p .all_time_meta, .s-p a[data-z]').first().text().trim() ||
      $el.find('.account').text().trim();
    const abstract = $el.find('p.txt-info').text().trim();
    const time = $el.find('.s-p .date, .s2').text().trim();
    const $img = $el.prev('div.img-box').find('img');
    const cover = $img.attr('src') || '';

    if (title && href) {
      results.push({ title, url, account, abstract, cover, time });
    }
  });

  if (results.length === 0) {
    $('ul.news-list > li').each((_, li) => {
      const $li = $(li);
      const $a = $li.find('a').first();
      const title = $a.text().trim();
      const href = $a.attr('href') || '';
      const url = href.startsWith('http') ? href : `https://wx.sogou.com${href}`;
      const abstract = $li.find('p').first().text().trim();

      if (title && href) {
        results.push({ title, url, account: '', abstract, cover: '', time: '' });
      }
    });
  }

  return { base_resp: { ret: 0 }, results, page };
});

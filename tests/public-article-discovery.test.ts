import { describe, expect, it, vi } from 'vitest';
import {
  buildSogouClickUrl,
  discoverPublicWechatArticles,
  hasNextSogouSearchPage,
  isSogouSearchResultPage,
  parseSogouRedirectTarget,
  parseVerifiedWechatArticle,
} from '../server/utils/sogou-public-discovery';
import {
  getPublicArticleDiscoveryProfile,
  normalizePublicDiscoveryNotBefore,
  publicDiscoveryArticleToAppMsgEx,
} from '../shared/utils/public-article-discovery';

const BIZ = 'MzkyMDAwMDAwMA==';
const REDIRECT_PATH = `/link?url=${'A'.repeat(180)}&type=2&query=test&token=null`;

function searchHtml(accountName = '目标公众号', epoch = 1_785_505_943, hasNext = false, documentId = ''): string {
  return `
    <ul class="news-list">
      <li${documentId ? ` d="${documentId}"` : ''}>
        <div class="txt-box">
          <h3><a href="${REDIRECT_PATH}">已发现文章</a></h3>
          <div class="s-p">
            <span class="all-time-y2">${accountName}</span>
            <span class="s2"><script>document.write(timeConvert('${epoch}'))</script></span>
          </div>
        </div>
      </li>
    </ul>
    ${hasNext ? '<a id="sogou_next" href="?page=2">下一页</a>' : ''}
    <script>var toolParas = {};</script>
    <script>var b=37,a=this.href.indexOf("url=");a=this.href.substr(a+4+parseInt("21")+b,1);</script>
  `;
}

function searchHtmlMany(count: number): string {
  const rows = Array.from(
    { length: count },
    (_, index) => `
      <li d="document-${index}">
      <h3><a href="/link?url=${'A'.repeat(180)}${index}&type=2&query=test&token=null">文章 ${index}</a></h3>
      <div class="s-p">
        <span class="all-time-y2">目标公众号</span>
        <span class="s2"><script>document.write(timeConvert('1785505943'))</script></span>
      </div>
    </li>
  `
  ).join('');
  return `
    <ul class="news-list">${rows}</ul>
    <script>var toolParas = {};</script>
    <script>var b=37,a=this.href.indexOf("url=");a=this.href.substr(a+4+parseInt("21")+b,1);</script>
  `;
}

function redirectHtml(target = 'https://mp.weixin.qq.com/s?src=11&signature=public'): string {
  const pivot = Math.floor(target.length / 2);
  return `<script>var url='';url += '${target.slice(0, pivot)}';url += '${target.slice(pivot)}';location.replace(url);</script>`;
}

function articleHtml(biz = BIZ, mid = 2_247_486_000): string {
  return `
    <html><head>
      <meta property="og:title" content="已发现文章" />
      <meta property="og:image" content="https://mmbiz.qpic.cn/cover/0" />
      <meta name="description" content="文章摘要" />
      <meta name="author" content="作者" />
    </head><body>
      <a id="js_name">目标公众号</a>
      <div id="js_content"><p>正文内容</p></div>
      <script>
        var biz = "${biz}";
        var mid = "${mid}";
        var idx = "1";
        var sn = "" || "abcdef0123456789" || "";
        var oriCreateTime = '1785505943';
      </script>
    </body></html>
  `;
}

describe('public article discovery profiles', () => {
  it('uses the same bounded name-based strategy for every stable account identity', () => {
    expect(getPublicArticleDiscoveryProfile('游戏吗喽说', 'MzkyMDcyNTEyNA==', 2026)).toEqual({
      queries: ['游戏吗喽说'],
      searchPages: 10,
    });
    expect(getPublicArticleDiscoveryProfile('新游观察', 'MzkyMzY2OTc5Mw==', 2026)).toEqual({
      queries: ['新游观察'],
      searchPages: 10,
    });
    expect(getPublicArticleDiscoveryProfile('任意公众号', 'Z2VuZXJpYy1hY2NvdW50', 2026)).toEqual({
      queries: ['任意公众号'],
      searchPages: 10,
    });
  });

  it('does not add speculative query variants for a historical date floor', () => {
    expect(getPublicArticleDiscoveryProfile('游戏吗喽说', 'MzkyMDcyNTEyNA==', 2026, 2025).queries).toEqual([
      '游戏吗喽说',
    ]);
    expect(getPublicArticleDiscoveryProfile('新游观察', 'MzkyMzY2OTc5Mw==', 2026, 2025).queries).toEqual(['新游观察']);
  });

  it('accepts an Asia/Shanghai date floor without falling back to one year', () => {
    expect(normalizePublicDiscoveryNotBefore('2025-01-01', 1_785_505_943)).toBe(1_735_660_800);
    expect(normalizePublicDiscoveryNotBefore('invalid', 1_785_505_943)).toBe(1_753_883_543);
  });
});

describe('Sogou redirect safety', () => {
  it('adds the click guard without changing the allowed origin', () => {
    const clickUrl = new URL(buildSogouClickUrl(`https://wx.sogou.com${REDIRECT_PATH}`, 21));
    expect(clickUrl.origin).toBe('https://wx.sogou.com');
    expect(clickUrl.pathname).toBe('/link');
    expect(clickUrl.searchParams.get('k')).toBe('37');
    expect(clickUrl.searchParams.get('h')).toBeTruthy();
  });

  it('rejects a reconstructed redirect to a non-WeChat host', () => {
    expect(() => parseSogouRedirectTarget(redirectHtml('https://evil.example/s?src=11'))).toThrow(
      'allowed WeChat article URL'
    );
  });

  it('recognizes only real result pages and follows their next-page marker', () => {
    expect(isSogouSearchResultPage(searchHtml())).toBe(true);
    expect(isSogouSearchResultPage('<html><form id="searchForm"></form></html>')).toBe(false);
    expect(hasNextSogouSearchPage(searchHtml('目标公众号', 1_785_505_943, true))).toBe(true);
    expect(hasNextSogouSearchPage(searchHtml())).toBe(false);
  });
});

describe('verified public discovery', () => {
  it('resolves, verifies, and normalizes a same-account article', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(searchHtml(), {
          status: 200,
          headers: { 'set-cookie': 'SNUID=ephemeral; Path=/; HttpOnly' },
        })
      )
      .mockResolvedValueOnce(new Response(redirectHtml(), { status: 200 }))
      .mockResolvedValueOnce(new Response(articleHtml(), { status: 200 }));

    const result = await discoverPublicWechatArticles(
      { accountName: '目标公众号', expectedBiz: BIZ, notBefore: 1_700_000_000 },
      { fetchImpl, searchIntervalMs: 0, wechatIntervalMs: 0 }
    );

    expect(result.base_resp.ret).toBe(0);
    expect(result.coverage).toBe('partial');
    expect(result.metrics).toMatchObject({ exactAccountCandidates: 1, rejectedCandidates: 0, verifiedArticles: 1 });
    expect(result.articles[0]).toMatchObject({
      accountName: '目标公众号',
      aid: '2247486000_1',
      biz: BIZ,
      canonicalLink: expect.stringContaining('mid=2247486000'),
      publishTime: 1_785_505_943,
      title: '已发现文章',
    });
    expect(result.articles[0].link).toContain('mp.weixin.qq.com/s?');
    expect(result.articles[0].link).toContain('signature=public');
    expect(JSON.stringify(result)).not.toContain('ephemeral');

    const cached = publicDiscoveryArticleToAppMsgEx(result.articles[0]);
    expect(cached).toMatchObject({ aid: '2247486000_1', appmsgid: 2247486000, itemidx: 1, is_deleted: false });
  });

  it('does not resolve a search result attributed to another account', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(searchHtml('冒名账号'), { status: 200 }));
    const result = await discoverPublicWechatArticles(
      { accountName: '目标公众号', expectedBiz: BIZ, notBefore: 1_700_000_000 },
      { fetchImpl, searchIntervalMs: 0, wechatIntervalMs: 0 }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.articles).toEqual([]);
    expect(result.metrics).toMatchObject({ emptyResultRetries: 1, exactAccountCandidates: 0 });
  });

  it('continues through result pages until the next-page marker disappears', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(searchHtml('其他公众号', 1_785_505_943, true), { status: 200 }))
      .mockResolvedValueOnce(new Response(searchHtml('其他公众号', 1_785_505_943, true), { status: 200 }))
      .mockResolvedValueOnce(new Response(searchHtml('其他公众号'), { status: 200 }))
      .mockResolvedValueOnce(new Response(searchHtml('其他公众号'), { status: 200 }));

    const result = await discoverPublicWechatArticles(
      { accountName: '目标公众号', expectedBiz: BIZ, notBefore: 1_700_000_000 },
      { fetchImpl, searchIntervalMs: 0, wechatIntervalMs: 0 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.metrics).toMatchObject({ emptyResultRetries: 1, searchPageRequests: 4, searchPages: 4 });
  });

  it('rechecks the first page once when an initial scan has no exact in-range candidate', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(searchHtml('其他公众号'), { status: 200 }))
      .mockResolvedValueOnce(new Response(searchHtml(), { status: 200 }))
      .mockResolvedValueOnce(new Response(redirectHtml(), { status: 200 }))
      .mockResolvedValueOnce(new Response(articleHtml(), { status: 200 }));

    const result = await discoverPublicWechatArticles(
      { accountName: '目标公众号', expectedBiz: BIZ, notBefore: 1_700_000_000 },
      { fetchImpl, searchIntervalMs: 0, wechatIntervalMs: 0 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.metrics).toMatchObject({
      emptyResultRetries: 1,
      exactAccountCandidates: 1,
      searchPageRequests: 2,
      searchPages: 2,
      verifiedArticles: 1,
    });
    expect(result.warnings).toContain('公开索引首次扫描没有精确候选，已自动复核首页。');
  });

  it('stops a stalled public request at the configured timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      });
    });

    const result = await discoverPublicWechatArticles(
      { accountName: '目标公众号', expectedBiz: BIZ, notBefore: 1_700_000_000 },
      { fetchImpl, requestTimeoutMs: 5, searchIntervalMs: 0, wechatIntervalMs: 0 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.base_resp).toEqual({ ret: -1, err_msg: '所有公开索引查询均失败' });
    expect(result.warnings.join('\n')).toContain('request timed out');
  });

  it('deduplicates the same article returned by multiple result pages before verification', async () => {
    const targetBiz = 'MzkyMDcyNTEyNA==';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(searchHtml('游戏吗喽说', 1_785_505_943, true, 'same-id'), { status: 200 }))
      .mockResolvedValueOnce(new Response(searchHtml('游戏吗喽说', 1_785_505_943, false, 'same-id'), { status: 200 }))
      .mockResolvedValueOnce(new Response(redirectHtml(), { status: 200 }))
      .mockResolvedValueOnce(new Response(articleHtml(targetBiz), { status: 200 }));

    const result = await discoverPublicWechatArticles(
      { accountName: '游戏吗喽说', expectedBiz: targetBiz, notBefore: 1_700_000_000 },
      { fetchImpl, searchIntervalMs: 0, wechatIntervalMs: 0 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.metrics).toMatchObject({ candidates: 2, exactAccountCandidates: 1, verifiedArticles: 1 });
  });

  it('verifies more than the former twelve-candidate cutoff', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(searchHtmlMany(13), { status: 200 }));
    for (let index = 0; index < 13; index++) {
      fetchImpl.mockResolvedValueOnce(
        new Response(redirectHtml(`https://mp.weixin.qq.com/s?src=11&signature=public-${index}`), { status: 200 })
      );
      fetchImpl.mockResolvedValueOnce(new Response(articleHtml(BIZ, 2_247_486_000 + index), { status: 200 }));
    }

    const result = await discoverPublicWechatArticles(
      { accountName: '目标公众号', expectedBiz: BIZ, notBefore: 1_700_000_000 },
      { fetchImpl, searchIntervalMs: 0, wechatIntervalMs: 0 }
    );

    expect(result.base_resp.ret).toBe(0);
    expect(result.metrics).toMatchObject({ exactAccountCandidates: 13, verifiedArticles: 13 });
    expect(result.articles).toHaveLength(13);
  });

  it('rejects a page whose stable account identity does not match', () => {
    expect(() => parseVerifiedWechatArticle(articleHtml('Mzg5MDAwMDAwMA=='), BIZ, 'evidence')).toThrow(
      'account identity did not match'
    );
  });

  it('rejects an identity-matching page without article content', () => {
    const empty = articleHtml().replace('<div id="js_content"><p>正文内容</p></div>', '<div id="js_content"></div>');
    expect(() => parseVerifiedWechatArticle(empty, BIZ, 'evidence')).toThrow('article page was incomplete');
  });
});

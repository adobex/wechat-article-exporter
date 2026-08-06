import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverKchuhaiMirrorArticles,
  parseKchuhaiMirrorArticle,
  parseKchuhaiSearchResults,
} from '../server/utils/kchuhai-public-mirror';
import { wechatMirror2md } from '../server/utils/wechat2md';

const BIZ = 'Mzg5MTcwMTI5Nw==';
const ACCOUNT = '王董的新游戏';
const MIRROR_URL = 'https://www.kchuhai.com/report/view-67492.html';
const ORIGINAL_URL = 'https://mp.weixin.qq.com/s/8H8wsFPjjiK_LU90xMkK-Q';
const outputRoot = join(
  process.env.WECHAT2MD_OUTPUT_DIR || join(tmpdir(), 'wechat-article-exporter-tests'),
  `.wechat2md-mirror-test-${randomUUID()}`
);

function mirrorHtml(): string {
  return `<!doctype html><html><body>
    <h1>近期slg和休闲puzzle测试产品汇总</h1>
    <div><div>来源：${ACCOUNT}</div><div>作者：王10</div><div>时间：2026-07-21</div></div>
    <div class="kch-detailBox"><p>可信镜像正文</p><img src="https://img1.kchuhai.com/article.png"></div>
    <div>原文链接：<a href="${ORIGINAL_URL}">点击前往</a></div>
  </body></html>`;
}

afterEach(() => {
  rmSync(outputRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('trusted Kchuhai mirror recovery', () => {
  it('accepts only exact-title report links and validates source metadata plus the WeChat original URL', async () => {
    const searchHtml = `<a href="${MIRROR_URL}" title="近期slg和休闲puzzle测试产品汇总">结果</a>
      <a href="https://evil.example/report/view-1.html" title="近期slg和休闲puzzle测试产品汇总">伪造</a>`;
    expect(parseKchuhaiSearchResults(searchHtml, '近期slg和休闲puzzle测试产品汇总')).toEqual([MIRROR_URL]);
    expect(parseKchuhaiMirrorArticle(mirrorHtml(), MIRROR_URL)).toMatchObject({
      accountName: ACCOUNT,
      originalUrl: ORIGINAL_URL,
      publishDate: '2026-07-21',
    });

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(searchHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(mirrorHtml(), { status: 200 }));
    const discovered = await discoverKchuhaiMirrorArticles('近期slg和休闲puzzle测试产品汇总', ACCOUNT, '2025-01-01', {
      fetchImpl,
      requestIntervalMs: 0,
    });
    expect(discovered.base_resp.ret).toBe(0);
    expect(discovered.candidates).toEqual([
      {
        accountName: ACCOUNT,
        mirrorUrl: MIRROR_URL,
        originalUrl: ORIGINAL_URL,
        publishDate: '2026-07-21',
        title: '近期slg和休闲puzzle测试产品汇总',
      },
    ]);
  });

  it('writes lite Markdown with CDN images and records both original and mirror evidence URLs', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(mirrorHtml(), { status: 200 })));
    const result = await wechatMirror2md(MIRROR_URL, {
      accountName: ACCOUNT,
      expectedBiz: BIZ,
      imageMode: 'cdn',
      outputDir: outputRoot,
      publishDate: '2026-07-21',
      title: '近期slg和休闲puzzle测试产品汇总',
    });
    const markdown = readFileSync(result.filepath, 'utf8');
    assert.match(markdown, new RegExp(`url: ${JSON.stringify(ORIGINAL_URL)}`));
    assert.match(markdown, new RegExp(`source_evidence: ${JSON.stringify(MIRROR_URL)}`));
    assert.match(markdown, /可信镜像正文/);
    assert.match(markdown, /https:\/\/img1\.kchuhai\.com\/article\.png/);
    assert.equal(existsSync(`${result.articleDir}/images`), false);
  });

  it('refuses a mirror whose expected date does not match', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(mirrorHtml(), { status: 200 })));
    await assert.rejects(
      () =>
        wechatMirror2md(MIRROR_URL, {
          accountName: ACCOUNT,
          expectedBiz: BIZ,
          outputDir: outputRoot,
          publishDate: '2026-07-22',
          title: '近期slg和休闲puzzle测试产品汇总',
        }),
      /不匹配/
    );
  });
});

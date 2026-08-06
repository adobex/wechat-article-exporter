import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { wechat2md } from '../server/utils/wechat2md';

const outputRoot = join(
  process.env.WECHAT2MD_OUTPUT_DIR || join(tmpdir(), 'wechat-article-exporter-tests'),
  `.wechat2md-test-${randomUUID()}`
);

afterEach(() => {
  rmSync(outputRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

test('signed acquisition URLs share one durable canonical output identity', async () => {
  const articleHtml = `<!doctype html><html><body>
    <h1 id="activity-name">Canonical identity article</h1>
    <a id="js_name">Canonical test account</a>
    <div id="js_content"><p>Verified article body.</p></div>
    <script>
      var biz = "account";
      var mid = "100";
      var idx = "1";
    </script>
  </body></html>`;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(articleHtml, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  const canonicalUrl = 'https://mp.weixin.qq.com/s?__biz=account&mid=100&idx=1';
  const commonOptions = {
    canonicalUrl,
    imageMode: 'cdn' as const,
    outputDir: outputRoot,
    fallbackMetadata: { publishDate: '2026-08-03' },
  };
  const first = await wechat2md('https://mp.weixin.qq.com/s?src=11&timestamp=1&signature=first', commonOptions);
  const second = await wechat2md('https://mp.weixin.qq.com/s?src=11&timestamp=2&signature=second', commonOptions);

  assert.equal(second.filepath, first.filepath);
  const markdown = readFileSync(first.filepath, 'utf8');
  assert.match(markdown, /url: "https:\/\/mp\.weixin\.qq\.com\/s\?__biz=account&mid=100&idx=1"/);
  assert.doesNotMatch(markdown, /signature=(?:first|second)/);
  assert.deepEqual(
    fetchMock.mock.calls.map(call => String(call[0])),
    [
      'https://mp.weixin.qq.com/s?src=11&timestamp=1&signature=first',
      'https://mp.weixin.qq.com/s?src=11&timestamp=2&signature=second',
    ]
  );
  assert.ok(fetchMock.mock.calls.every(call => call[1]?.redirect === 'manual'));
});

test('expired or mismatched signed links cannot write a canonical article', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `<!doctype html><script>
        var biz = "account";
        var mid = "999";
        var idx = "1";
      </script><div id="js_content">Wrong article.</div>`,
        { status: 200 }
      )
    )
  );

  await assert.rejects(
    () =>
      wechat2md('https://mp.weixin.qq.com/s?src=11&timestamp=3&signature=expired', {
        canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=account&mid=100&idx=1',
        imageMode: 'cdn',
        outputDir: outputRoot,
      }),
    /失效或返回了不匹配的文章/
  );
});

test('signed article downloads do not follow redirects', async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/article' } }));
  vi.stubGlobal('fetch', fetchMock);

  await assert.rejects(
    () =>
      wechat2md('https://mp.weixin.qq.com/s?src=11&timestamp=4&signature=redirect', {
        canonicalUrl: 'https://mp.weixin.qq.com/s?__biz=account&mid=100&idx=1',
        imageMode: 'cdn',
        outputDir: outputRoot,
      }),
    /文章下载失败: HTTP 302/
  );
  assert.equal(fetchMock.mock.calls[0][1]?.redirect, 'manual');
});

test('article downloads reject a body from a different stable account', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `<!doctype html><script>var biz = "b3RoZXJCaXo=";</script>
        <h1 id="activity-name">Wrong account</h1><div id="js_content">Wrong body.</div>`,
        { status: 200 }
      )
    )
  );

  await assert.rejects(
    () =>
      wechat2md('https://mp.weixin.qq.com/s/article-token', {
        expectedBiz: 'dGFyZ2V0Qml6',
        imageMode: 'cdn',
        outputDir: outputRoot,
      }),
    /文章所属公众号与目标账号不匹配/
  );
});

test('article downloads reject empty bodies instead of writing title-only Markdown', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `<!doctype html><script>var biz = "dGFyZ2V0Qml6";</script>
        <h1 id="activity-name">Title without body</h1><div id="js_content">  </div>`,
        { status: 200 }
      )
    )
  );

  await assert.rejects(
    () =>
      wechat2md('https://mp.weixin.qq.com/s/article-token', {
        expectedBiz: 'dGFyZ2V0Qml6',
        fallbackMetadata: { title: 'Title without body' },
        imageMode: 'cdn',
        outputDir: outputRoot,
      }),
    /未找到文章内容/
  );
});

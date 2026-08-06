import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  type ArticleOutputPlan,
  articleUrlHash,
  assertUniqueArticleOutputTargets,
  normalizeArticleUrl,
  planArticleOutputPaths,
} from '../shared/utils/article-output-path';

const firstUrl = 'https://mp.weixin.qq.com/s?__biz=account&mid=100&idx=1#wechat_redirect';
const secondUrl = 'https://mp.weixin.qq.com/s?__biz=account&mid=200&idx=1';

test('URL hash remains compatible with the existing SHA-1 directory suffix', async () => {
  const normalized = normalizeArticleUrl(firstUrl);
  const expected = createHash('sha1').update(normalized).digest('hex');
  assert.equal(await articleUrlHash(firstUrl), expected);
});

test('WeChat tracking parameters do not create a second article identity', () => {
  const base = 'http://mp.weixin.qq.com/s?mid=100&idx=1&sn=abc&__biz=account';
  const shared = `${base}&scene=1&subscene=10000&chksm=tracking#wechat_redirect`;
  assert.equal(normalizeArticleUrl(shared), normalizeArticleUrl(base));
});

test('same account and title reserve unique paths for different URLs', async () => {
  const plans = await planArticleOutputPaths([
    { accountName: '测试公众号', title: '同名文章', publishDate: '2026-07-10 12:00:00', url: firstUrl },
    { accountName: '测试公众号', title: '同名文章', publishDate: '2026-07-11 12:00:00', url: secondUrl },
  ]);

  assert.equal(plans[0].relativeDirectory, '测试公众号/同名文章');
  assert.match(plans[1].relativeDirectory, /^测试公众号\/同名文章--20260711-[a-f0-9]{8}$/);
  assert.notEqual(plans[0].relativeDirectory, plans[1].relativeDirectory);
});

test('duplicate URL is idempotent within a batch', async () => {
  const plans = await planArticleOutputPaths([
    { accountName: '测试公众号', title: '同名文章', url: firstUrl },
    { accountName: '测试公众号', title: '同名文章', url: firstUrl },
  ]);

  assert.equal(plans[0].relativeDirectory, plans[1].relativeDirectory);
  assert.equal(plans[0].normalizedUrl, plans[1].normalizedUrl);
});

test('existing URL path wins even when later metadata changes', async () => {
  const existingDirectory = '测试公众号/旧标题--20260101-deadbeef';
  const [plan] = await planArticleOutputPaths(
    [{ accountName: '测试公众号', title: '新标题', publishDate: '2026-07-10', url: firstUrl }],
    { existing: [{ relativeDirectory: existingDirectory, url: firstUrl }] }
  );

  assert.equal(plan.relativeDirectory, existingDirectory);
});

test('unknown or conflicting occupants force a URL-hashed target', async () => {
  const [plan] = await planArticleOutputPaths(
    [{ accountName: 'A/B', title: '冲突标题', publishDate: '2026年7月10日', url: firstUrl }],
    { existing: [{ relativeDirectory: 'A-B/冲突标题', url: null }] }
  );

  assert.match(plan.relativeDirectory, /^A-B\/冲突标题--20260710-[a-f0-9]{8}$/);
});

test('preflight rejects distinct URLs assigned to the same target', () => {
  const base: Omit<ArticleOutputPlan, 'normalizedUrl'> = {
    relativeDirectory: '测试公众号/同名文章',
    accountDirectory: '测试公众号',
    titleDirectory: '同名文章',
    collision: false,
  };
  assert.throws(
    () =>
      assertUniqueArticleOutputTargets([
        { ...base, normalizedUrl: normalizeArticleUrl(firstUrl) },
        { ...base, normalizedUrl: normalizeArticleUrl(secondUrl) },
      ]),
    /文章输出路径冲突/
  );
});

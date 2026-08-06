import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runVisibleCatalogRecovery, validateOfficialEvidence } from '../scripts/wechat2md/visible_catalog_recovery.mjs';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(item => rm(item, { recursive: true, force: true })));
});

async function writeArticle(accountDir: string, title: string, date: string, url: string) {
  const articleDir = path.join(accountDir, title);
  const filepath = path.join(articleDir, 'index.md');
  await mkdir(articleDir, { recursive: true });
  await writeFile(
    filepath,
    `---\ntitle: ${JSON.stringify(title)}\ndate: ${JSON.stringify(date)}\nurl: ${JSON.stringify(url)}\n---\n\nBody\n`
  );
  return filepath;
}

describe('visible catalog recovery', () => {
  test('downloads only missing entries, repairs backed-up short URLs, and reruns as a no-op', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wechat-visible-recovery-'));
    cleanupPaths.push(root);
    const outputRoot = path.join(root, 'output');
    const accountName = '任意公众号';
    const stableBiz = 'Z2VuZXJpYy1hY2NvdW50';
    const ownerToken = '11111111-2222-4333-8444-555555555555';
    const accountDir = path.join(outputRoot, accountName);
    const leaseFile = path.join(root, 'lease.json');
    const canonicalExistingUrl = `https://mp.weixin.qq.com/s?__biz=${stableBiz}&mid=100&idx=1`;
    const repairedExistingUrl = `https://mp.weixin.qq.com/s?__biz=${stableBiz}&mid=200&idx=1`;
    const missingUrl = `https://mp.weixin.qq.com/s?__biz=${stableBiz}&mid=300&idx=1`;

    await writeArticle(accountDir, 'Existing canonical', '2026-07-31', canonicalExistingUrl);
    await writeArticle(accountDir, 'Existing short', '2026-07-20', 'https://mp.weixin.qq.com/s/short-token');
    await writeFile(leaseFile, JSON.stringify({ owner_token: ownerToken, expires_at: '2030-01-01T00:00:00.000Z' }));

    const catalog = {
      accountName,
      stableBiz,
      boundary: '2026-07-01',
      boundaryReached: true,
      initialDirectoryEntries: 4,
      initialOldestDate: '2026-06-29',
      directoryEntriesLoaded: 4,
      scrollSteps: 0,
      oldestLoadedDate: '2026-06-29',
      entries: [
        { index: 0, title: 'Existing canonical', publishDate: '2026-07-31' },
        { index: 1, title: 'Existing short', publishDate: '2026-07-20' },
        { index: 2, title: 'Missing article', publishDate: '2026-07-10' },
        { index: 3, title: 'Older boundary proof', publishDate: '2026-06-29' },
      ],
    };
    const officialArticles = {
      accountName,
      stableBiz,
      entries: [
        {
          title: 'Existing short',
          date: '2026-07-20',
          url: repairedExistingUrl,
          stableBiz,
          mid: '200',
          idx: '1',
          bodyLength: 100,
        },
        {
          title: 'Missing article',
          date: '2026-07-10',
          url: missingUrl,
          stableBiz,
          mid: '300',
          idx: '1',
          bodyLength: 100,
        },
      ],
    };

    async function makeRunDir(name: string) {
      const runDir = path.join(root, name);
      await mkdir(runDir, { recursive: true });
      const catalogPath = path.join(runDir, 'catalog.json');
      const evidencePath = path.join(runDir, 'official.json');
      await writeFile(path.join(runDir, 'run.json'), JSON.stringify({ owner_token: ownerToken }));
      await writeFile(catalogPath, JSON.stringify(catalog));
      await writeFile(evidencePath, JSON.stringify(officialArticles));
      return { catalogPath, evidencePath, runDir };
    }

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/local/wechat2md/credentials')) {
        return new Response(JSON.stringify({ success: true, outputDir: outputRoot }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({
        accountName,
        canonicalUrl: missingUrl,
        expectedBiz: stableBiz,
        imageMode: 'cdn',
        mode: 'lite',
        outputDir: outputRoot,
        title: 'Missing article',
      });
      const filepath = await writeArticle(accountDir, payload.title, payload.publishDate, payload.canonicalUrl);
      return new Response(JSON.stringify({ success: true, filepath, title: payload.title }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const firstRun = await makeRunDir('run-1');
    const first = await runVisibleCatalogRecovery(
      {
        accountName,
        stableBiz,
        catalog: firstRun.catalogPath,
        officialArticles: firstRun.evidencePath,
        runDir: firstRun.runDir,
        ownerToken,
        outputRoot,
        leaseFile,
        applyUrlRepairs: true,
      },
      { fetchImpl: fetchMock, now: () => new Date('2026-08-06T00:00:00.000Z') }
    );

    expect(first.report).toMatchObject({
      status: 'complete',
      empty_batch: false,
      local_recovered_articles: 1,
      canonical_url_repairs: 1,
      local_stable_identities_verified: 3,
    });
    expect(JSON.parse(await readFile(first.manifestPath, 'utf8'))).toHaveLength(1);
    expect(await readFile(path.join(accountDir, 'Existing short', 'index.md'), 'utf8')).toContain(repairedExistingUrl);
    expect(
      await readFile(path.join(firstRun.runDir, 'backups', 'canonical-url', 'Existing short', 'index.md'), 'utf8')
    ).toContain('https://mp.weixin.qq.com/s/short-token');

    const secondRun = await makeRunDir('run-2');
    const second = await runVisibleCatalogRecovery(
      {
        accountName,
        stableBiz,
        catalog: secondRun.catalogPath,
        officialArticles: secondRun.evidencePath,
        runDir: secondRun.runDir,
        ownerToken,
        outputRoot,
        leaseFile,
        applyUrlRepairs: true,
      },
      { fetchImpl: fetchMock, now: () => new Date('2026-08-06T00:00:00.000Z') }
    );

    expect(second.report).toMatchObject({ status: 'complete', empty_batch: true, local_recovered_articles: 0 });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  test('requires official URL evidence for every missing catalog article', () => {
    expect(() =>
      validateOfficialEvidence({
        accountName: '任意公众号',
        stableBiz: 'Z2VuZXJpYy1hY2NvdW50',
        catalog: {
          boundary: '2026-07-01',
          entries: [{ title: 'Missing article', publishDate: '2026-07-10' }],
        },
        evidence: {
          entries: [
            {
              title: 'Different article',
              date: '2026-07-10',
              url: 'https://mp.weixin.qq.com/s?__biz=Z2VuZXJpYy1hY2NvdW50&mid=300&idx=1',
              bodyLength: 100,
            },
          ],
        },
        preAudit: {
          missing: [{ title: 'Missing article', publishDate: '2026-07-10' }],
          matched: [],
        },
      })
    ).toThrow(/exact catalog match|missing official URL evidence/);
  });
});

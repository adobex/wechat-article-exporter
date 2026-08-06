import { describe, expect, test } from 'vitest';
import {
  buildLocalExportArticle,
  isLocalExportCandidateForAccount,
  type LocalExportManifestEntry,
  normalizeLocalExportUrl,
} from '../shared/utils/local-export-recovery';

const entry: LocalExportManifestEntry = {
  title: 'Example',
  accountName: '王董的新游戏',
  publishDate: '2025-09-09',
  url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=2247502242&idx=1&sn=test#rd',
  filepath: '/output/Example/index.md',
  articleDir: '/output/Example',
  relativePath: 'Example/index.md',
  mtimeMs: 0,
};

describe('local export recovery', () => {
  test('builds an account-scoped article from canonical WeChat identity', () => {
    const article = buildLocalExportArticle(entry, 'Mzg5MTcwMTI5Nw==');
    expect(article).toMatchObject({
      aid: '2247502242_1',
      appmsgid: 2247502242,
      itemidx: 1,
      title: 'Example',
      create_time: 1757347200,
    });
    expect(article?.link).not.toContain('#rd');
  });

  test('rejects a canonical URL owned by another account', () => {
    expect(buildLocalExportArticle(entry, 'wrong-biz')).toBeNull();
  });

  test('uses a deterministic synthetic identity for legacy short links', () => {
    const shortEntry = { ...entry, url: 'https://mp.weixin.qq.com/s/short-token' };
    const first = buildLocalExportArticle(shortEntry, 'Mzg5MTcwMTI5Nw==');
    const second = buildLocalExportArticle(shortEntry, 'Mzg5MTcwMTI5Nw==');
    expect(first?.aid).toMatch(/^local-\d+_1$/);
    expect(second?.aid).toBe(first?.aid);
    expect(
      buildLocalExportArticle(shortEntry, 'Mzg5MTcwMTI5Nw==', {
        requireCanonicalIdentity: true,
      })
    ).toBeNull();
  });

  test('does not guess a missing canonical item index', () => {
    const missingIndex = {
      ...entry,
      url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=2247502242',
    };
    expect(
      buildLocalExportArticle(missingIndex, 'Mzg5MTcwMTI5Nw==', {
        requireCanonicalIdentity: true,
      })
    ).toBeNull();
  });

  test('rejects zero-valued canonical identity components', () => {
    const zeroMid = {
      ...entry,
      url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=0&idx=1',
    };
    const zeroIndex = {
      ...entry,
      url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=2247502242&idx=0',
    };
    expect(buildLocalExportArticle(zeroMid, 'Mzg5MTcwMTI5Nw==', { requireCanonicalIdentity: true })).toBeNull();
    expect(buildLocalExportArticle(zeroIndex, 'Mzg5MTcwMTI5Nw==', { requireCanonicalIdentity: true })).toBeNull();
  });

  test('accepts a renamed account by stable biz instead of display name', () => {
    const renamedEntry = { ...entry, accountName: '历史名称' };
    expect(isLocalExportCandidateForAccount(renamedEntry, '当前名称', 'Mzg5MTcwMTI5Nw==')).toBe(true);
    expect(isLocalExportCandidateForAccount(renamedEntry, '当前名称', 'wrong-biz')).toBe(false);
  });

  test('rejects missing or impossible publication dates in canonical recovery mode', () => {
    for (const publishDate of ['', '2025/09/09', '2025-02-30']) {
      expect(
        buildLocalExportArticle(
          { ...entry, publishDate, mtimeMs: Date.parse('2026-01-01T00:00:00+08:00') },
          'Mzg5MTcwMTI5Nw==',
          { requireCanonicalIdentity: true }
        )
      ).toBeNull();
    }
  });

  test('accepts only canonical HTTPS WeChat hosts', () => {
    expect(normalizeLocalExportUrl('http://mp.weixin.qq.com/s/a')).toBeNull();
    expect(normalizeLocalExportUrl('https://example.com/s/a')).toBeNull();
  });
});

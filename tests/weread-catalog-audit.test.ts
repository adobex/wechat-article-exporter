import { describe, expect, test } from 'vitest';
import {
  auditCatalog,
  parseFrontmatter,
  planCanonicalUrlRepairs,
  replaceFrontmatterDate,
  replaceFrontmatterUrl,
  stableWechatIdentity,
} from '../scripts/wechat2md/weread_catalog_audit.mjs';

describe('WeRead catalog audit', () => {
  test('requires proof that the catalog crossed the requested boundary', () => {
    expect(() =>
      auditCatalog(
        {
          boundary: '2025-01-01',
          boundaryReached: false,
          directoryEntriesLoaded: 2,
          initialDirectoryEntries: 1,
          initialOldestDate: '2025-02-02',
          scrollSteps: 1,
          oldestLoadedDate: '2025-01-02',
          entries: [
            { title: 'A', publishDate: '2025-02-02' },
            { title: 'B', publishDate: '2025-01-02' },
          ],
        },
        []
      )
    ).toThrow(/does not prove/);
  });

  test('separates missing files from trusted date repairs', () => {
    const report = auditCatalog(
      {
        boundary: '2025-01-01',
        boundaryReached: true,
        directoryEntriesLoaded: 3,
        initialDirectoryEntries: 1,
        initialOldestDate: '2025-01-03',
        scrollSteps: 2,
        oldestLoadedDate: '2024-12-31',
        entries: [
          { index: 0, title: 'Existing', publishDate: '2025-01-03' },
          { index: 1, title: 'Missing', publishDate: '2025-01-02' },
          { index: 2, title: 'Older', publishDate: '2024-12-31' },
        ],
      },
      [{ file: '/account/existing/index.md', title: 'Existing', date: '2026-04-16' }]
    );

    expect(report.summary).toMatchObject({
      eligibleEntries: 2,
      matched: 1,
      missing: 1,
      dateMismatches: 1,
    });
    expect(report.dateMismatches[0]).toMatchObject({
      expectedDate: '2025-01-03',
      confidence: 'unique-title',
    });
  });

  test('parses quoted YAML frontmatter without guessing fields', () => {
    expect(parseFrontmatter('---\ntitle: "Example"\ndate: "2025-01-03"\n---\n\nBody\n')).toEqual({
      title: 'Example',
      date: '2025-01-03',
    });
  });

  test('rejects an unchanged first lazy-loaded batch', () => {
    expect(() =>
      auditCatalog(
        {
          boundary: '2025-01-01',
          boundaryReached: false,
          directoryEntriesLoaded: 2,
          initialDirectoryEntries: 2,
          initialOldestDate: '2025-01-15',
          scrollSteps: 1,
          oldestLoadedDate: '2025-01-15',
          entries: [
            { title: 'A', publishDate: '2025-02-01' },
            { title: 'B', publishDate: '2025-01-15' },
          ],
        },
        []
      )
    ).toThrow(/did not grow/);
  });

  test('does not guess between reused titles with a wrong local date', () => {
    const report = auditCatalog(
      {
        boundary: '2025-01-01',
        boundaryReached: true,
        directoryEntriesLoaded: 3,
        initialDirectoryEntries: 1,
        initialOldestDate: '2025-02-01',
        scrollSteps: 2,
        oldestLoadedDate: '2024-12-31',
        entries: [
          { title: 'Repeated', publishDate: '2025-02-01' },
          { title: 'Repeated', publishDate: '2025-01-15' },
          { title: 'Older', publishDate: '2024-12-31' },
        ],
      },
      [{ file: '/account/repeated/index.md', title: 'Repeated', date: '2026-04-16' }]
    );

    expect(report.summary).toMatchObject({ matched: 0, missing: 0, ambiguous: 2 });
    expect(report.dateMismatches).toEqual([]);
  });

  test('repairs only the frontmatter date scalar', () => {
    const original = '---\ntitle: "Example"\ndate: "2026-04-16"\n---\n\nBody date: unchanged\n';
    expect(replaceFrontmatterDate(original, '2025-01-03')).toBe(
      '---\ntitle: "Example"\ndate: "2025-01-03"\n---\n\nBody date: unchanged\n'
    );
  });

  test('plans an official URL repair only for an identity-free WeChat short link', () => {
    const matched = [
      {
        official: { title: 'Repeated', publishDate: '2026-07-21' },
        local: {
          file: '/account/repeated/index.md',
          title: 'Repeated',
          date: '2026-07-21',
          url: 'https://mp.weixin.qq.com/s/short-token',
        },
      },
    ];
    const plan = planCanonicalUrlRepairs(
      matched,
      {
        entries: [
          {
            title: 'Repeated',
            date: '2026-07-21',
            url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=2247508712&idx=1',
          },
        ],
      },
      'Mzg5MTcwMTI5Nw=='
    );

    expect(plan.repairs).toHaveLength(1);
    expect(plan.identityMismatches).toEqual([]);
    expect(plan.evidenceErrors).toEqual([]);
  });

  test('does not rewrite an existing matching stable identity', () => {
    const plan = planCanonicalUrlRepairs(
      [
        {
          official: { title: 'Existing', publishDate: '2026-07-30' },
          local: {
            file: '/account/existing/index.md',
            title: 'Existing',
            date: '2026-07-30',
            url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=2247508867&idx=1',
          },
        },
      ],
      {
        entries: [
          {
            title: 'Existing',
            date: '2026-07-30',
            url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=2247508867&idx=1&sn=official',
          },
        ],
      },
      'Mzg5MTcwMTI5Nw=='
    );

    expect(plan.verified).toHaveLength(1);
    expect(plan.repairs).toEqual([]);
  });

  test('blocks a conflicting stable article identity', () => {
    const plan = planCanonicalUrlRepairs(
      [
        {
          official: { title: 'Conflict', publishDate: '2026-07-30' },
          local: {
            file: '/account/conflict/index.md',
            title: 'Conflict',
            date: '2026-07-30',
            url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=111&idx=1',
          },
        },
      ],
      {
        entries: [
          {
            title: 'Conflict',
            date: '2026-07-30',
            url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=222&idx=1',
          },
        ],
      },
      'Mzg5MTcwMTI5Nw=='
    );

    expect(plan.repairs).toEqual([]);
    expect(plan.identityMismatches).toHaveLength(1);
  });

  test('blocks a conflicting partial article identity instead of overwriting it', () => {
    const plan = planCanonicalUrlRepairs(
      [
        {
          official: { title: 'Partial conflict', publishDate: '2026-07-21' },
          local: {
            file: '/account/partial/index.md',
            title: 'Partial conflict',
            date: '2026-07-21',
            url: 'https://mp.weixin.qq.com/s?mid=111',
          },
        },
      ],
      {
        entries: [
          {
            title: 'Partial conflict',
            date: '2026-07-21',
            url: 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=222&idx=1',
          },
        ],
      },
      'Mzg5MTcwMTI5Nw=='
    );

    expect(plan.repairs).toEqual([]);
    expect(plan.identityMismatches).toHaveLength(1);
  });

  test('repairs only the frontmatter URL scalar and validates the previous value', () => {
    const original = '---\ntitle: "Example"\nurl: "https://mp.weixin.qq.com/s/short"\n---\n\nBody URL unchanged\n';
    const canonical = 'https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=123&idx=1';
    expect(replaceFrontmatterUrl(original, 'https://mp.weixin.qq.com/s/short', canonical)).toBe(
      `---\ntitle: "Example"\nurl: ${JSON.stringify(canonical)}\n---\n\nBody URL unchanged\n`
    );
    expect(() => replaceFrontmatterUrl(original, 'https://mp.weixin.qq.com/s/changed', canonical)).toThrow(
      /changed after audit/
    );
    expect(stableWechatIdentity(canonical, 'Mzg5MTcwMTI5Nw==')).toMatchObject({ mid: '123', idx: '1' });
    expect(
      stableWechatIdentity('https://mp.weixin.qq.com/s?__biz=Mzg5MTcwMTI5Nw%3D%3D&mid=0&idx=1', 'Mzg5MTcwMTI5Nw==')
    ).toBeNull();
  });
});

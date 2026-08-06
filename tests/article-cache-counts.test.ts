import { describe, expect, it } from 'vitest';
import { countNewArticleCacheEntries, reconcileArticleMessageTotal } from '../shared/utils/article-cache';
import type { AppMsgEx } from '../types/types';

function article(aid: string): AppMsgEx {
  return { aid } as AppMsgEx;
}

describe('article cache entry counts', () => {
  it('counts each new multi-article publication once', () => {
    const result = countNewArticleCacheEntries([], 'biz', [[article('100_1'), article('100_2')], [article('101_1')]]);

    expect(result).toEqual({ articleCount: 3, messageCount: 2 });
  });

  it('does not recount a known publication when a missing child is added', () => {
    const result = countNewArticleCacheEntries(['biz:100_1'], 'biz', [[article('100_1'), article('100_2')]]);

    expect(result).toEqual({ articleCount: 1, messageCount: 0 });
  });

  it('does not recount a known publication when only a different sibling was cached', () => {
    const result = countNewArticleCacheEntries(['biz:100_2'], 'biz', [[article('100_1')]]);

    expect(result).toEqual({ articleCount: 1, messageCount: 0 });
  });

  it('does not recount duplicate groups within the same write batch', () => {
    const result = countNewArticleCacheEntries([], 'biz', [[article('100_1')], [article('100_1')]]);

    expect(result).toEqual({ articleCount: 1, messageCount: 1 });
  });

  it('raises a stale reported total when a newly discovered publication is stored', () => {
    expect(reconcileArticleMessageTotal(31, 31, 1)).toBe(32);
    expect(reconcileArticleMessageTotal(40, 31, 1)).toBe(40);
  });
});

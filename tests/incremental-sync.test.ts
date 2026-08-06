import { describe, expect, it } from 'vitest';
import {
  getBoundedOverlapPolicy,
  getOverlapDateFloor,
  isBoundedOverlapComplete,
  pageCrossesHighWatermark,
} from '../shared/utils/incremental-sync';

describe('incremental account scan', () => {
  const now = 2_000_000_000;
  const day = 24 * 60 * 60;
  const highWatermark = {
    articleIds: ['100_1', '100_2'],
    publishTimestamp: now - 10 * day,
  };

  it('uses the minimum overlap after a recent successful sync', () => {
    expect(getBoundedOverlapPolicy(now - day, now)).toEqual({ days: 14, pagesAfterCrossing: 6 });
  });

  it('uses the conservative maximum calendar overlap when no prior success exists', () => {
    expect(getBoundedOverlapPolicy(undefined, now)).toEqual({ days: 45, pagesAfterCrossing: 11 });
  });

  it('crosses the watermark by stable id or by reaching an older timestamp', () => {
    expect(
      pageCrossesHighWatermark([{ aid: '100_2', create_time: highWatermark.publishTimestamp }], highWatermark)
    ).toBe(true);
    expect(
      pageCrossesHighWatermark([{ aid: '99_1', create_time: highWatermark.publishTimestamp - 1 }], highWatermark)
    ).toBe(true);
    expect(
      pageCrossesHighWatermark([{ aid: '101_1', create_time: highWatermark.publishTimestamp + 1 }], highWatermark)
    ).toBe(false);
  });

  it('requires both page and calendar overlap before stopping', () => {
    const calendarFloor = getOverlapDateFloor(highWatermark, 14, 0);
    const base = {
      calendarFloor,
      oldestPublishTimestamp: calendarFloor,
      pagesAfterCrossing: 6,
      requiredPagesAfterCrossing: 6,
      watermarkCrossed: true,
    };

    expect(isBoundedOverlapComplete(base)).toBe(true);
    expect(isBoundedOverlapComplete({ ...base, pagesAfterCrossing: 5 })).toBe(false);
    expect(isBoundedOverlapComplete({ ...base, oldestPublishTimestamp: calendarFloor + 1 })).toBe(false);
    expect(isBoundedOverlapComplete({ ...base, watermarkCrossed: false })).toBe(false);
  });
});

const DAY_SECONDS = 24 * 60 * 60;

export interface ArticleHighWatermark {
  articleIds: string[];
  publishTimestamp: number;
}

export interface BoundedOverlapPolicy {
  days: number;
  pagesAfterCrossing: number;
}

interface ArticleIdentity {
  aid: string;
  create_time: number;
}

export function getBoundedOverlapPolicy(lastSuccessfulAt?: number, now = Math.floor(Date.now() / 1000)) {
  const daysSinceLastSuccess = lastSuccessfulAt ? Math.max(0, Math.ceil((now - lastSuccessfulAt) / DAY_SECONDS)) : 45;
  const days = Math.min(45, Math.max(14, daysSinceLastSuccess + 7));
  const extraPages = Math.ceil(Math.max(0, days - 14) / 7);
  return {
    days,
    pagesAfterCrossing: Math.min(12, 6 + extraPages),
  } satisfies BoundedOverlapPolicy;
}

export function pageCrossesHighWatermark(articles: ArticleIdentity[], highWatermark: ArticleHighWatermark): boolean {
  const watermarkIds = new Set(highWatermark.articleIds);
  return articles.some(
    article =>
      article.create_time < highWatermark.publishTimestamp ||
      (article.create_time === highWatermark.publishTimestamp && watermarkIds.has(article.aid))
  );
}

export function getOverlapDateFloor(highWatermark: ArticleHighWatermark, overlapDays: number, hardFloor: number) {
  return Math.max(hardFloor, highWatermark.publishTimestamp - overlapDays * DAY_SECONDS);
}

export function isBoundedOverlapComplete(options: {
  calendarFloor: number;
  oldestPublishTimestamp: number;
  pagesAfterCrossing: number;
  requiredPagesAfterCrossing: number;
  watermarkCrossed: boolean;
}): boolean {
  return (
    options.watermarkCrossed &&
    options.pagesAfterCrossing >= options.requiredPagesAfterCrossing &&
    options.oldestPublishTimestamp <= options.calendarFloor
  );
}

import type { AppMsgEx } from '~/types/types';

export interface ArticleCacheEntryCounts {
  articleCount: number;
  messageCount: number;
}

function articleKey(fakeid: string, article: AppMsgEx): string {
  return `${fakeid}:${article.aid}`;
}

export function articleMessageId(article: Pick<AppMsgEx, 'aid'>): string {
  const separator = article.aid.lastIndexOf('_');
  return separator > 0 ? article.aid.slice(0, separator) : article.aid;
}

export function reconcileArticleMessageTotal(
  reportedTotal: number,
  currentStoredMessages: number,
  newMessages: number
): number {
  return Math.max(reportedTotal, currentStoredMessages + newMessages);
}

function storedMessageIds(existingKeys: Iterable<unknown>, fakeid: string): Set<string> {
  const prefix = `${fakeid}:`;
  const messageIds = new Set<string>();
  for (const key of existingKeys) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
    messageIds.add(articleMessageId({ aid: key.slice(prefix.length) }));
  }
  return messageIds;
}

export function countNewArticleCacheEntries(
  existingKeys: Iterable<unknown>,
  fakeid: string,
  articleGroups: AppMsgEx[][]
): ArticleCacheEntryCounts {
  const keys = new Set(existingKeys);
  const messageIds = storedMessageIds(existingKeys, fakeid);
  let articleCount = 0;
  let messageCount = 0;

  for (const articles of articleGroups) {
    const groupMessageIds = new Set(articles.map(articleMessageId));
    const messageAlreadyKnown = Array.from(groupMessageIds).some(messageId => messageIds.has(messageId));
    let newArticleCount = 0;

    for (const article of articles) {
      const key = articleKey(fakeid, article);
      if (keys.has(key)) continue;
      keys.add(key);
      newArticleCount++;
      articleCount++;
    }

    if (!messageAlreadyKnown && newArticleCount > 0) messageCount++;
    for (const messageId of groupMessageIds) messageIds.add(messageId);
  }

  return { articleCount, messageCount };
}

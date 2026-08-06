import {
  articleMessageId,
  countNewArticleCacheEntries,
  reconcileArticleMessageTotal,
} from '#shared/utils/article-cache';
import type { ArticleHighWatermark } from '#shared/utils/incremental-sync';
import type { AppMsgEx, AppMsgExWithFakeID, PublishInfo, PublishPage } from '~/types/types';
import { db } from './db';
import { type MpAccount, updateInfoCache } from './info';

export type ArticleAsset = AppMsgExWithFakeID;

export async function getArticleHighWatermark(fakeid: string): Promise<ArticleHighWatermark | null> {
  const articles = await db.article.where('fakeid').equals(fakeid).toArray();
  const publishTimestamp = articles.reduce((latest, article) => Math.max(latest, article.create_time), 0);
  if (!publishTimestamp) return null;

  return {
    publishTimestamp,
    articleIds: Array.from(
      new Set(articles.filter(article => article.create_time === publishTimestamp).map(article => article.aid))
    ).sort(),
  };
}

async function persistArticleGroups(
  account: MpAccount,
  articleGroups: AppMsgEx[][],
  completed: boolean,
  totalCount: number,
  replaceCompletion = false
) {
  await db.transaction('rw', ['article', 'info'], async () => {
    const fakeid = account.fakeid;
    const existingKeys = await db.article.toCollection().keys();
    const { articleCount, messageCount } = countNewArticleCacheEntries(existingKeys, fakeid, articleGroups);

    for (const articles of articleGroups) {
      for (const article of articles) {
        const key = `${fakeid}:${article.aid}`;
        await db.article.put({ ...article, fakeid, _status: '' }, key);
      }
    }

    await updateInfoCache(
      {
        fakeid,
        completed,
        count: messageCount,
        articles: articleCount,
        nickname: account.nickname,
        round_head_img: account.round_head_img,
        total_count: reconcileArticleMessageTotal(totalCount, account.count, messageCount),
      },
      { replaceCompletion }
    );
  });
}

/**
 * 更新文章缓存
 * @param account
 * @param publish_page
 */
export async function updateArticleCache(account: MpAccount, publish_page: PublishPage) {
  const publishList = publish_page.publish_list.filter(item => !!item.publish_info);
  const articleGroups = publishList.map(item => {
    const publishInfo: PublishInfo = JSON.parse(item.publish_info);
    return publishInfo.appmsgex;
  });
  await persistArticleGroups(account, articleGroups, publishList.length === 0, publish_page.total_count);
}

export async function updateProfileArticleCache(
  account: MpAccount,
  articles: AppMsgEx[],
  options: { completed: boolean; replaceCompletion?: boolean; totalCount: number }
) {
  const groups = new Map<string, AppMsgEx[]>();
  for (const article of articles) {
    const messageId = articleMessageId(article);
    const group = groups.get(messageId) || [];
    group.push(article);
    groups.set(messageId, group);
  }
  await persistArticleGroups(
    account,
    Array.from(groups.values()),
    options.completed,
    options.totalCount,
    options.replaceCompletion
  );
}

function normalizedLinkIdentity(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim();
  }
}

export async function recoverLocalArticleCache(account: MpAccount, articles: AppMsgEx[]) {
  if (articles.length === 0) return { articleCount: 0, messageCount: 0 };

  const existing = await db.article.where('fakeid').equals(account.fakeid).toArray();
  const existingKeys = new Set(existing.map(article => `${account.fakeid}:${article.aid}`));
  const existingLinks = new Set(existing.map(article => normalizedLinkIdentity(article.link)));
  const accepted: AppMsgEx[] = [];

  for (const article of articles) {
    const key = `${account.fakeid}:${article.aid}`;
    const link = normalizedLinkIdentity(article.link);
    if (existingKeys.has(key) || existingLinks.has(link)) continue;
    existingKeys.add(key);
    existingLinks.add(link);
    accepted.push(article);
  }

  const existingMessageIds = new Set(existing.map(articleMessageId));
  const messageCount = new Set(accepted.map(articleMessageId).filter(messageId => !existingMessageIds.has(messageId)))
    .size;
  await updateProfileArticleCache(account, accepted, {
    completed: false,
    replaceCompletion: true,
    totalCount: Math.max(account.total_count, account.count + messageCount),
  });
  return { articleCount: accepted.length, messageCount };
}

/**
 * 检查是否存在指定时间之前的缓存
 * @param fakeid 公众号id
 * @param create_time 创建时间
 */
export async function hitCache(fakeid: string, create_time: number): Promise<boolean> {
  const count = await db.article
    .where('fakeid')
    .equals(fakeid)
    .and(article => article.create_time < create_time)
    .count();
  return count > 0;
}

/**
 * 读取缓存中的指定时间之前的历史文章
 * @param fakeid 公众号id
 * @param create_time 创建时间
 */
export async function getArticleCache(fakeid: string, create_time: number): Promise<AppMsgExWithFakeID[]> {
  return db.article
    .where('fakeid')
    .equals(fakeid)
    .and(article => article.create_time < create_time)
    .reverse()
    .sortBy('create_time');
}

/**
 * 根据 url 获取文章对象
 * @param url
 */
export async function getArticleByLink(url: string): Promise<AppMsgExWithFakeID> {
  const article = await db.article.where('link').equals(url).first();
  if (!article) {
    throw new Error(`Article(${url}) does not exist`);
  }
  return article;
}

// 根据 url 获取 SINGLE_ARTICLE_FAKEID 文章对象
export async function getSingleArticleByLink(url: string): Promise<AppMsgExWithFakeID> {
  const article = await db.article
    .where('link')
    .equals(url)
    .and(article => article.fakeid === 'SINGLE_ARTICLE_FAKEID')
    .first();
  if (!article) {
    throw new Error(`Article(${url}) does not exist`);
  }

  return article;
}

/**
 * 文章被删除
 * @param url
 * @param is_deleted
 */
export async function articleDeleted(url: string, is_deleted = true): Promise<void> {
  await db.transaction('rw', 'article', async () => {
    await db.article
      .where('link')
      .equals(url)
      .modify(article => {
        article.is_deleted = is_deleted;
      });
  });
}

/**
 * 更新文章状态
 * @param url
 * @param status
 */
export async function updateArticleStatus(url: string, status: string): Promise<void> {
  await db.transaction('rw', 'article', async () => {
    await db.article
      .where('link')
      .equals(url)
      .modify(article => {
        article._status = status;
      });
  });
}

/**
 * 更新文章的fakeid
 * @param url
 * @param fakeid
 */
export async function updateArticleFakeid(url: string, fakeid: string): Promise<void> {
  await db.transaction('rw', 'article', async () => {
    await db.article
      .where('link')
      .equals(url)
      .and(article => article.fakeid === 'SINGLE_ARTICLE_FAKEID')
      .modify(article => {
        article.fakeid = fakeid;

        // 标记改数据是【单篇文章下载】添加的
        article._single = true;
      });
  });
}

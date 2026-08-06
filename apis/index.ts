import { FREQUENCY_CONTROL_RET, retryFrequencyControlledRequest } from '#shared/utils/frequency-control';
import { normalizeProfileGetMsgResponse, profileArticleToAppMsgEx } from '#shared/utils/profile-ext';
import {
  type PublicArticleDiscoveryResponse,
  publicDiscoveryArticleToAppMsgEx,
} from '#shared/utils/public-article-discovery';
import { request } from '#shared/utils/request';
import { ACCOUNT_LIST_PAGE_SIZE, ARTICLE_LIST_PAGE_SIZE } from '~/config';
import { updateArticleCache, updateProfileArticleCache } from '~/store/v2/article';
import { type MpAccount, updateLastUpdateTime } from '~/store/v2/info';
import type { CommentResponse } from '~/types/comment';
import type { ParsedCredential } from '~/types/credential';
import type { ProfileArticlePage, ProfileGetMsgResponse } from '~/types/profile_getmsg';
import type {
  AccountInfo,
  AppMsgEx,
  AppMsgPublishResponse,
  PublishInfo,
  PublishPage,
  SearchBizResponse,
} from '~/types/types';

const loginAccount = useLoginAccount();
const credentials = useLocalStorage<ParsedCredential[]>('auto-detect-credentials:credentials', []);
const INTERACTIVE_FREQUENCY_CONTROL_COOLDOWN_MS = 15 * 60 * 1000;

let appmsgpublishFrequencyControlledUntil = 0;
let profileExtFrequencyControlledUntil = 0;

export type ArticleListSource = 'appmsgpublish' | 'local_export' | 'profile_ext' | 'public_index';

export interface ArticleListPageResult {
  articles: AppMsgEx[];
  completed: boolean;
  messageCount: number;
  nextBegin: number;
  pageBegin: number;
  source: ArticleListSource;
  sourcePageCount?: number;
  sourceRetryCount?: number;
  totalCount: number;
  coverage?: 'complete' | 'partial';
  warnings?: string[];
}

export interface ArticleListOptions {
  allowPublicFallback?: boolean;
  deferLastUpdate?: boolean;
  onFrequencyControl?: (delayMs: number, source: ArticleListSource) => void;
  notBefore?: number;
  signal?: AbortSignal;
  source?: ArticleListSource;
}

export class AuthenticatedArticleListUnavailableError extends Error {
  readonly code = 'AUTHENTICATED_ARTICLE_LIST_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'AuthenticatedArticleListUnavailableError';
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { cause?: { name?: unknown }; name?: unknown };
  return candidate.name === 'AbortError' || candidate.cause?.name === 'AbortError';
}

async function requireArticleCacheWrite(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    console.error('写入文章缓存失败:', error);
    throw new Error('文章缓存写入失败，同步已停止');
  }
}

async function getProfileArticleList(
  account: MpAccount,
  begin: number,
  keyword: string,
  options: ArticleListOptions
): Promise<ArticleListPageResult> {
  if (Date.now() < profileExtFrequencyControlledUntil) {
    throw new AuthenticatedArticleListUnavailableError('profile_ext 仍在频控冷却期');
  }

  let page: ProfileArticlePage;
  try {
    page = await retryFrequencyControlledRequest(
      () =>
        request<ProfileArticlePage>('/api/local/wechat2md/article-list', {
          query: { id: account.fakeid, begin, size: 10 },
          signal: options.signal,
        }),
      {
        backoffMs: [],
        onBackoff: delayMs => options.onFrequencyControl?.(delayMs, 'profile_ext'),
        signal: options.signal,
      }
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new AuthenticatedArticleListUnavailableError(
      '200013:微信接口频控；本地备用接口不可用，请确认使用 localhost:3000'
    );
  }

  if (page.base_resp.ret !== 0) {
    if (page.base_resp.ret === -2) {
      throw new AuthenticatedArticleListUnavailableError(
        '200013:微信接口频控；没有该公众号 25 分钟内的有效 Credential'
      );
    }
    if (page.base_resp.ret === FREQUENCY_CONTROL_RET) {
      profileExtFrequencyControlledUntil = Date.now() + INTERACTIVE_FREQUENCY_CONTROL_COOLDOWN_MS;
      options.onFrequencyControl?.(0, 'profile_ext');
      throw new AuthenticatedArticleListUnavailableError('200013:公众号后台与备用接口均处于频控');
    }
    throw new AuthenticatedArticleListUnavailableError(
      `${page.base_resp.ret}:${page.base_resp.err_msg || 'profile_ext fallback failed'}`
    );
  }

  const allArticles = page.articles.map(profileArticleToAppMsgEx);
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  const articles = normalizedKeyword
    ? allArticles.filter(article => article.title.toLocaleLowerCase().includes(normalizedKeyword))
    : allArticles;
  const completed = !page.can_continue;
  const totalCount = Math.max(account.total_count || 0, begin + page.message_count, page.next_offset);

  if (!keyword) {
    await requireArticleCacheWrite(async () => {
      await updateProfileArticleCache(account, allArticles, { completed, totalCount });
      if (begin === 0 && !options.deferLastUpdate) await updateLastUpdateTime(account.fakeid);
    });
  }

  return {
    articles,
    completed,
    messageCount: page.message_count,
    nextBegin: page.next_offset,
    pageBegin: begin,
    source: 'profile_ext',
    totalCount,
  };
}

async function getPublicArticleList(
  account: MpAccount,
  keyword: string,
  options: ArticleListOptions
): Promise<ArticleListPageResult> {
  const page = await request<PublicArticleDiscoveryResponse>('/api/local/public-article-discovery', {
    method: 'POST',
    body: {
      accountName: account.nickname || account.fakeid,
      expectedBiz: account.fakeid,
      notBefore: options.notBefore,
    },
    signal: options.signal,
  });
  if (page.base_resp.ret !== 0) {
    throw new Error(`公开索引拉取失败: ${page.base_resp.err_msg || 'unknown error'}`);
  }

  const allArticles = page.articles.map(publicDiscoveryArticleToAppMsgEx);
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  const articles = normalizedKeyword
    ? allArticles.filter(article => article.title.toLocaleLowerCase().includes(normalizedKeyword))
    : allArticles;
  const totalCount = Math.max(account.total_count || 0, account.count || 0, allArticles.length);

  if (!keyword) {
    await requireArticleCacheWrite(() =>
      updateProfileArticleCache(account, allArticles, {
        completed: false,
        replaceCompletion: true,
        totalCount,
      })
    );
  }

  return {
    articles,
    completed: false,
    coverage: 'partial',
    messageCount: new Set(allArticles.map(article => article.aid.replace(/_\d+$/, ''))).size,
    nextBegin: 0,
    pageBegin: 0,
    source: 'public_index',
    sourcePageCount: page.metrics.searchPages,
    sourceRetryCount: page.metrics.emptyResultRetries,
    totalCount,
    warnings: page.warnings,
  };
}

async function getAuthenticatedFallback(
  account: MpAccount,
  begin: number,
  keyword: string,
  options: ArticleListOptions
): Promise<ArticleListPageResult> {
  try {
    return await getProfileArticleList(account, begin, keyword, options);
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (!(error instanceof AuthenticatedArticleListUnavailableError)) throw error;
    if (options.allowPublicFallback === false) throw error;
    return getPublicArticleList(account, keyword, options);
  }
}

/**
 * 获取文章列表
 * @param account
 * @param begin
 * @param keyword
 * @return 当前文章页、完成状态、下一游标与实际数据源
 */
export async function getArticleList(
  account: MpAccount,
  begin = 0,
  keyword = '',
  options: ArticleListOptions = {}
): Promise<ArticleListPageResult> {
  const requestedSource = options.source ?? 'public_index';
  let publicSourceFailed = false;
  if (requestedSource === 'local_export') {
    throw new Error('本地导出由公众号管理页直接对齐，不能作为网络文章列表接口调用');
  }
  if (requestedSource === 'public_index') {
    try {
      return await getPublicArticleList(account, keyword, options);
    } catch (error) {
      if (isAbortError(error) || options.source === 'public_index') throw error;
      publicSourceFailed = true;
    }
  }
  if (requestedSource === 'profile_ext') {
    return getAuthenticatedFallback(account, begin, keyword, options);
  }
  const authenticatedFallbackOptions = publicSourceFailed ? { ...options, allowPublicFallback: false } : options;
  if (Date.now() < appmsgpublishFrequencyControlledUntil) {
    return getAuthenticatedFallback(account, 0, keyword, authenticatedFallbackOptions);
  }

  let resp: AppMsgPublishResponse;
  try {
    resp = await retryFrequencyControlledRequest(
      () =>
        request<AppMsgPublishResponse>('/api/web/mp/appmsgpublish', {
          query: {
            id: account.fakeid,
            begin,
            size: ARTICLE_LIST_PAGE_SIZE,
            keyword,
          },
          signal: options.signal,
        }),
      {
        backoffMs: [],
        onBackoff: delayMs => options.onFrequencyControl?.(delayMs, 'appmsgpublish'),
        signal: options.signal,
      }
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return getAuthenticatedFallback(account, 0, keyword, authenticatedFallbackOptions);
  }

  if (resp.base_resp.ret === 0) {
    const publish_page: PublishPage = JSON.parse(resp.publish_page);
    const publish_list = publish_page.publish_list.filter(item => !!item.publish_info);

    // 返回的文章数量为0就表示已加载完毕
    const isCompleted = publish_list.length === 0;

    // 更新缓存，注意带有关键字搜索的结果不能写入缓存
    if (!keyword) {
      await requireArticleCacheWrite(async () => {
        await updateArticleCache(account, publish_page);
        if (begin === 0 && !options.deferLastUpdate) {
          await updateLastUpdateTime(account.fakeid);
        }
      });
    }

    const articles = publish_list.flatMap(item => {
      const publish_info: PublishInfo = JSON.parse(item.publish_info);
      return publish_info.appmsgex;
    });
    const messageCount = articles.filter(article => article.itemidx === 1).length;
    return {
      articles,
      completed: isCompleted,
      messageCount,
      nextBegin: begin + messageCount,
      pageBegin: begin,
      source: 'appmsgpublish',
      totalCount: publish_page.total_count,
    };
  } else if (resp.base_resp.ret === 200003) {
    loginAccount.value = null;
    return getAuthenticatedFallback(account, begin, keyword, authenticatedFallbackOptions);
  } else if (resp.base_resp.ret === FREQUENCY_CONTROL_RET) {
    appmsgpublishFrequencyControlledUntil = Date.now() + INTERACTIVE_FREQUENCY_CONTROL_COOLDOWN_MS;
    options.onFrequencyControl?.(0, 'appmsgpublish');
    return getAuthenticatedFallback(account, 0, keyword, authenticatedFallbackOptions);
  } else {
    throw new Error(`${resp.base_resp.ret}:${resp.base_resp.err_msg}`);
  }
}

/**
 * 获取公众号列表
 * @param begin
 * @param keyword
 */
export async function getAccountList(begin = 0, keyword = ''): Promise<[AccountInfo[], boolean]> {
  const resp = await request<SearchBizResponse>('/api/web/mp/searchbiz', {
    query: {
      begin: begin,
      size: ACCOUNT_LIST_PAGE_SIZE,
      keyword: keyword,
    },
  });

  if (resp.base_resp.ret === 0) {
    // 公众号判断是否结束的逻辑与文章不太一样
    // 当第一页的结果就少于5个则结束，否则只有当搜索结果为空才表示结束
    const isCompleted = begin === 0 ? resp.total < ACCOUNT_LIST_PAGE_SIZE : resp.total === 0;

    return [resp.list, isCompleted];
  } else if (resp.base_resp.ret === 200003) {
    loginAccount.value = null;
    throw new Error('session expired');
  } else {
    throw new Error(`${resp.base_resp.ret}:${resp.base_resp.err_msg}`);
  }
}

/**
 * 获取评论
 * @param commentId
 */
export async function getComment(commentId: string) {
  try {
    // 本地设置的 credentials
    const credentials = JSON.parse(window.localStorage.getItem('credentials')!);
    if (!credentials || !credentials.__biz || !credentials.pass_ticket || !credentials.key || !credentials.uin) {
      console.warn('credentials not set');
      return null;
    }
    const response = await request<CommentResponse>('/api/web/misc/comment', {
      query: {
        comment_id: commentId,
        ...credentials,
      },
    });
    if (response.base_resp.ret === 0) {
      return response;
    } else {
      return null;
    }
  } catch (e) {
    console.warn('credentials parse error', e);
    return null;
  }
}

/**
 * 获取公众号文章列表
 * @description 该接口采用微信接口，而非公众号平台接口，因此需要先获取 Credentials
 * @param fakeid
 * @param begin
 */
export async function getArticleListWithCredential(fakeid: string, begin = 0) {
  const targetCredential = credentials.value.find(item => item.biz === fakeid);
  if (!targetCredential) {
    throw new Error('目标公众号的 Credential 未设置');
  }

  const resp = await request<ProfileGetMsgResponse>('/api/web/mp/profile_ext_getmsg', {
    method: 'POST',
    body: {
      id: fakeid,
      begin: begin,
      size: 10,
      uin: targetCredential.uin,
      key: targetCredential.key,
      pass_ticket: targetCredential.pass_ticket,
      wap_sid2: targetCredential.wap_sid2,
      appmsg_token: targetCredential.appmsg_token,
      cookie: targetCredential.cookie,
      timestamp: targetCredential.timestamp,
    },
  });
  if (resp.ret === 0) {
    return normalizeProfileGetMsgResponse(resp).articles;
  } else {
    throw new Error(`${resp.ret}:${resp.errmsg}`);
  }
}

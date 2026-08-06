import type { AppMsgEx } from '~/types/types';

export const PUBLIC_ARTICLE_LIST_SOURCE = 'sogou_public_index' as const;
export const PUBLIC_ARTICLE_SEARCH_PAGE_LIMIT = 10;
export const PUBLIC_ARTICLE_CANDIDATE_LIMIT = 300;

export interface PublicArticleDiscoveryProfile {
  queries: string[];
  searchPages: number;
}

export interface PublicArticleDiscoveryArticle {
  accountName: string;
  aid: string;
  author: string;
  biz: string;
  canonicalLink: string;
  cover: string;
  digest: string;
  evidenceUrl: string;
  idx: number;
  link: string;
  mid: number;
  publishTime: number;
  source: typeof PUBLIC_ARTICLE_LIST_SOURCE;
  title: string;
}

export interface PublicArticleDiscoveryResponse {
  base_resp: { ret: number; err_msg?: string };
  source: typeof PUBLIC_ARTICLE_LIST_SOURCE;
  coverage: 'partial';
  articles: PublicArticleDiscoveryArticle[];
  queries: string[];
  warnings: string[];
  metrics: {
    candidates: number;
    emptyResultRetries: number;
    exactAccountCandidates: number;
    rejectedCandidates: number;
    searchPageRequests: number;
    searchPages: number;
    verifiedArticles: number;
  };
}

export function extractWechatAssignedString(html: string, variableName: string): string {
  const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = html.match(new RegExp(`var\\s+${escapedName}\\s*=\\s*([^;]+);`))?.[1] || '';
  const quoted = Array.from(expression.matchAll(/["']([^"']*)["']/g), match => match[1]).find(Boolean);
  return quoted || expression.match(/\b(\d+)\b/)?.[1] || '';
}

function uniqueNonempty(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean)));
}

export function getPublicArticleDiscoveryProfile(
  accountName: string,
  _expectedBiz: string,
  _year = new Date().getFullYear(),
  _startYear = _year
): PublicArticleDiscoveryProfile {
  const normalizedName = accountName.replace(/\s+/g, ' ').trim();
  return {
    queries: uniqueNonempty([normalizedName]),
    searchPages: PUBLIC_ARTICLE_SEARCH_PAGE_LIMIT,
  };
}

export function normalizePublicDiscoveryNotBefore(value: unknown, nowEpoch = Math.floor(Date.now() / 1000)): number {
  let parsed = Number(value);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    parsed = Math.floor(Date.parse(`${value.trim()}T00:00:00+08:00`) / 1000);
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > nowEpoch + 86_400) {
    return Math.max(0, nowEpoch - 366 * 86_400);
  }
  return parsed;
}

export function publicDiscoveryArticleToAppMsgEx(article: PublicArticleDiscoveryArticle): AppMsgEx {
  return {
    aid: article.aid,
    album_id: '',
    appmsg_album_infos: [],
    appmsgid: article.mid,
    author_name: article.author,
    ban_flag: 0,
    checking: 0,
    canonical_link: article.canonicalLink,
    copyright_stat: 0,
    copyright_type: 0,
    cover: article.cover,
    create_time: article.publishTime,
    digest: article.digest,
    has_red_packet_cover: 0,
    is_deleted: false,
    is_pay_subscribe: 0,
    item_show_type: 0,
    itemidx: article.idx,
    link: article.link,
    media_duration: '',
    mediaapi_publish_status: 0,
    pic_cdn_url_1_1: '',
    pic_cdn_url_3_4: '',
    pic_cdn_url_16_9: '',
    pic_cdn_url_235_1: '',
    title: article.title,
    update_time: article.publishTime,
    wecoin_count: 0,
  };
}

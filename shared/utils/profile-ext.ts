import { urlIsValidMpArticle } from '#shared/utils';
import type {
  ParsedProfileGetMsg,
  ProfileArticle,
  ProfileArticlePage,
  ProfileGeneralMsgList,
  ProfileGetMsgAppMsgItem,
  ProfileGetMsgResponse,
} from '~/types/profile_getmsg';
import type { AppMsgEx } from '~/types/types';

function asFiniteInteger(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function decodeUrlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/gi, '&')
    .replace(/&#x0*26;/gi, '&');
}

export function normalizeProfileArticleUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(decodeUrlEntities(value.trim()), 'https://mp.weixin.qq.com/');
    url.protocol = 'https:';
    url.hash = '';
    if (url.username || url.password || !urlIsValidMpArticle(url.toString())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseGeneralMessageList(value: ProfileGetMsgResponse['general_msg_list']): ProfileGeneralMsgList {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.list)) {
    throw new Error('profile_ext general_msg_list is invalid');
  }
  return parsed;
}

function articleIndex(link: string, fallback: number): number {
  const index = asFiniteInteger(new URL(link).searchParams.get('idx'), fallback);
  return index > 0 ? index : fallback;
}

function articleId(link: string, messageId: number, index: number): string {
  const url = new URL(link);
  const mid = url.searchParams.get('mid') || url.searchParams.get('appmsgid');
  return mid ? `${mid}_${index}` : `${messageId}_${index}`;
}

function normalizeItem(
  item: ProfileGetMsgAppMsgItem,
  message: ParsedProfileGetMsg['comm_msg_info'],
  fallbackIndex: number
): ProfileArticle | null {
  if (!item || asFiniteInteger(item.del_flag) === 4) return null;
  const link = normalizeProfileArticleUrl(item.content_url);
  if (!link) return null;

  const itemidx = articleIndex(link, fallbackIndex);
  const createTimeRaw = asFiniteInteger(message?.datetime);
  const createTime = createTimeRaw > 10_000_000_000 ? Math.trunc(createTimeRaw / 1000) : createTimeRaw;
  return {
    aid: articleId(link, asFiniteInteger(message?.id), itemidx),
    author_name: typeof item.author === 'string' ? item.author.trim() : '',
    cover: typeof item.cover === 'string' ? item.cover : '',
    create_time: createTime,
    digest: typeof item.digest === 'string' ? item.digest.trim() : '',
    is_deleted: false,
    item_show_type: asFiniteInteger(item.item_show_type),
    itemidx,
    link,
    title: typeof item.title === 'string' ? item.title.trim() : '',
    update_time: createTime,
  };
}

export function normalizeProfileGetMsgResponse(response: ProfileGetMsgResponse, currentOffset = 0): ProfileArticlePage {
  const ret = asFiniteInteger(response?.ret, -1);
  const errMsg = typeof response?.errmsg === 'string' ? response.errmsg : '';
  if (ret !== 0) {
    return {
      source: 'profile_ext',
      base_resp: { ret, err_msg: errMsg },
      articles: [],
      can_continue: false,
      next_offset: 0,
      message_count: 0,
    };
  }

  const canContinue = asFiniteInteger(response.can_msg_continue) === 1;
  const nextOffset = asFiniteInteger(response.next_offset);
  const normalizedCurrentOffset = Math.max(0, asFiniteInteger(currentOffset));
  if (canContinue && (nextOffset <= normalizedCurrentOffset || nextOffset > 1_000_000)) {
    return {
      source: 'profile_ext',
      base_resp: { ret: -3, err_msg: 'profile_ext pagination did not advance safely' },
      articles: [],
      can_continue: false,
      next_offset: normalizedCurrentOffset,
      message_count: 0,
    };
  }

  const generalMessageList = parseGeneralMessageList(response.general_msg_list);
  const articles = new Map<string, ProfileArticle>();
  for (const entry of generalMessageList.list) {
    const primary = normalizeItem(entry.app_msg_ext_info, entry.comm_msg_info, 1);
    if (primary) articles.set(primary.link, primary);

    const children = Array.isArray(entry.app_msg_ext_info?.multi_app_msg_item_list)
      ? entry.app_msg_ext_info.multi_app_msg_item_list
      : [];
    children.forEach((item, index) => {
      const article = normalizeItem(item, entry.comm_msg_info, index + 2);
      if (article) articles.set(article.link, article);
    });
  }

  return {
    source: 'profile_ext',
    base_resp: { ret: 0, err_msg: errMsg },
    articles: Array.from(articles.values()),
    can_continue: canContinue,
    next_offset: nextOffset,
    message_count: asFiniteInteger(response.msg_count, generalMessageList.list.length),
  };
}

export function profileArticleToAppMsgEx(article: ProfileArticle): AppMsgEx {
  const rawAppMsgId = Number.parseInt(article.aid.split('_')[0] || '', 10);
  const appmsgid = Number.isSafeInteger(rawAppMsgId) ? rawAppMsgId : 0;

  return {
    aid: article.aid,
    album_id: '',
    appmsg_album_infos: [],
    appmsgid,
    author_name: article.author_name,
    ban_flag: 0,
    checking: 0,
    copyright_stat: 0,
    copyright_type: 0,
    cover: article.cover,
    create_time: article.create_time,
    digest: article.digest,
    has_red_packet_cover: 0,
    is_deleted: article.is_deleted,
    is_pay_subscribe: 0,
    item_show_type: article.item_show_type,
    itemidx: article.itemidx,
    link: article.link,
    media_duration: '',
    mediaapi_publish_status: 0,
    pic_cdn_url_1_1: '',
    pic_cdn_url_3_4: '',
    pic_cdn_url_16_9: '',
    pic_cdn_url_235_1: '',
    title: article.title,
    update_time: article.update_time,
    wecoin_count: 0,
  };
}

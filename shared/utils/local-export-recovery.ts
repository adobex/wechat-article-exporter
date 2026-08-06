import type { AppMsgEx } from '~/types/types';

export interface LocalExportManifestEntry {
  title: string;
  accountName: string;
  publishDate: string;
  url: string;
  filepath: string;
  articleDir: string;
  relativePath: string;
  mtimeMs: number;
}

function stableNumber(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash || 1;
}

function publishTimestamp(entry: LocalExportManifestEntry): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.publishDate)) return null;
  const parsed = Date.parse(`${entry.publishDate}T00:00:00+08:00`);
  if (!Number.isFinite(parsed)) return null;
  const normalized = new Date(parsed + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return normalized === entry.publishDate ? Math.floor(parsed / 1000) : null;
}

function isPositiveIdentityNumber(value: string | null): value is string {
  const numeric = Number(value);
  return Boolean(value && /^\d+$/.test(value) && Number.isSafeInteger(numeric) && numeric > 0);
}

export function normalizeLocalExportUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.port || url.username || url.password) {
      return null;
    }
    url.hash = '';
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedAccountName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function isLocalExportCandidateForAccount(
  entry: LocalExportManifestEntry,
  expectedAccountName: string,
  expectedFakeid: string
): boolean {
  const exactName = normalizedAccountName(entry.accountName) === normalizedAccountName(expectedAccountName);
  const link = normalizeLocalExportUrl(entry.url);
  if (!link) return exactName;
  const biz = new URL(link).searchParams.get('__biz');
  return biz === expectedFakeid || exactName;
}

export function buildLocalExportArticle(
  entry: LocalExportManifestEntry,
  expectedFakeid: string,
  options: { requireCanonicalIdentity?: boolean } = {}
): AppMsgEx | null {
  const link = normalizeLocalExportUrl(entry.url);
  if (!link) return null;

  const url = new URL(link);
  const urlBiz = url.searchParams.get('__biz');
  if (urlBiz && urlBiz !== expectedFakeid) return null;

  const mid = url.searchParams.get('mid') || url.searchParams.get('appmsgid');
  const rawItemidx = url.searchParams.get('idx') || url.searchParams.get('itemidx');
  if (
    options.requireCanonicalIdentity &&
    (!urlBiz || !isPositiveIdentityNumber(mid) || !isPositiveIdentityNumber(rawItemidx))
  ) {
    return null;
  }
  const itemidx = Math.max(1, Number(rawItemidx) || 1);
  const stable = stableNumber(link);
  const appmsgid = isPositiveIdentityNumber(mid) ? Number(mid) : stable;
  const aid = isPositiveIdentityNumber(mid) ? `${mid}_${itemidx}` : `local-${stable}_${itemidx}`;
  const parsedTimestamp = publishTimestamp(entry);
  if (options.requireCanonicalIdentity && parsedTimestamp === null) return null;
  const timestamp = parsedTimestamp ?? Math.floor(entry.mtimeMs / 1000);

  return {
    aid,
    album_id: '',
    appmsg_album_infos: [],
    appmsgid,
    author_name: entry.accountName,
    ban_flag: 0,
    checking: 0,
    canonical_link: link,
    copyright_stat: 0,
    copyright_type: 0,
    cover: '',
    create_time: timestamp,
    digest: '',
    has_red_packet_cover: 0,
    is_deleted: false,
    is_pay_subscribe: 0,
    wecoin_count: 0,
    item_show_type: 0,
    itemidx,
    link,
    media_duration: '0:00',
    mediaapi_publish_status: 0,
    pic_cdn_url_1_1: '',
    pic_cdn_url_3_4: '',
    pic_cdn_url_16_9: '',
    pic_cdn_url_235_1: '',
    title: entry.title,
    update_time: timestamp,
  };
}

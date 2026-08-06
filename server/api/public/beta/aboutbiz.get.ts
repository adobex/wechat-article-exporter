import fs from 'node:fs';
import * as cheerio from 'cheerio';
import {
  extractWechatScriptAssignment,
  extractWechatScriptCallArguments,
  type SafeScriptValue,
} from '#shared/utils/html';
import { isDev } from '~/config';

interface AboutBizQuery {
  fakeid: string;
  key: string;
}

const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) MicroMessenger/8.0.64(0x18004034) Language/zh_CN';

export default defineEventHandler(async event => {
  if (!isDev) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' });
  }

  const { fakeid, key } = getQuery<AboutBizQuery>(event);
  if (typeof fakeid !== 'string' || !fakeid) {
    throw createError({ statusCode: 400, statusMessage: 'fakeid is required' });
  }

  const query: Record<string, string> = {
    __biz: fakeid,
    wx_header: process.env.NUXT_WECHAT_ABOUT_BIZ_WX_HEADER || '',
  };

  // const rawHtml = fs.readFileSync('samples/aboutbiz/biz-Mzg3OTYzMDkzMg==.html', 'utf8');
  const response = await fetch(`https://mp.weixin.qq.com/mp/aboutbiz?${new URLSearchParams(query).toString()}`, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'x-wechat-uin': process.env.NUXT_WECHAT_ABOUT_BIZ_UIN || '',
      'x-wechat-key': (typeof key === 'string' && key) || process.env.NUXT_WECHAT_ABOUT_BIZ_KEY || '',
    },
  });
  if (!response.ok) {
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch account information' });
  }
  const rawHtml = await response.text();

  // 写入文件方便调试
  if (isDev) {
    const safeFilename = encodeURIComponent(fakeid).replaceAll('%', '_');
    fs.writeFileSync(`samples/aboutbiz/biz-${safeFilename}.html`, rawHtml);
  }

  const result = extractInfo(rawHtml);
  if (Object.keys(result).length > 0) {
    return {
      base_resp: {
        ret: 0,
      },
      data: result,
    };
  } else {
    return {
      base_resp: {
        ret: -1,
        err_msg: '密钥已过期',
      },
    };
  }
});

type AboutBizRecord = Record<string, SafeScriptValue>;

interface AboutBizScriptData {
  cgiData: { auth_3rd_list: AboutBizRecord[] } | null;
  ip_wording: AboutBizRecord | null;
  auth_3rd_list: AboutBizRecord[];
}

function isRecord(value: SafeScriptValue | null): value is AboutBizRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeStringFields(value: SafeScriptValue, fields: readonly string[]): AboutBizRecord | null {
  if (!isRecord(value)) return null;
  const result: AboutBizRecord = {};
  for (const field of fields) {
    const fieldValue = value[field];
    if (typeof fieldValue === 'string' || typeof fieldValue === 'number') {
      result[field] = fieldValue;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function sanitizeAuthEntry(value: SafeScriptValue): AboutBizRecord | null {
  const result = sanitizeStringFields(value, ['principal', 'userName', 'appId', 'relativeURL']);
  if (!result || !isRecord(value)) return null;

  if (Array.isArray(value.category)) {
    result.category = value.category
      .map(category => sanitizeStringFields(category, ['id', 'name', 'desc']))
      .filter((category): category is AboutBizRecord => category !== null);
  }
  return result;
}

function sanitizeIpWording(value: SafeScriptValue | null): AboutBizRecord | null {
  if (value === null) return null;
  return sanitizeStringFields(value, ['countryName', 'countryId', 'provinceName', 'provinceId', 'cityName', 'cityId']);
}

export function extractAboutBizScriptData(rawHTML: string): AboutBizScriptData {
  const $ = cheerio.load(rawHTML);
  let cgiData: AboutBizRecord | null = null;
  let ipWording: AboutBizRecord | null = null;
  const pushedAuthEntries: AboutBizRecord[] = [];

  for (const script of $('script').toArray()) {
    const source = $(script).html() || '';
    if (!cgiData && source.includes('cgiData')) {
      const value = extractWechatScriptAssignment(source, 'var cgiData');
      if (isRecord(value) && Array.isArray(value.auth_3rd_list)) cgiData = value;
    }
    if (!ipWording && source.includes('window.ip_wording')) {
      ipWording = sanitizeIpWording(extractWechatScriptAssignment(source, 'window.ip_wording'));
    }
    if (source.includes('window.cgiData.auth_3rd_list.push')) {
      pushedAuthEntries.push(
        ...extractWechatScriptCallArguments(source, 'window.cgiData.auth_3rd_list.push')
          .map(sanitizeAuthEntry)
          .filter((entry): entry is AboutBizRecord => entry !== null)
      );
    }
  }

  const baseAuthEntries = Array.isArray(cgiData?.auth_3rd_list)
    ? cgiData.auth_3rd_list.map(sanitizeAuthEntry).filter((entry): entry is AboutBizRecord => entry !== null)
    : [];
  const authEntries = [...baseAuthEntries, ...pushedAuthEntries].filter((entry, index, entries) => {
    const key = `${entry.principal || ''}\0${entry.userName || ''}\0${entry.appId || ''}`;
    return (
      entries.findIndex(
        candidate => `${candidate.principal || ''}\0${candidate.userName || ''}\0${candidate.appId || ''}` === key
      ) === index
    );
  });

  return {
    cgiData: cgiData ? { auth_3rd_list: authEntries } : null,
    ip_wording: ipWording,
    auth_3rd_list: authEntries,
  };
}

export function extractInfo(rawHTML: string) {
  const $ = cheerio.load(rawHTML);
  let $itemInfo = $('.about-page > .item-info:first');

  const result: Record<string, unknown> = {};

  while ($itemInfo.length > 0) {
    const title = $itemInfo.find('.item-title').text().trim();

    if (['公众号简介', '服务号简介'].includes(title)) {
      result.intro = $itemInfo.find('.item-desc').text().trim();
    } else if (title === '基础信息') {
      // nop
    } else if (title === '微信号') {
      result.wechat = $itemInfo.find('.item-desc').text().trim();
    } else if (['账号类型', '认证类型', '主体类型'].includes(title)) {
      result.type = $itemInfo.find('.item-desc').text().trim();
    } else if (['账号主体', '认证主体'].includes(title)) {
      result.org = $itemInfo.find('.item-desc').text().trim();
    } else if (title === 'IP属地') {
      // ip属地需要从 js 中获取
    } else if (title === '授权第三方服务') {
      result.auth_3rd_list = $itemInfo
        .extract({
          name: ['.principal-data'],
        })
        .name.map(item => item.trim());
    } else if (title === '名称记录') {
      result.name_records = $itemInfo
        .extract({
          name: ['.js_item'],
        })
        .name.map(item => item.trim());
    } else if (title === '客服电话') {
      result.phone = $itemInfo.find('.item-desc').text().trim();
    }

    $itemInfo = $itemInfo.next('.item-info');
  }

  const scriptData = extractAboutBizScriptData(rawHTML);
  if (scriptData.ip_wording) result.ip_wording = scriptData.ip_wording;
  if (scriptData.auth_3rd_list.length > 0) result.auth_3rd_list = scriptData.auth_3rd_list;

  return result;
}

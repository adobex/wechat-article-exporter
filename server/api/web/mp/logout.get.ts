/**
 * 退出登录接口
 */

import { deleteCookie } from 'h3';
import { cookieStore } from '~/server/utils/CookieStore';
import { getAuthKeyFromRequest, proxyMpRequest } from '~/server/utils/proxy-request';

export default defineEventHandler(async event => {
  const authKey = getAuthKeyFromRequest(event);
  const accountCookie = authKey ? await cookieStore.getAccountCookie(authKey) : null;
  const token = accountCookie?.token;
  const upstreamCookie = accountCookie?.toString();

  const removed = authKey ? await cookieStore.removeCookie(authKey) : true;
  deleteCookie(event, 'auth-key', {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });

  if (!removed) {
    throw createError({ statusCode: 500, statusMessage: '本地会话清理失败' });
  }
  if (!authKey || !token || !upstreamCookie) {
    throw createError({ statusCode: 401, statusMessage: '未登录或登录已过期，本地会话已清理' });
  }

  let response: Response;
  try {
    response = await proxyMpRequest({
      event,
      method: 'GET',
      endpoint: 'https://mp.weixin.qq.com/cgi-bin/logout',
      cookie: upstreamCookie,
      query: {
        t: 'wxm-logout',
        token,
        lang: 'zh_CN',
      },
    });
  } catch {
    throw createError({ statusCode: 502, statusMessage: '微信登出请求失败，本地会话已清理' });
  }
  if (!response.ok) {
    throw createError({ statusCode: 502, statusMessage: '微信登出失败，本地会话已清理' });
  }
  return {
    statusCode: response.status,
    statusText: response.statusText,
  };
});

import dayjs from 'dayjs';
import { type H3Event, parseCookies } from 'h3';
import { v4 as uuidv4 } from 'uuid';
import { AUTH_KEY_LIVE_SECONDS, isDev, USER_AGENT } from '~/config';
import type { RequestOptions } from '~/server/types';
import { cookieStore, getCookieFromStore } from '~/server/utils/CookieStore';
import { logRequest, logResponse } from '~/server/utils/logger';

function createUpstreamAbortScope(event: H3Event, timeoutMs: number | undefined) {
  const controller = new AbortController();
  const response = event.node?.res;
  const abortOnDisconnect = () => {
    if (!response?.writableEnded)
      controller.abort(new Error('Client disconnected before the upstream request completed'));
  };
  if (event.node?.req?.aborted || response?.destroyed || response?.writableEnded) {
    controller.abort(new Error('Client disconnected before the upstream request started'));
  } else {
    response?.once('close', abortOnDisconnect);
  }

  const timeout =
    Number.isFinite(timeoutMs) && Number(timeoutMs) > 0
      ? setTimeout(
          () => controller.abort(new Error(`Upstream request timed out after ${Number(timeoutMs)}ms`)),
          Number(timeoutMs)
        )
      : null;

  return {
    signal: controller.signal,
    cleanup() {
      if (timeout) clearTimeout(timeout);
      response?.off('close', abortOnDisconnect);
    },
  };
}

/**
 * 代理微信公众号请求
 * @description 备注：只有登录请求(`action=login`)中的 `set-cookie` 才会被写入到 CookieStore 中
 * @param options 请求参数
 */
export async function proxyMpRequest(options: RequestOptions) {
  const shouldLogRequest = isDev && process.env.NUXT_DEBUG_MP_REQUEST === 'true';
  const abortScope = createUpstreamAbortScope(options.event, options.timeoutMs);

  try {
    const headers = new Headers({
      Referer: 'https://mp.weixin.qq.com/',
      Origin: 'https://mp.weixin.qq.com',
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'identity', // 禁用压缩，避免出现response.clone() bug
    });

    // 优先读取参数中的 cookie，若无则从 CookieStore 中读取
    const cookie: string | null = options.cookie || (await getCookieFromStore(options.event));
    if (cookie) {
      headers.set('Cookie', cookie);
    }

    const requestInit: RequestInit = {
      method: options.method,
      headers: headers,
      redirect: options.redirect || 'follow',
    };
    requestInit.signal = abortScope.signal;

    // 处理参数
    if (options.query) {
      options.endpoint += `?${new URLSearchParams(options.query as Record<string, string>).toString()}`;
    }
    if (options.method === 'POST' && options.body) {
      requestInit.body = new URLSearchParams(options.body as Record<string, string>).toString();
    }

    // 构造请求
    const request = new Request(options.endpoint, requestInit);

    // 记录请求报文
    const requestId = uuidv4().replace(/-/g, '');
    if (shouldLogRequest) {
      await logRequest(requestId, request.clone());
    }

    // 转发请求
    if (abortScope.signal.aborted) throw abortScope.signal.reason;
    const mpResponse = await fetch(request);

    // 记录响应报文
    if (shouldLogRequest) {
      await logResponse(requestId, mpResponse.clone());
    }

    let setCookies: string[] = [];

    // 处理登录请求的 uuid cookie
    if (options.action === 'start_login') {
      // 提取出 uuid 这个 cookie，并透传给客户端
      setCookies = mpResponse.headers.getSetCookie().filter(cookie => cookie.startsWith('uuid='));
    }

    // 处理登录成功请求的 cookie
    // 只有登录请求才会将 Cookie 数据写入 CookieStore
    // 返回给客户端的一个 auth-key 的 cookie
    else if (options.action === 'login') {
      // 提取出 token 和 cookies
      try {
        const authKey = crypto.randomUUID().replace(/-/g, '');

        const body = await mpResponse.clone().json();
        const redirectUrl = body?.redirect_url;
        if (!redirectUrl || typeof redirectUrl !== 'string') {
          throw new Error('登录响应中未找到 redirect_url');
        }

        const token = new URL(`http://localhost${redirectUrl}`).searchParams.get('token');
        if (!token) {
          throw new Error('redirect_url 中未找到 token 参数');
        }

        const authKeyExpiresAt = dayjs().add(AUTH_KEY_LIVE_SECONDS, 'seconds').toDate();
        const success = await cookieStore.setCookie(authKey, token, mpResponse.headers.getSetCookie());
        if (!success) {
          throw new Error('cookie 写入 KV 存储失败');
        }

        setCookies = [
          `auth-key=${authKey}; Path=/; Expires=${authKeyExpiresAt.toUTCString()}; Secure; HttpOnly; SameSite=Lax`,

          // 登录成功后，删除浏览器的 uuid cookie
          `uuid=EXPIRED; Path=/; Expires=${dayjs().subtract(1, 'days').toDate().toUTCString()}; Secure; HttpOnly; SameSite=Lax`,
        ];
      } catch {
        console.error('action(login) failed');

        // 登录失败时返回错误响应，而不是静默继续
        return new Response(JSON.stringify({ base_resp: { ret: -1, err_msg: '登录处理失败' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // 处理切换公众号的请求
    else if (options.action === 'switch_account') {
      const authKey = getAuthKeyFromRequest(options.event);
      if (authKey) {
        setCookies = ['switch_account=1'];
      }
    }

    // 这里是否需要执行？
    // 更新 CookieStore 中的 cookie
    else {
      // updateCookies(options.event, mpResponse.headers.getSetCookie());
    }

    // 构造返回给客户端的响应
    const responseHeaders = new Headers(mpResponse.headers);
    responseHeaders.delete('set-cookie');
    setCookies.forEach(setCookie => {
      responseHeaders.append('set-cookie', setCookie);
    });

    const finalResponse = new Response(mpResponse.body, {
      status: mpResponse.status,
      statusText: mpResponse.statusText,
      headers: responseHeaders,
    });

    if (!options.parseJson) {
      return finalResponse;
    } else {
      return finalResponse.json();
    }
  } finally {
    abortScope.cleanup();
  }
}

export function getAuthKeyFromRequest(event: H3Event): string {
  let authKey = getRequestHeader(event, 'X-Auth-Key');
  if (!authKey) {
    const cookies = parseCookies(event);
    authKey = cookies['auth-key'];
  }

  return authKey;
}

// function updateCookies(event: H3Event, cookies: string[]): void {
//   const authKey = getAuthKeyFromRequest(event);
//   if (authKey) {
//     cookieStore.updateCookie(authKey, cookies);
//   }
// }

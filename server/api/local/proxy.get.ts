const ALLOWED_HOSTS = new Set(['mp.weixin.qq.com', 'mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'res.wx.qq.com', 'wx.qlogo.cn']);
const ALLOWED_EXTRA_HEADERS = new Set(['accept', 'accept-language', 'cookie', 'referer', 'user-agent']);

function sanitizeExtraHeaders(headers: Record<string, unknown>): Record<string, string> {
  const safeHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (!ALLOWED_EXTRA_HEADERS.has(normalizedKey) || typeof value !== 'string') continue;
    safeHeaders[key] = value;
  }
  return safeHeaders;
}

export default defineEventHandler(async event => {
  const query = getQuery<{ url: string; headers?: string }>(event);

  if (!query.url) {
    throw createError({ statusCode: 400, statusMessage: 'url is required' });
  }

  const targetUrl = decodeURIComponent(query.url);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl.startsWith('//') ? `https:${targetUrl}` : targetUrl);
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw createError({ statusCode: 400, statusMessage: 'Only HTTP(S) URLs are allowed' });
  }

  if (!ALLOWED_HOSTS.has(parsedUrl.hostname)) {
    throw createError({ statusCode: 403, statusMessage: `Host ${parsedUrl.hostname} is not allowed` });
  }

  let extraHeaders: Record<string, string> = {};
  if (query.headers) {
    try {
      extraHeaders = sanitizeExtraHeaders(JSON.parse(decodeURIComponent(query.headers)));
    } catch {}
  }

  const response = await fetch(parsedUrl.toString(), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Referer: 'https://mp.weixin.qq.com/',
      ...extraHeaders,
    },
  });

  const blob = await response.blob();

  return new Response(blob, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'text/html; charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

const LOOPBACK_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i;
const LOCAL_PROXY_PROOF_HEADER = 'x-wechat2md-loopback-proof';

export function isLoopbackHost(host: string): boolean {
  const match = LOOPBACK_HOST_PATTERN.exec(host);
  if (!match) return false;
  if (!match[2]) return true;
  const port = Number(match[2]);
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isValidLocalApiProxyProof(value: string | undefined, expected: string | undefined): boolean {
  if (!value || !expected || value.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < value.length; index++) {
    difference |= value.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export function isSameLoopbackOrigin(origin: string, protocol: 'http' | 'https', host: string): boolean {
  if (!isLoopbackHost(host) || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    return parsed.origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

export default defineEventHandler(event => {
  const path = getRequestURL(event).pathname;
  if (path !== '/api/local' && !path.startsWith('/api/local/')) return;

  if (process.env.NODE_ENV === 'production') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Local API is disabled in production',
    });
  }

  const host = getRequestHost(event, { xForwardedHost: false });
  const remoteAddress = getRequestIP(event, { xForwardedFor: false });
  const proof = getRequestHeader(event, LOCAL_PROXY_PROOF_HEADER);
  const expectedProof = useRuntimeConfig(event).localApiProxySecret;
  const hasLoopbackProof = isValidLocalApiProxyProof(proof, expectedProof);
  if (!isLoopbackHost(host) || (!isLoopbackAddress(remoteAddress) && !hasLoopbackProof)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Local API is only accessible from localhost',
    });
  }

  const origin = getRequestHeader(event, 'origin');
  const protocol = getRequestProtocol(event, { xForwardedProto: false });
  if (origin && !isSameLoopbackOrigin(origin, protocol, host)) {
    throw createError({ statusCode: 403, statusMessage: 'Local API origin mismatch' });
  }

  const fetchSite = getRequestHeader(event, 'sec-fetch-site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    throw createError({ statusCode: 403, statusMessage: 'Cross-site local API request denied' });
  }
});

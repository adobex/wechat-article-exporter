import type { H3Event } from 'h3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_KEY_LIVE_DAYS, AUTH_KEY_LIVE_SECONDS } from '../config';

const FIXED_NOW = new Date('2026-03-01T13:30:00.000Z');
const DAY_IN_SECONDS = 24 * 60 * 60;
const EXPECTED_EXPIRATION = FIXED_NOW.getTime() + AUTH_KEY_LIVE_SECONDS * 1000;
const ORIGINAL_TIMEZONE = process.env.TZ;

const mocks = vi.hoisted(() => ({
  request: vi.fn(async () => {
    vi.advanceTimersByTime(30_000);
    return {
      nick_name: 'Contract Test Account',
      head_img: 'https://example.test/avatar.png',
    };
  }),
}));

vi.mock('#shared/utils/request', () => ({
  request: mocks.request,
}));

vi.mock('~/server/utils/logger', () => ({
  logRequest: vi.fn(),
  logResponse: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: () => '00000000-0000-4000-8000-000000000000',
}));

type SetMpCookie = typeof import('../server/kv/cookie').setMpCookie;
type ProxyMpRequest = typeof import('../server/utils/proxy-request').proxyMpRequest;
type BizloginHandler = (event: H3Event) => Promise<Response>;

let setMpCookie: SetMpCookie;
let proxyMpRequest: ProxyMpRequest;
let bizloginHandler: BizloginHandler;
let kvSet: ReturnType<typeof vi.fn>;

function createEvent(): H3Event {
  return {
    node: {
      req: {
        headers: {
          cookie: 'uuid=contract-login',
        },
      },
    },
  } as unknown as H3Event;
}

function createClosedEvent(): H3Event {
  return {
    node: {
      req: { headers: {}, aborted: true },
      res: { destroyed: true, writableEnded: false, once: vi.fn(), off: vi.fn() },
    },
  } as unknown as H3Event;
}

function createUpstreamLoginResponse(): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('set-cookie', 'sessionid=upstream-session; Path=/; HttpOnly');
  headers.append('set-cookie', 'data_ticket=upstream-ticket; Path=/; HttpOnly');

  return new Response(
    JSON.stringify({
      redirect_url: '/cgi-bin/home?t=home/index&token=upstream-token',
    }),
    { status: 200, headers }
  );
}

function getSetCookie(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  expect(cookie).toBeDefined();
  return cookie as string;
}

function getCookieExpiration(cookie: string): number {
  const expires = /;\s*Expires=([^;]+)/i.exec(cookie)?.[1];
  expect(expires).toBeDefined();
  return Date.parse(expires as string);
}

function getCookieValue(cookie: string): string {
  const value = /^[^=]+=([^;]+)/.exec(cookie)?.[1];
  expect(value).toBeDefined();
  return value as string;
}

beforeAll(async () => {
  process.env.TZ = 'America/New_York';
  vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);

  ({ setMpCookie } = await import('../server/kv/cookie'));
  ({ proxyMpRequest } = await import('../server/utils/proxy-request'));
  ({ default: bizloginHandler } = (await import('../server/api/web/login/bizlogin.post')) as {
    default: BizloginHandler;
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.clearAllMocks();

  kvSet = vi.fn(async () => undefined);
  vi.stubGlobal('useStorage', () => ({
    set: kvSet,
    get: vi.fn(async () => null),
    removeItem: vi.fn(async () => undefined),
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => createUpstreamLoginResponse())
  );
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_TIMEZONE === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TIMEZONE;
  }
});

describe('14-day auth-key lifetime contract', () => {
  it('keeps the canonical lifetime at 14 days', () => {
    expect(AUTH_KEY_LIVE_DAYS).toBe(14);
    expect(AUTH_KEY_LIVE_SECONDS).toBe(AUTH_KEY_LIVE_DAYS * DAY_IN_SECONDS);
  });

  it('writes the canonical lifetime to KV as expirationTtl seconds', async () => {
    const value = {
      token: 'upstream-token',
      cookies: [{ name: 'sessionid', value: 'upstream-session' }],
    };

    await expect(setMpCookie('contract-auth-key', value)).resolves.toBe(true);
    expect(kvSet).toHaveBeenCalledWith('cookie:contract-auth-key', value, {
      expirationTtl: AUTH_KEY_LIVE_SECONDS,
    });
  });

  it('sets browser auth-key Expires from the canonical lifetime', async () => {
    const response = await proxyMpRequest({
      event: createEvent(),
      method: 'POST',
      endpoint: 'https://mp.weixin.qq.com/cgi-bin/bizlogin',
      action: 'login',
      cookie: 'uuid=contract-login',
    });

    expect(response).toBeInstanceOf(Response);
    const authCookie = getSetCookie(response as Response, 'auth-key');
    expect(getCookieExpiration(authCookie)).toBe(EXPECTED_EXPIRATION);
    expect(kvSet).toHaveBeenCalledWith(
      `cookie:${getCookieValue(authCookie)}`,
      {
        token: 'upstream-token',
        cookies: expect.arrayContaining([
          expect.objectContaining({ name: 'sessionid', value: 'upstream-session' }),
          expect.objectContaining({ name: 'data_ticket', value: 'upstream-ticket' }),
        ]),
      },
      {
        expirationTtl: AUTH_KEY_LIVE_SECONDS,
      }
    );
  });

  it('returns login response expires from the same canonical lifetime', async () => {
    const response = await bizloginHandler(createEvent());
    const body = await response.json();

    expect(body).toMatchObject({
      nickname: 'Contract Test Account',
      avatar: 'https://example.test/avatar.png',
    });
    const authCookie = getSetCookie(response, 'auth-key');
    expect(Date.parse(body.expires)).toBe(EXPECTED_EXPIRATION);
    expect(getCookieExpiration(authCookie)).toBe(EXPECTED_EXPIRATION);
    expect(kvSet).toHaveBeenCalledWith(`cookie:${getCookieValue(authCookie)}`, expect.any(Object), {
      expirationTtl: AUTH_KEY_LIVE_SECONDS,
    });
  });
});

describe('upstream request lifetime contract', () => {
  it('does not start an upstream request after the automation client has already disconnected', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      proxyMpRequest({
        event: createClosedEvent(),
        method: 'GET',
        endpoint: 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish',
        cookie: 'sessionid=contract',
        parseJson: true,
        timeoutMs: 25_000,
      })
    ).rejects.toThrow('Client disconnected before the upstream request started');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts the upstream request before the automation client timeout', async () => {
    let upstreamRequest: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (request: Request) =>
          new Promise<Response>((_resolve, reject) => {
            upstreamRequest = request;
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          })
      )
    );

    const request = proxyMpRequest({
      event: createEvent(),
      method: 'GET',
      endpoint: 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish',
      cookie: 'sessionid=contract',
      parseJson: true,
      timeoutMs: 25_000,
    });
    const rejection = expect(request).rejects.toThrow('Upstream request timed out after 25000ms');

    expect(upstreamRequest?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(25_000);
    await rejection;
    expect(upstreamRequest?.signal.aborted).toBe(true);
  });
});

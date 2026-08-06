import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const kvState = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  removeSucceeds: true,
}));

vi.mock('~/server/kv/cookie', () => ({
  getMpCookie: async (key: string) => kvState.values.get(key) || null,
  setMpCookie: async (key: string, value: unknown) => {
    kvState.values.set(key, value);
    return true;
  },
  removeMpCookie: async (key: string) => {
    if (!kvState.removeSucceeds) return false;
    kvState.values.delete(key);
    return true;
  },
}));

type CookieStoreModule = typeof import('../server/utils/CookieStore');
let cookieStoreModule: CookieStoreModule;

beforeAll(async () => {
  cookieStoreModule = await import('../server/utils/CookieStore');
});

describe('session deletion', () => {
  it('removes both memory and KV state without exposing session data', async () => {
    kvState.removeSucceeds = true;
    const store = new cookieStoreModule.CookieStore();
    await store.setCookie('auth-secret', 'token-secret', ['sessionid=cookie-secret; Path=/; HttpOnly']);
    expect(store.getDebugSummary()).toEqual({ activeSessionCount: 1, pendingRemovalCount: 0 });

    await expect(store.removeCookie('auth-secret')).resolves.toBe(true);
    expect(store.getDebugSummary()).toEqual({ activeSessionCount: 0, pendingRemovalCount: 0 });
    expect(JSON.stringify(store.getDebugSummary())).not.toMatch(/auth-secret|token-secret|cookie-secret/);
    expect(kvState.values.has('auth-secret')).toBe(false);
  });

  it('restores memory visibility when KV deletion fails', async () => {
    const store = new cookieStoreModule.CookieStore();
    await store.setCookie('rollback-auth', 'rollback-token', ['sessionid=rollback-cookie; Path=/']);
    kvState.removeSucceeds = false;
    await expect(store.removeCookie('rollback-auth')).resolves.toBe(false);
    await expect(store.getToken('rollback-auth')).resolves.toBe('rollback-token');
    kvState.removeSucceeds = true;
  });
});

describe('credential download and debug regressions', () => {
  it('keeps credential traffic off public proxies and encodes proxy parameters', () => {
    const base = readFileSync(resolve('utils/download/BaseDownloader.ts'), 'utf8');
    const downloader = readFileSync(resolve('utils/download/Downloader.ts'), 'utf8');
    expect(base).toContain("from '~/utils/concurrency'");
    expect(base).toContain('getBestConcurrencyCount(');
    expect(base).toContain('credentialProxyManager');
    expect(base).toContain('PUBLIC_PROXY_ORIGINS');
    expect(base).toContain("query.set('authorization', authorization)");
    expect(base).toContain("referrerPolicy: 'no-referrer'");
    expect(downloader).toContain('this.assertCredentialProxy(proxy)');
    expect(downloader).not.toMatch(/key=\$\{|pass_ticket=\$\{|authorization=\$\{/);
  });

  it('preserves existing counts and fails metadata extraction before completion', () => {
    const downloader = readFileSync(resolve('utils/download/Downloader.ts'), 'utf8');
    expect(downloader).toContain('parsedValue ?? existing?.[targetField] ?? 0');
    expect(downloader).toContain("throw new Error('提取 window.cgiDataNew 对象失败')");
    expect(downloader.indexOf('await this.processHtmlMetadata(blob, url)')).toBeLessThan(
      downloader.indexOf('this.completed.add(url)', downloader.indexOf('private async downloadMetadataTask'))
    );
  });

  it('strictly gates request logging and never returns session serialization', () => {
    const proxy = readFileSync(resolve('server/utils/proxy-request.ts'), 'utf8');
    const debug = readFileSync(resolve('server/api/_debug.get.ts'), 'utf8');
    const logout = readFileSync(resolve('server/api/web/mp/logout.get.ts'), 'utf8');
    expect(proxy).toContain("process.env.NUXT_DEBUG_MP_REQUEST === 'true'");
    expect(proxy).not.toMatch(/console\.log\(['"]token/);
    expect(debug).toContain('getDebugSummary()');
    expect(debug).not.toContain('toJSON()');
    expect(logout).toContain('await cookieStore.removeCookie(authKey)');
    expect(logout).toContain("deleteCookie(event, 'auth-key'");
  });
});

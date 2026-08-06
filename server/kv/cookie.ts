import { AUTH_KEY_LIVE_SECONDS } from '~/config';
import type { CookieEntity } from '~/server/utils/CookieStore';

export type CookieKVKey = string;

export interface CookieKVValue {
  token: string;
  cookies: CookieEntity[];
}

export async function setMpCookie(key: CookieKVKey, data: CookieKVValue): Promise<boolean> {
  const kv = useStorage('kv');
  try {
    await kv.set<CookieKVValue>(`cookie:${key}`, data, {
      // https://developers.cloudflare.com/kv/api/write-key-value-pairs/#expiring-keys
      expirationTtl: AUTH_KEY_LIVE_SECONDS,
    });
    return true;
  } catch {
    console.error('kv.set call failed');
    return false;
  }
}

export async function getMpCookie(key: CookieKVKey): Promise<CookieKVValue | null> {
  const kv = useStorage('kv');
  return await kv.get<CookieKVValue>(`cookie:${key}`);
}

export async function removeMpCookie(key: CookieKVKey): Promise<boolean> {
  const kv = useStorage('kv');
  try {
    await kv.removeItem(`cookie:${key}`);
    return true;
  } catch {
    console.error('kv.removeItem call failed');
    return false;
  }
}

import type { H3Event } from 'h3';
import type { ProfileCredential } from '~/server/utils/profile-credential-store';
import { proxyMpRequest } from '~/server/utils/proxy-request';
import type { ProfileGetMsgResponse } from '~/types/profile_getmsg';

export function clampProfilePageValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export async function requestProfileGetMsg(
  event: H3Event,
  credential: ProfileCredential,
  begin: unknown,
  size: unknown
): Promise<ProfileGetMsgResponse> {
  const offset = clampProfilePageValue(begin, 0, 0, 1_000_000);
  const count = clampProfilePageValue(size, 10, 1, 10);
  const params: Record<string, string | number> = {
    action: 'getmsg',
    __biz: credential.biz,
    offset,
    count,
    uin: credential.uin,
    key: credential.key,
    pass_ticket: credential.pass_ticket,
    appmsg_token: credential.appmsg_token,
    wxtoken: '',
    f: 'json',
    is_ok: '1',
    scene: '124',
    x5: '0',
  };
  const cookie = credential.cookie || `wap_sid2=${credential.wap_sid2}`;

  return proxyMpRequest({
    event,
    method: 'GET',
    endpoint: 'https://mp.weixin.qq.com/mp/profile_ext',
    query: params,
    cookie,
    parseJson: true,
    timeoutMs: 25_000,
  }) as Promise<ProfileGetMsgResponse>;
}

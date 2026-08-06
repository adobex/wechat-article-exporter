/** Use short-lived WeChat article-page Credentials to read an account history page. */

import { parseFreshProfileCredential } from '~/server/utils/profile-credential-store';
import { requestProfileGetMsg } from '~/server/utils/profile-ext';

export default defineEventHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  const credential = parseFreshProfileCredential({ ...body, biz: body?.id });
  if (!credential) {
    return { ret: -1, errmsg: '公众号 Credentials 缺失或已过期' };
  }

  try {
    return await requestProfileGetMsg(event, credential, body.begin, body.size);
  } catch {
    return { ret: -1, errmsg: '获取公众号历史文章失败，请重新抓取 Credentials 后重试' };
  }
});

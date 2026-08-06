import { normalizePublicDiscoveryNotBefore } from '#shared/utils/public-article-discovery';
import { discoverPublicWechatArticles } from '~/server/utils/sogou-public-discovery';

const MAX_ACCOUNT_NAME_LENGTH = 80;
const MAX_BIZ_LENGTH = 128;

export default defineEventHandler(async event => {
  const body = await readBody<{ accountName?: unknown; expectedBiz?: unknown; notBefore?: unknown }>(event);
  const accountName = String(body?.accountName ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const expectedBiz = String(body?.expectedBiz ?? '').trim();

  if (!accountName || accountName.length > MAX_ACCOUNT_NAME_LENGTH) {
    return { base_resp: { ret: -1, err_msg: '公众号名称无效' }, articles: [] };
  }
  if (!expectedBiz || expectedBiz.length > MAX_BIZ_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(expectedBiz)) {
    return { base_resp: { ret: -1, err_msg: '公众号稳定 ID 无效' }, articles: [] };
  }

  const notBefore = normalizePublicDiscoveryNotBefore(body?.notBefore);
  return discoverPublicWechatArticles({
    accountName,
    expectedBiz,
    notBefore,
  });
});

import { discoverKchuhaiMirrorArticles } from '~/server/utils/kchuhai-public-mirror';

export default defineEventHandler(async event => {
  if (!useRuntimeConfig(event).public.outputDir) {
    throw createError({ statusCode: 403, statusMessage: 'Local output mode is disabled' });
  }
  const body = await readBody<{
    accountName?: unknown;
    notBefore?: unknown;
    title?: unknown;
  }>(event);
  const accountName = String(body?.accountName ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const title = String(body?.title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const notBefore = String(body?.notBefore ?? '').trim();
  if (!accountName || accountName.length > 80 || !title || title.length > 160) {
    return { base_resp: { ret: -1, err_msg: '账号或标题无效' }, candidates: [] };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(notBefore)) {
    return { base_resp: { ret: -1, err_msg: '日期下限无效' }, candidates: [] };
  }
  return discoverKchuhaiMirrorArticles(title, accountName, notBefore);
});

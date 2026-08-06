import type { ImageMode } from '~/server/utils/wechat2md';
import { resolveWechat2MdOutputRoot, wechatMirror2md } from '~/server/utils/wechat2md';

export default defineEventHandler(async event => {
  if (!useRuntimeConfig(event).public.outputDir) {
    throw createError({ statusCode: 403, statusMessage: 'Local output mode is disabled' });
  }
  const body = await readBody<{
    accountName?: unknown;
    expectedBiz?: unknown;
    imageMode?: ImageMode;
    mirrorUrl?: unknown;
    outputDir?: unknown;
    publishDate?: unknown;
    title?: unknown;
  }>(event);
  const mirrorUrl = String(body?.mirrorUrl ?? '').trim();
  if (!mirrorUrl) return { success: false, error: 'mirrorUrl 不能为空' };

  let outputDir: string;
  try {
    outputDir = resolveWechat2MdOutputRoot(String(body?.outputDir ?? '') || undefined);
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  try {
    const result = await wechatMirror2md(mirrorUrl, {
      accountName: String(body?.accountName ?? ''),
      expectedBiz: String(body?.expectedBiz ?? ''),
      imageMode: body?.imageMode || 'cdn',
      outputDir,
      publishDate: String(body?.publishDate ?? ''),
      title: String(body?.title ?? ''),
    });
    return {
      success: true,
      accountName: result.accountName,
      articleDir: result.articleDir,
      filepath: result.filepath,
      imageStats: result.imageStats,
      mode: 'lite-mirror',
      title: result.title,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

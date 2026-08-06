import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ImageMode, Wechat2MdFallbackMetadata } from '~/server/utils/wechat2md';
import { resolveWechat2MdOutputRoot, wechat2md } from '~/server/utils/wechat2md';

// playwright 模式依赖外部脚本，已随 ~/Project/wechat2md 迁移合并进 lite 模式
// 若需要 playwright 回退，请将脚本路径配置为环境变量 WECHAT2MD_PLAYWRIGHT_SCRIPT
const WECHAT2MD_SCRIPT = process.env.WECHAT2MD_PLAYWRIGHT_SCRIPT ?? '';
const EXEC_TIMEOUT = 120_000;

export default defineEventHandler(async event => {
  const body = await readBody<{
    url: string;
    imageMode?: ImageMode;
    outputDir?: string;
    mode?: 'lite' | 'playwright';
    title?: string;
    accountName?: string;
    canonicalUrl?: string;
    expectedBiz?: string;
    publishDate?: string;
  }>(event);

  if (!body?.url) {
    return { success: false, error: 'url 不能为空' };
  }

  const mode = body.mode || 'lite';

  let outputDir: string;
  try {
    outputDir = resolveWechat2MdOutputRoot(body.outputDir);
  } catch (e: any) {
    return { success: false, error: e?.message || '输出目录不合法' };
  }

  if (mode === 'playwright') {
    return await playwrightMode(body.url, body.imageMode || 'cdn', outputDir);
  }

  try {
    const result = await wechat2md(body.url, {
      canonicalUrl: body.canonicalUrl,
      expectedBiz: body.expectedBiz,
      imageMode: body.imageMode,
      outputDir,
      fallbackMetadata: buildFallbackMetadata(body),
    });
    return {
      success: true,
      mode: 'lite',
      filepath: result.filepath,
      articleDir: result.articleDir,
      title: result.title,
      accountName: result.accountName,
      imageStats: result.imageStats,
    };
  } catch (e: any) {
    return { success: false, error: e?.message || '转换失败' };
  }
});

function buildFallbackMetadata(body: {
  title?: string;
  accountName?: string;
  publishDate?: string;
}): Wechat2MdFallbackMetadata {
  return {
    title: body.title,
    accountName: body.accountName,
    publishDate: body.publishDate,
  };
}

function playwrightMode(url: string, imageMode: string, outputDir?: string): Promise<any> {
  if (!WECHAT2MD_SCRIPT) {
    return Promise.resolve({
      success: false,
      mode: 'playwright',
      error:
        'playwright 模式需要配置环境变量 WECHAT2MD_PLAYWRIGHT_SCRIPT 指向外部脚本路径，当前未设置。请改用默认 lite 模式。',
    });
  }
  const args = [WECHAT2MD_SCRIPT, url, '--image-mode', imageMode];
  if (outputDir) {
    args.push('--output-dir', outputDir);
  }

  return new Promise(resolve => {
    execFile('node', args, { timeout: EXEC_TIMEOUT, maxBuffer: 50 * 1024 * 1024 }, async (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          mode: 'playwright',
          error: error.message,
          stdout: stdout?.slice(-2000),
          stderr: stderr?.slice(-2000),
        });
        return;
      }

      const filepathMatch = stdout.match(/文章已保存:\s*(.+\.md)/);
      if (!filepathMatch) {
        resolve({ success: false, mode: 'playwright', error: '未找到输出文件路径', stdout: stdout?.slice(-2000) });
        return;
      }

      const filepath = filepathMatch[1].trim();
      try {
        const markdown = await readFile(filepath, 'utf-8');
        resolve({ success: true, mode: 'playwright', filepath, markdown });
      } catch (readError: any) {
        resolve({ success: false, mode: 'playwright', error: `文件读取失败: ${readError.message}`, filepath });
      }
    });
  });
}

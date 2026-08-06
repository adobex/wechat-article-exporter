import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import {
  type ArticleOutputIdentity,
  type ExistingArticleOutput,
  getArticleOutputBase,
  normalizeArticleUrl,
  planArticleOutputPaths,
  readArticleUrlFromMarkdown,
} from '#shared/utils/article-output-path';
import { createTurndownService } from '#shared/utils/markdown';
import { extractWechatAssignedString } from '#shared/utils/public-article-discovery';
import { assertKchuhaiMirrorUrl, parseKchuhaiMirrorArticle } from '~/server/utils/kchuhai-public-mirror';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IMAGE_REQUEST_TIMEOUT = 20_000;
const MAX_TRUSTED_MIRROR_HTML_BYTES = 10 * 1024 * 1024;
const TRUSTED_MIRROR_ACCOUNTS: Record<string, string> = {
  'Mzg5MTcwMTI5Nw==': '王董的新游戏',
};
export const DEFAULT_OUTPUT_DIR = resolve(
  process.env.WECHAT2MD_OUTPUT_DIR?.trim() || '/Users/adobe/Project/output/WechatArticles'
);
const ALLOWED_OUTPUT_ROOT = resolve(DEFAULT_OUTPUT_DIR);
const UNKNOWN_ACCOUNT_DIR = '未知公众号';
const PROCESS_OUTPUT_RESERVATIONS = new Map<string, string>();

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

export type ImageMode = 'base64' | 'indexed' | 'cdn';

export interface Wechat2MdOptions {
  canonicalUrl?: string;
  expectedBiz?: string;
  imageMode?: ImageMode;
  outputDir?: string;
  fallbackMetadata?: Wechat2MdFallbackMetadata;
}

export interface Wechat2MdFallbackMetadata {
  title?: string | null;
  accountName?: string | null;
  publishDate?: string | null;
}

export interface WechatMirror2MdOptions {
  accountName: string;
  expectedBiz: string;
  imageMode?: ImageMode;
  outputDir?: string;
  publishDate: string;
  title: string;
}

export interface Wechat2MdResult {
  success: boolean;
  filepath: string;
  articleDir: string;
  title: string;
  accountName: string;
  markdown: string;
  imageStats: { total: number; successCount: number; failureCount: number };
}

function isPathInside(base: string, target: string): boolean {
  const relativePath = relative(base, target);
  return (
    relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

export function resolveWechat2MdOutputRoot(outputDir?: string): string {
  const outputRoot = resolve(outputDir || DEFAULT_OUTPUT_DIR);
  if (!isPathInside(ALLOWED_OUTPUT_ROOT, outputRoot)) {
    throw new Error(`输出目录不在允许范围内，仅允许写入 ${ALLOWED_OUTPUT_ROOT} 下`);
  }
  return outputRoot;
}

interface ArticleMetadata {
  title: string;
  accountName: string;
  publishDate: string;
  sourceEvidenceUrl?: string;
  url: string;
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveExt(url: string, contentType: string): string {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (CONTENT_TYPE_EXT[ct]) return CONTENT_TYPE_EXT[ct];
  try {
    const ext = extname(new URL(url).pathname).replace('.', '').toLowerCase();
    if (ext) return ext;
  } catch {}
  return 'png';
}

function firstText($: cheerio.CheerioAPI, selectors: string[], fallback = ''): string {
  for (const sel of selectors) {
    const text = cleanText($(sel).first().text());
    if (text) return text;
  }
  return fallback;
}

function extractMetadata(
  $: cheerio.CheerioAPI,
  url: string,
  fallback: Wechat2MdFallbackMetadata = {}
): ArticleMetadata {
  const fallbackTitle = cleanText(fallback.title);
  const fallbackAccountName = cleanText(fallback.accountName);
  const fallbackPublishDate = cleanText(fallback.publishDate);
  const pagePublishDate = firstText($, ['#publish_time', '.publish_time']);

  return {
    title: firstText($, ['.rich_media_title', '#activity-name', 'h1'], fallbackTitle || '未命名文章'),
    accountName: firstText($, ['.profile_nickname', '#js_name'], fallbackAccountName || UNKNOWN_ACCOUNT_DIR),
    publishDate: fallbackPublishDate || pagePublishDate,
    url,
  };
}

function readMarkdownUrl(markdownPath: string): string | undefined {
  try {
    return readArticleUrlFromMarkdown(readFileSync(markdownPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function listExistingArticleOutputs(outputRoot: string, accountDirectory: string): ExistingArticleOutput[] {
  const accountPath = join(outputRoot, accountDirectory);
  const outputs: ExistingArticleOutput[] = [];
  if (existsSync(accountPath)) {
    for (const entry of readdirSync(accountPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const markdownPath = join(accountPath, entry.name, 'index.md');
      outputs.push({
        relativeDirectory: `${accountDirectory}/${entry.name}`,
        url: existsSync(markdownPath) ? readMarkdownUrl(markdownPath) : null,
      });
    }
  }

  for (const [absoluteDirectory, url] of PROCESS_OUTPUT_RESERVATIONS) {
    if (!isPathInside(accountPath, absoluteDirectory)) continue;
    outputs.push({ relativeDirectory: relative(outputRoot, absoluteDirectory), url });
  }
  return outputs;
}

async function resolveArticleDir(outputRoot: string, identity: ArticleOutputIdentity): Promise<string> {
  const base = getArticleOutputBase(identity);
  const existing = listExistingArticleOutputs(outputRoot, base.accountDirectory);
  const [plan] = await planArticleOutputPaths([identity], { existing });
  const articleDir = join(outputRoot, ...plan.relativeDirectory.split('/'));

  if (base.accountDirectory !== UNKNOWN_ACCOUNT_DIR) {
    const normalizedUrl = normalizeArticleUrl(identity.url);
    const unknownOutput = listExistingArticleOutputs(outputRoot, UNKNOWN_ACCOUNT_DIR).find(
      item => item.url && normalizeArticleUrl(item.url) === normalizedUrl
    );
    if (unknownOutput) {
      const unknownDir = join(outputRoot, ...unknownOutput.relativeDirectory.split('/'));
      if (unknownDir !== articleDir) {
        if (!existsSync(articleDir)) {
          mkdirSync(dirname(articleDir), { recursive: true });
          renameSync(unknownDir, articleDir);
        }
      }
    }
  }

  PROCESS_OUTPUT_RESERVATIONS.set(articleDir, normalizeArticleUrl(identity.url));
  return articleDir;
}

function writeFileAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    if (typeof data === 'string') {
      writeFileSync(temporaryPath, data, { encoding: 'utf8', flag: 'wx' });
    } else {
      writeFileSync(temporaryPath, data, { flag: 'wx' });
    }
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function buildHeader(meta: ArticleMetadata): string {
  const esc = (v: string) => JSON.stringify(String(v ?? ''));
  const sourceEvidence = meta.sourceEvidenceUrl ? `source_evidence: ${esc(meta.sourceEvidenceUrl)}\n` : '';
  return `---\ntitle: ${esc(meta.title)}\nauthor: ${esc(meta.accountName)}\ndate: ${esc(meta.publishDate)}\nurl: ${esc(meta.url)}\n${sourceEvidence}---\n\n# ${meta.title}\n\n`;
}

function hasMarkdownContent($content: cheerio.Cheerio<Element>): boolean {
  const text = $content.text().replace(/[\s\u00A0]+/g, '');
  return text.length > 0 || $content.find('img').length > 0;
}

function assertCanonicalArticleIdentity(html: string, canonicalUrl: URL): void {
  const expectedBiz = canonicalUrl.searchParams.get('__biz') || '';
  const expectedMid = canonicalUrl.searchParams.get('mid') || '';
  const expectedIdx = canonicalUrl.searchParams.get('idx') || '';
  if (!expectedBiz || !expectedMid || !expectedIdx) {
    throw new Error('规范文章 URL 缺少公众号或文章身份参数');
  }

  const actualBiz = extractWechatAssignedString(html, 'biz');
  const actualMid = extractWechatAssignedString(html, 'mid');
  const actualIdx = extractWechatAssignedString(html, 'idx');
  if (actualBiz !== expectedBiz || actualMid !== expectedMid || actualIdx !== expectedIdx) {
    throw new Error('临时文章链接已失效或返回了不匹配的文章');
  }
}

function assertExpectedArticleBiz(html: string, expectedBiz: string): void {
  const expected = cleanText(expectedBiz);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(expected)) throw new Error('公众号稳定 ID 无效');
  const actual = extractWechatAssignedString(html, 'biz');
  if (!actual || actual !== expected) throw new Error('文章所属公众号与目标账号不匹配');
}

async function fetchImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_REQUEST_TIMEOUT);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://mp.weixin.qq.com/' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const arrayBuf = await resp.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuf),
      contentType: resp.headers.get('content-type') || 'image/png',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function processImagesBase64($content: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI) {
  const imgs = $content.find('img').toArray();
  let success = 0;
  let fail = 0;

  for (const el of imgs) {
    const $img = $(el);
    const src = $img.attr('data-src') || $img.attr('src');
    if (!src) {
      fail++;
      continue;
    }
    const imageUrl = src.startsWith('http') ? src : `https:${src}`;
    try {
      const { buffer, contentType } = await fetchImage(imageUrl);
      const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;
      $img.attr('src', dataUri);
      $img.attr('alt', $img.attr('data-alt') || $img.attr('alt') || '');
      success++;
    } catch {
      $img.attr('alt', `${$img.attr('alt') || '图片'}（下载失败）`);
      fail++;
    }
  }

  return { total: imgs.length, successCount: success, failureCount: fail };
}

async function processImagesIndexed(
  $content: cheerio.Cheerio<Element>,
  $: cheerio.CheerioAPI,
  imageDirPath: string,
  imageDirName: string
) {
  const imgs = $content.find('img').toArray();
  let success = 0;
  let fail = 0;
  let savedIdx = 0;
  const temporaryImageDirPath = `${imageDirPath}.tmp-${randomUUID()}`;

  rmSync(temporaryImageDirPath, { recursive: true, force: true });
  mkdirSync(temporaryImageDirPath, { recursive: true });

  try {
    for (const el of imgs) {
      const $img = $(el);
      const src = $img.attr('data-src') || $img.attr('src');
      if (!src) {
        fail++;
        continue;
      }
      const imageUrl = src.startsWith('http') ? src : `https:${src}`;
      try {
        const { buffer, contentType } = await fetchImage(imageUrl);
        const ext = resolveExt(imageUrl, contentType);
        const filename = `${String(savedIdx + 1).padStart(3, '0')}.${ext}`;
        writeFileAtomic(join(temporaryImageDirPath, filename), buffer);
        $img.attr('src', `${imageDirName}/${filename}`);
        $img.attr('alt', '');
        success++;
        savedIdx++;
      } catch {
        $img.attr('alt', `${$img.attr('alt') || '图片'}（下载失败）`);
        fail++;
      }
    }

    if (success === 0) {
      rmSync(temporaryImageDirPath, { recursive: true, force: true });
    } else {
      rmSync(imageDirPath, { recursive: true, force: true });
      renameSync(temporaryImageDirPath, imageDirPath);
    }
  } catch (error) {
    rmSync(temporaryImageDirPath, { recursive: true, force: true });
    throw error;
  }

  return { total: imgs.length, successCount: success, failureCount: fail };
}

async function writeArticleMarkdown(
  $: cheerio.CheerioAPI,
  $content: cheerio.Cheerio<Element>,
  metadata: ArticleMetadata,
  outputRoot: string,
  imageMode: ImageMode
): Promise<Wechat2MdResult> {
  $content.find('script, style, link, noscript, iframe').remove();
  const articleDir = await resolveArticleDir(outputRoot, {
    accountName: metadata.accountName,
    title: metadata.title,
    publishDate: metadata.publishDate,
    url: metadata.url,
  });
  const markdownPath = join(articleDir, 'index.md');
  const imageDirName = 'images';
  const imageDirPath = join(articleDir, imageDirName);
  mkdirSync(articleDir, { recursive: true });

  let imageStats: { total: number; successCount: number; failureCount: number };
  if (imageMode === 'cdn') {
    const imgs = $content.find('img').toArray();
    for (const el of imgs) {
      const $img = $(el);
      const src = $img.attr('data-src') || $img.attr('src');
      if (src) $img.attr('src', src.startsWith('http') ? src : `https:${src}`);
    }
    imageStats = { total: imgs.length, successCount: imgs.length, failureCount: 0 };
  } else if (imageMode === 'base64') {
    imageStats = await processImagesBase64($content, $);
  } else {
    imageStats = await processImagesIndexed($content, $, imageDirPath, imageDirName);
  }

  const markdownBody = createTurndownService()
    .turndown($content.html() || '')
    .trim();
  const fileContent = `${buildHeader(metadata)}${markdownBody}\n`;
  writeFileAtomic(markdownPath, fileContent);

  return {
    success: true,
    filepath: markdownPath,
    articleDir,
    title: metadata.title,
    accountName: metadata.accountName,
    markdown: fileContent,
    imageStats,
  };
}

export async function wechat2md(inputUrl: string, options: Wechat2MdOptions = {}): Promise<Wechat2MdResult> {
  let url: URL;
  try {
    url = new URL(inputUrl.trim());
  } catch {
    throw new Error('URL 格式不正确');
  }
  if (url.hostname !== 'mp.weixin.qq.com') {
    throw new Error('请提供有效的微信公众号文章链接');
  }

  const normalizedUrl = url.toString();
  let canonicalUrl = normalizedUrl;
  let canonicalArticleUrl: URL | null = null;
  if (options.canonicalUrl) {
    let candidate: URL;
    try {
      candidate = new URL(options.canonicalUrl.trim());
    } catch {
      throw new Error('规范文章 URL 格式不正确');
    }
    if (candidate.protocol !== 'https:' || candidate.hostname !== 'mp.weixin.qq.com' || candidate.pathname !== '/s') {
      throw new Error('规范文章 URL 必须是微信公众号文章链接');
    }
    canonicalUrl = candidate.toString();
    canonicalArticleUrl = candidate;
  }
  const imageMode: ImageMode = options.imageMode || 'cdn';
  const outputRoot = resolveWechat2MdOutputRoot(options.outputDir);

  const response = await fetch(normalizedUrl, {
    redirect: 'manual',
    headers: {
      'User-Agent': USER_AGENT,
      Referer: 'https://mp.weixin.qq.com/',
      Origin: 'https://mp.weixin.qq.com',
    },
  });
  if (!response.ok) throw new Error(`文章下载失败: HTTP ${response.status}`);
  const rawHtml = await response.text();
  if (rawHtml.includes('环境异常') || rawHtml.includes('访问过于频繁') || rawHtml.includes('请输入验证码')) {
    throw new Error('临时文章链接已失效或受到微信访问限制');
  }
  if (canonicalArticleUrl) assertCanonicalArticleIdentity(rawHtml, canonicalArticleUrl);
  if (options.expectedBiz) assertExpectedArticleBiz(rawHtml, options.expectedBiz);

  const $ = cheerio.load(rawHtml);
  const metadata = extractMetadata($, canonicalUrl, options.fallbackMetadata);

  let $content =
    $('#js_content').length > 0
      ? $('#js_content')
      : $('.rich_media_content').length > 0
        ? $('.rich_media_content')
        : $('#img-content');

  if ($content.length === 0 || !hasMarkdownContent($content)) {
    throw new Error('未找到文章内容');
  }
  return writeArticleMarkdown($, $content, metadata, outputRoot, imageMode);
}

export async function wechatMirror2md(mirrorUrl: string, options: WechatMirror2MdOptions): Promise<Wechat2MdResult> {
  const trustedMirrorUrl = assertKchuhaiMirrorUrl(mirrorUrl).toString();
  const expectedAccountName = cleanText(options.accountName);
  const expectedTitle = cleanText(options.title);
  const expectedPublishDate = cleanText(options.publishDate);
  if (TRUSTED_MIRROR_ACCOUNTS[options.expectedBiz] !== expectedAccountName) {
    throw new Error('该公众号未配置可信镜像恢复');
  }
  if (!expectedTitle || !/^\d{4}-\d{2}-\d{2}$/.test(expectedPublishDate)) {
    throw new Error('镜像恢复的标题或发布日期无效');
  }

  const response = await fetch(trustedMirrorUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'User-Agent': USER_AGENT,
    },
    redirect: 'manual',
  });
  if (!response.ok) throw new Error(`镜像文章下载失败: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_TRUSTED_MIRROR_HTML_BYTES) throw new Error('镜像文章响应过大');
  const rawHtml = await response.text();
  if (rawHtml.length > MAX_TRUSTED_MIRROR_HTML_BYTES) throw new Error('镜像文章响应过大');
  const mirror = parseKchuhaiMirrorArticle(rawHtml, trustedMirrorUrl);
  if (
    mirror.accountName !== expectedAccountName ||
    mirror.title !== expectedTitle ||
    mirror.publishDate !== expectedPublishDate
  ) {
    throw new Error('镜像文章与预期账号、标题或发布日期不匹配');
  }

  const $ = cheerio.load(`<div id="trusted-mirror-content">${mirror.bodyHtml}</div>`);
  const $content = $('#trusted-mirror-content');
  if (!hasMarkdownContent($content)) throw new Error('镜像文章正文为空');
  return writeArticleMarkdown(
    $,
    $content,
    {
      accountName: mirror.accountName,
      publishDate: mirror.publishDate,
      sourceEvidenceUrl: mirror.mirrorUrl,
      title: mirror.title,
      url: mirror.originalUrl,
    },
    resolveWechat2MdOutputRoot(options.outputDir),
    options.imageMode || 'cdn'
  );
}

import dayjs from 'dayjs';
import mime from 'mime';
import {
  type ExistingArticleOutput,
  normalizeArticleUrl,
  planArticleOutputPaths,
  readArticleUrlFromMarkdown,
} from '#shared/utils/article-output-path';
import { filterInvalidFilenameChars, sleep } from '#shared/utils/helpers';
import { extractWechatScriptAssignment, parseCgiDataNew, type SafeScriptValue } from '#shared/utils/html';
import { createTurndownService } from '#shared/utils/markdown';
import { renderHTMLFromCgiDataNew, renderTextFromCgiDataNew } from '#shared/utils/renderer';
import usePreferences from '~/composables/usePreferences';
import { getArticleByLink } from '~/store/v2/article';
import { getHtmlCache, type HtmlAsset } from '~/store/v2/html';
import { getAccountNameByFakeid, getAllInfo, type MpAccount } from '~/store/v2/info';
import { getMetadataCache } from '~/store/v2/metadata';
import { getResourceCache, updateResourceCache } from '~/store/v2/resource';
import { getResourceMapCache, updateResourceMapCache } from '~/store/v2/resource-map';
import type { Preferences } from '~/types/preferences';
import { getArticleComments, renderComments } from '~/utils/comment';
import { BaseDownloader } from '~/utils/download/BaseDownloader';
import { type ExcelExportEntity, export2ExcelFile, export2JsonFile } from '~/utils/exporter';
import type { DownloadOptions } from './types';

// 导出类型
type ExportType = 'excel' | 'json' | 'html' | 'txt' | 'markdown' | 'word' | 'pdf';

const preferences: Ref<Preferences> = usePreferences() as unknown as Ref<Preferences>;

export interface FileExportQueueResult {
  successUrls: string[];
  failedUrls: string[];
}

interface MarkdownExportContext {
  url: string;
  article: Awaited<ReturnType<typeof getArticleByLink>>;
  contentElement: Element;
  title: string;
  accountName: string;
  publishDate: string;
}

function asSafeScriptRecord(value: SafeScriptValue | null): Record<string, SafeScriptValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseSafeScriptString(expression: string | undefined): string | null {
  if (!expression) return null;
  const value = extractWechatScriptAssignment(
    `window.__exporter_value__ = ${expression};`,
    'window.__exporter_value__'
  );
  return typeof value === 'string' ? value : null;
}

function extractTopLevelPictureUrls(source: string): string[] {
  const candidates = Array.from(
    source.matchAll(/^(?<indent>\s*)cdn_url\s*:\s*(?<value>(?:JsDecode\([^\n]+\)|['"][^\n]*['"])),?\s*$/gm)
  );
  if (candidates.length === 0) return [];

  const minimumIndent = Math.min(...candidates.map(match => match.groups?.indent.length ?? Number.MAX_SAFE_INTEGER));
  return candidates
    .filter(match => match.groups?.indent.length === minimumIndent)
    .map(match => parseSafeScriptString(match.groups?.value))
    .filter((value): value is string => Boolean(value));
}

export class FileExportError extends Error {
  constructor(
    message: string,
    public readonly result: FileExportQueueResult
  ) {
    super(message);
    this.name = 'FileExportError';
  }
}

export class Exporter extends BaseDownloader {
  private exportType: ExportType = 'html';
  private allAccountInfo: MpAccount[] = [];

  // 导出的根目录
  private exportRootDirectoryHandle: FileSystemDirectoryHandle | null = null;
  private readonly resources: Set<{ url: string; fakeid: string }>;

  // 服务端固定输出目录（设置后跳过目录选择器，通过 API 写文件）
  public serverOutputDir: string | null = null;

  // Markdown 图片模式：indexed=本地文件 | base64=内嵌 | cdn=保留原链接
  public mdImageMode: 'indexed' | 'base64' | 'cdn' = 'indexed';

  constructor(urls: string[], options: DownloadOptions = {}) {
    super(urls, options);
    this.resources = new Set();
  }

  // 启动导出任务
  public async startExport(type: ExportType = 'html'): Promise<FileExportQueueResult | undefined> {
    if (this.isRunning) {
      throw new Error('导出任务正在运行中，无需重复启动');
    }

    if (['html', 'txt', 'markdown', 'word', 'pdf'].includes(type)) {
      // 这些类型需要实时写入文件系统，提前初始化导出目录句柄
      try {
        await this.acquireExportDirectoryHandle();
      } catch (err) {
        console.error(err);
        return;
      }
    }

    this.exportType = type;
    this.isRunning = true;
    const start = Date.now();
    this.emit('export:begin');

    this.allAccountInfo = await getAllInfo();
    let result: FileExportQueueResult | undefined;

    try {
      if (this.exportType === 'excel') {
        await this.exportExcelFiles();
      } else if (this.exportType === 'json') {
        await this.exportJsonFiles();
      } else if (this.exportType === 'html') {
        // 1. 提取出所有html中需要下载的资源链接
        await this.extractResources();
        this.emit('export:download', this.resources.size);

        // 2. 采用队列下载 resources 资源
        await this.processExportQueue();

        // 3. 替换html中的资源路径，并写入文件系统
        result = await this.exportHtmlFiles();
      } else if (this.exportType === 'txt') {
        result = await this.exportTxtFiles();
      } else if (this.exportType === 'word') {
        result = await this.exportWordFiles();
      } else if (this.exportType === 'markdown') {
        result = await this.exportMarkdownFiles();
      } else if (this.exportType === 'pdf') {
        await this.extractResources();
        this.emit('export:download', this.resources.size);
        await this.processExportQueue();
        result = await this.exportPdfFiles();
      }
    } finally {
      this.isRunning = false;
      const elapse = Math.round((Date.now() - start) / 1000);
      this.emit('export:finish', elapse);
      this.cancelAllPending();
    }

    return result;
  }

  // 提取出 html 中的子资源，并保存在 resource-map 表中
  private async extractResources(): Promise<void> {
    const parser = new DOMParser();

    for (const url of this.urls) {
      const article = await getArticleByLink(url);
      if (!article) {
        continue;
      }

      const cached = await getHtmlCache(url);
      if (!cached) {
        console.warn(`文章(url: ${url} )的 html 还未下载，不能导出`);
        continue;
      }

      const html = await cached.file.text();
      const document = parser.parseFromString(html, 'text/html');

      // 该 html 内部的资源，包括图片、背景图片、样式
      const resources: string[] = [];

      // 提取图片地址
      const imgs = document.querySelectorAll<HTMLImageElement>('img');
      for (const img of imgs) {
        const imgUrl = img.getAttribute('src') || img.getAttribute('data-src');
        if (imgUrl) {
          resources.push(imgUrl);
          this.resources.add({ url: imgUrl, fakeid: article.fakeid });
        }
      }

      // 提取样式地址
      const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
      for (const link of links) {
        const url = link.href;
        if (url) {
          resources.push(url);
          this.resources.add({ url: url, fakeid: article.fakeid });
        }
      }

      // 提取背景图片地址
      html.replaceAll(
        /((?:background|background-image): url\((?:&quot;)?)((?:https?|\/\/)[^)]+?)((?:&quot;)?\))/gs,
        (_, p1, url, p3) => {
          resources.push(url);
          this.resources.add({ url: url, fakeid: article.fakeid });
          return `${p1}${url}${p3}`;
        }
      );

      await updateResourceMapCache({
        fakeid: article.fakeid,
        url: url,
        resources: resources,
      });
    }
  }

  // 处理导出任务队列
  private async processExportQueue() {
    const activePromises: Set<Promise<any>> = new Set();
    const resources = [...this.resources];

    while (resources.length > 0 || activePromises.size > 0) {
      // 检查是否需要启动新的下载任务，需同时满足以下两点:
      // - 没有达到并发量限制
      // - 还有更多 URL 需要下载
      while (activePromises.size < this.options.concurrency && resources.length > 0) {
        // 启动新的下载任务
        const resource: { url: string; fakeid: string } = resources.pop()!;
        const promise = this.downloadResourceTask(resource.url, resource.fakeid);
        activePromises.add(promise);
        promise.finally(() => {
          activePromises.delete(promise);

          // 下载任务结束，触发通知
          this.emit('export:download:progress', resource.url, this.completed.has(resource.url), this.getStatus());
        });
      }

      // 等待任何活动任务完成
      if (activePromises.size > 0) {
        await Promise.race(activePromises);
      }
    }
  }

  /**
   * 并发处理文件导出队列
   * 复用 processExportQueue 的 Promise.race() 并发模型
   * @param urls 待处理的文章 URL 列表
   * @param task 每篇文章的处理函数
   * @param options 可选配置
   */
  private async processFileExportQueue(
    urls: string[],
    task: (url: string) => Promise<void>,
    options: { concurrency?: number; progressEvent?: string } = {}
  ): Promise<FileExportQueueResult> {
    const { concurrency = 5, progressEvent = 'export:progress' } = options;
    const activePromises: Set<Promise<void>> = new Set();
    const queue = [...urls];
    let completedCount = 0;
    let failureCount = 0;
    let firstError: unknown = null;
    const result: FileExportQueueResult = {
      successUrls: [],
      failedUrls: [],
    };

    while (queue.length > 0 || activePromises.size > 0) {
      while (activePromises.size < concurrency && queue.length > 0) {
        const url = queue.pop()!;
        const promise = task(url)
          .then(() => {
            result.successUrls.push(url);
            completedCount++;
            this.emit(progressEvent, completedCount);
          })
          .catch(e => {
            console.error(`导出文件失败(url: ${url}):`, e);
            failureCount++;
            result.failedUrls.push(url);
            firstError ??= e;
            completedCount++;
            this.emit(progressEvent, completedCount);
          });
        activePromises.add(promise);
        promise.finally(() => {
          activePromises.delete(promise);
        });
      }

      if (activePromises.size > 0) {
        await Promise.race(activePromises);
      }
    }

    if (failureCount > 0) {
      const message = firstError instanceof Error ? firstError.message : String(firstError || '未知错误');
      throw new FileExportError(`导出失败 ${failureCount} 篇：${message}`, result);
    }

    return result;
  }

  // 下载资源任务
  private async downloadResourceTask(url: string, fakeid: string): Promise<void> {
    this.pending.add(url);

    // 检查缓存是否可用，避免重复下载相同资源
    const cached = await getResourceCache(url);
    if (cached) {
      this.pending.delete(url);
      this.completed.add(url);
      return;
    }

    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      const proxy = this.proxyManager.getBestProxy();

      try {
        const blob = await this.download(fakeid, url, proxy);
        await updateResourceCache({
          fakeid: fakeid,
          url: url,
          file: blob,
        });
        this.pending.delete(url);
        this.completed.add(url);
        this.proxyManager.recordSuccess(proxy);
        return;
      } catch (error) {
        await this.handleDownloadFailure(this.proxyManager, proxy, url, attempt, error);
      }
    }

    this.pending.delete(url);
    this.failed.add(url);
  }

  // 导出 excel 文件
  private async exportExcelFiles(): Promise<void> {
    const total = this.urls.length;
    this.emit('export:total', total);

    const data: ExcelExportEntity[] = [];

    for (let i = 0; i < total; i++) {
      const url = this.urls[i];
      console.debug(`(${i + 1}/${total})开始导出: ${url}`);

      const article = await getArticleByLink(url);
      const accountName = await getAccountNameByFakeid(article.fakeid);
      const exportedArticle: ExcelExportEntity = { ...article, _accountName: accountName };
      if (preferences.value.exportConfig.exportExcelIncludeContent) {
        exportedArticle.content = await this.getRenderedText(url);
      }
      const metadata = await getMetadataCache(url);
      if (metadata) {
        exportedArticle.readNum = metadata.readNum;
        exportedArticle.oldLikeNum = metadata.oldLikeNum;
        exportedArticle.shareNum = metadata.shareNum;
        exportedArticle.likeNum = metadata.likeNum;
        exportedArticle.commentNum = metadata.commentNum;
      }
      data.push(exportedArticle);

      this.emit('export:progress', i + 1);
    }

    await export2ExcelFile(data, '微信公众号文章');
  }

  // 导出 json 文件
  private async exportJsonFiles(): Promise<void> {
    const total = this.urls.length;
    this.emit('export:total', total);

    const data: ExcelExportEntity[] = [];

    for (let i = 0; i < total; i++) {
      const url = this.urls[i];
      console.log(`(${i + 1}/${total})开始导出: ${url}`);

      const article = await getArticleByLink(url);
      const accountName = await getAccountNameByFakeid(article.fakeid);
      const exportedArticle: ExcelExportEntity = { ...article, _accountName: accountName };

      if (preferences.value.exportConfig.exportJsonIncludeContent) {
        exportedArticle.content = await this.getRenderedText(url);
      }
      const metadata = await getMetadataCache(url);
      if (metadata) {
        exportedArticle.readNum = metadata.readNum;
        exportedArticle.oldLikeNum = metadata.oldLikeNum;
        exportedArticle.shareNum = metadata.shareNum;
        exportedArticle.likeNum = metadata.likeNum;
        exportedArticle.commentNum = metadata.commentNum;
      }
      if (preferences.value.exportConfig.exportJsonIncludeComments) {
        // 包含评论
        exportedArticle.comments = await getArticleComments(url);
      }
      data.push(exportedArticle);

      this.emit('export:progress', i + 1);
    }

    await export2JsonFile(data, '微信公众号文章');
  }

  // 导出 html 文件（并发处理）
  private async exportHtmlFiles(): Promise<FileExportQueueResult> {
    const total = this.urls.length;
    console.log(`总共${total}篇文章`);
    this.emit('export:write', total);

    const result = await this.processFileExportQueue(
      this.urls,
      async url => {
        const cached = await getHtmlCache(url);
        if (!cached) {
          console.warn(`文章(url: ${url} )的 html 还未下载，不能导出`);
          return;
        }

        const dirname = await this.exportDirName(cached.url);

        console.log(`开始导出: ${cached.title}，目录名: ${dirname}`);
        const html = await cached.file.text();
        const resourceMap = await getResourceMapCache(url);
        if (!resourceMap) {
          console.warn(`文章(url: ${url} )的 resource-map 缺失，无法导出`);
          return;
        }

        const urlmap = new Map<string, string>();
        for (const resourceUrl of resourceMap.resources) {
          const resource = await getResourceCache(resourceUrl);
          if (!resource) {
            continue;
          }

          const uuid = new Date().getTime() + Math.random().toString();
          const ext = mime.getExtension(resource.file.type);
          if (ext) {
            await this.writeFile(dirname + `/assets/${uuid}.${ext}`, resource.file);
            urlmap.set(resourceUrl, `./assets/${uuid}.${ext}`);
          }
        }

        const finalHtml = await this.normalizeHtml(cached, html, urlmap);
        const blob = new Blob([finalHtml], { type: 'text/html;charset=utf-8' });

        await this.writeFile(dirname + '/index.html', blob);
      },
      { progressEvent: 'export:write:progress' }
    );
    await sleep(100);
    return result;
  }

  // 导出 txt 文件（并发处理）
  private async exportTxtFiles(): Promise<FileExportQueueResult> {
    const total = this.urls.length;
    this.emit('export:total', total);

    const result = await this.processFileExportQueue(this.urls, async url => {
      const filename = await this.exportDirName(url);
      console.log(`开始导出: ${filename}(${url})`);

      const content = await this.getRenderedText(url);
      if (!content) return;

      const blob = new Blob([content], { type: 'text/plain' });
      await this.writeFile(filename + '.txt', blob);
    });
    await sleep(100);
    return result;
  }

  // 导出 markdown 文件（并发处理，图片下载到本地 images/ 目录并用相对路径引用）
  private async exportMarkdownFiles(): Promise<FileExportQueueResult> {
    const uniqueUrls = Array.from(new Map(this.urls.map(url => [normalizeArticleUrl(url), url] as const)).values());
    this.emit('export:total', uniqueUrls.length);

    const turndownService = createTurndownService();

    const parser = new DOMParser();
    const prepared = new Map<string, MarkdownExportContext | Error>();
    const contexts: MarkdownExportContext[] = [];
    for (const url of uniqueUrls) {
      try {
        const context = await this.prepareMarkdownExport(url, parser);
        prepared.set(url, context);
        contexts.push(context);
      } catch (error) {
        prepared.set(url, error instanceof Error ? error : new Error(String(error)));
      }
    }

    const planningOptions = await this.getMarkdownOutputPlanningOptions();
    const plans = await planArticleOutputPaths(
      contexts.map(context => ({
        url: context.url,
        accountName: context.accountName,
        title: context.title,
        publishDate: context.publishDate,
      })),
      planningOptions
    );
    const directoryByUrl = new Map(
      plans.map((plan, index) => [normalizeArticleUrl(contexts[index].url), plan.relativeDirectory] as const)
    );

    const result = await this.processFileExportQueue(uniqueUrls, async url => {
      const context = prepared.get(url);
      if (!context) {
        throw new Error(`文章(url: ${url}) 的 Markdown 预检结果缺失`);
      }
      if (context instanceof Error) {
        throw context;
      }

      const dirname = directoryByUrl.get(normalizeArticleUrl(url));
      if (!dirname) {
        throw new Error(`文章(url: ${url}) 未分配唯一输出路径`);
      }
      console.log(`开始导出 Markdown: ${dirname}(${url})`);

      const imgs = context.contentElement.querySelectorAll<HTMLImageElement>('img');
      let imgIdx = 0;
      for (const img of imgs) {
        const src = img.getAttribute('data-src') || img.getAttribute('src');
        if (!src) continue;
        const imageUrl = src.startsWith('http') ? src : `https:${src}`;

        if (this.mdImageMode === 'cdn') {
          img.setAttribute('src', imageUrl);
          img.setAttribute('alt', img.getAttribute('data-alt') || img.getAttribute('alt') || '');
          continue;
        }

        try {
          const proxy = this.proxyManager.getBestProxy();
          const blob = await this.download(context.article.fakeid || '', imageUrl, proxy);
          this.proxyManager.recordSuccess(proxy);

          if (this.mdImageMode === 'base64') {
            const arrayBuffer = await blob.arrayBuffer();
            const base64 = btoa(new Uint8Array(arrayBuffer).reduce((d, b) => d + String.fromCharCode(b), ''));
            const dataUri = `data:${blob.type || 'image/png'};base64,${base64}`;
            img.setAttribute('src', dataUri);
          } else {
            const ext = mime.getExtension(blob.type) || 'png';
            const imageFilename = `${String(imgIdx + 1).padStart(3, '0')}.${ext}`;
            await this.writeFile(`${dirname}/images/${imageFilename}`, blob);
            img.setAttribute('src', `images/${imageFilename}`);
            imgIdx++;
          }
          img.setAttribute('alt', img.getAttribute('data-alt') || img.getAttribute('alt') || '');
        } catch (e) {
          img.setAttribute('alt', `${img.getAttribute('alt') || '图片'}（下载失败）`);
        }
      }

      const markdownBody = turndownService.turndown(context.contentElement.innerHTML).trim();
      const header = `---\ntitle: ${JSON.stringify(context.title)}\nauthor: ${JSON.stringify(context.accountName)}\ndate: ${JSON.stringify(context.publishDate)}\nurl: ${JSON.stringify(url)}\n---\n\n# ${context.title}\n\n`;
      const fileContent = `${header}${markdownBody}\n`;

      const blob = new Blob([fileContent], { type: 'text/markdown' });
      await this.writeFile(`${dirname}/index.md`, blob);
    });
    await sleep(100);
    return result;
  }

  private async prepareMarkdownExport(url: string, parser: DOMParser): Promise<MarkdownExportContext> {
    const cached = await getHtmlCache(url);
    if (!cached) {
      throw new Error(`文章(url: ${url} )的 html 还未缓存，不能导出 Markdown`);
    }

    const article = await getArticleByLink(url);
    const doc = parser.parseFromString(await cached.file.text(), 'text/html');
    let contentElement = this.findMarkdownContentElement(doc);
    let metadataDoc = doc;
    if (!contentElement || !this.hasMarkdownContent(contentElement)) {
      const renderedHTML = await this.getRenderedHTML(url, false);
      if (renderedHTML) {
        const renderedDoc = parser.parseFromString(renderedHTML, 'text/html');
        const renderedContentElement = this.findMarkdownContentElement(renderedDoc, true);
        if (renderedContentElement && this.hasMarkdownContent(renderedContentElement)) {
          contentElement = renderedContentElement;
          metadataDoc = renderedDoc;
        }
      }
    }

    if (!contentElement || !this.hasMarkdownContent(contentElement)) {
      throw new Error(`文章(url: ${url} )未找到正文内容，不能导出 Markdown`);
    }
    contentElement.querySelectorAll('script, style, link, noscript, iframe').forEach(element => {
      element.remove();
    });

    const account = this.allAccountInfo.find(item => item.fakeid === article.fakeid);
    const title =
      doc.querySelector('.rich_media_title, #activity-name, h1')?.textContent?.replace(/\s+/g, ' ').trim() ||
      metadataDoc
        .querySelector('.rich_media_title, #activity-name, h1, title')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim() ||
      article.title ||
      cached.title ||
      '未命名文章';
    const accountName =
      doc.querySelector('.profile_nickname, #js_name, .nick_name')?.textContent?.replace(/\s+/g, ' ').trim() ||
      metadataDoc.querySelector('.profile_nickname, #js_name, .nick_name')?.textContent?.replace(/\s+/g, ' ').trim() ||
      account?.nickname ||
      article.fakeid ||
      '未知公众号';
    const publishDate =
      (article.update_time ? dayjs.unix(article.update_time).format('YYYY-MM-DD HH:mm:ss') : '') ||
      doc.querySelector('#publish_time, .publish_time')?.textContent?.trim() ||
      metadataDoc.querySelector('.create_time')?.textContent?.trim() ||
      '';

    return { url, article, contentElement, title, accountName, publishDate };
  }

  private async getMarkdownOutputPlanningOptions(): Promise<{
    existing?: ExistingArticleOutput[];
    readExisting?: (relativeDirectory: string) => Promise<{ url?: string | null } | undefined>;
  }> {
    if (this.serverOutputDir) {
      const manifest = await $fetch<{
        success: boolean;
        error?: string;
        records?: Array<{ relativePath: string; url: string }>;
      }>('/api/local/wechat2md-manifest', {
        query: { outputDir: this.serverOutputDir },
      });
      if (!manifest.success) {
        if (/ENOENT|no such file/i.test(manifest.error || '')) return { existing: [] };
        throw new Error(manifest.error || '无法预检 Markdown 输出目录');
      }
      return {
        existing: (manifest.records || []).map(record => ({
          relativeDirectory: record.relativePath.replace(/\\/g, '/').replace(/\/index\.md$/, ''),
          url: record.url,
        })),
      };
    }

    return {
      readExisting: relativeDirectory => this.readBrowserMarkdownOutput(relativeDirectory),
    };
  }

  private async readBrowserMarkdownOutput(relativeDirectory: string): Promise<{ url?: string | null } | undefined> {
    let directory = this.exportRootDirectoryHandle!;
    for (const segment of relativeDirectory.split('/')) {
      try {
        directory = await directory.getDirectoryHandle(segment);
      } catch (error) {
        if ((error as DOMException)?.name === 'NotFoundError') return undefined;
        throw error;
      }
    }

    try {
      const fileHandle = await directory.getFileHandle('index.md');
      const file = await fileHandle.getFile();
      return { url: readArticleUrlFromMarkdown(await file.text()) || null };
    } catch (error) {
      if ((error as DOMException)?.name === 'NotFoundError') return { url: null };
      throw error;
    }
  }

  private findMarkdownContentElement(doc: Document, includeBroadContainers = false): Element | null {
    const selectors = [
      '#js_content',
      '.rich_media_content',
      '#img-content',
      '#js_text_desc',
      '#js_image_desc',
      '#js_common_share_desc',
      '.item_show_type_0',
      '.item_show_type_8',
      '.item_show_type_10',
      '.pay_subscribe_notice',
    ];
    if (includeBroadContainers) {
      selectors.push('.__page_content__', '#js_article');
    }

    for (const selector of selectors) {
      const element = doc.querySelector(selector);
      if (element && this.hasMarkdownContent(element)) {
        return element;
      }
    }
    return null;
  }

  private hasMarkdownContent(element: Element): boolean {
    const text = element.textContent?.replace(/\s+/g, '').trim() || '';
    return text.length > 0 || element.querySelector('img') !== null;
  }

  // 导出 word 文件（并发处理）
  private async exportWordFiles(): Promise<FileExportQueueResult> {
    const total = this.urls.length;
    this.emit('export:total', total);

    const result = await this.processFileExportQueue(this.urls, async url => {
      const filename = await this.exportDirName(url);
      console.log(`开始导出: ${filename}(${url})`);

      const content = await this.getRenderedHTML(url);
      if (!content) return;
      const blob = window.htmlDocx.asBlob(content) as Blob;

      await this.writeFile(filename + '.docx', blob);
    });
    await sleep(100);
    return result;
  }

  /** Generate PDFs through the server-side Puppeteer endpoint. */
  private async exportPdfFiles(): Promise<FileExportQueueResult> {
    this.emit('export:write', this.urls.length);

    const result = await this.processFileExportQueue(
      this.urls,
      async url => {
        const cached = await getHtmlCache(url);
        if (!cached) {
          throw new Error(`文章(url: ${url}) 的 HTML 尚未缓存`);
        }

        const filename = await this.exportDirName(url);
        const html = await cached.file.text();
        const resourceMap = await getResourceMapCache(url);
        const urlmap = new Map<string, string>();
        if (resourceMap) {
          for (const resourceUrl of resourceMap.resources) {
            const resource = await getResourceCache(resourceUrl);
            if (resource) urlmap.set(resourceUrl, await this.blobToDataUrl(resource.file));
          }
        }

        let finalHtml = await this.normalizeHtml(cached, html, urlmap);
        const document = new DOMParser().parseFromString(finalHtml, 'text/html');
        const contentText = document.querySelector('#js_content')?.textContent?.replace(/[\s\u00A0]+/g, '') || '';
        if (!contentText) {
          const renderedHtml = await this.getRenderedHTML(url, true);
          if (renderedHtml) finalHtml = renderedHtml;
        }

        const pdfStyle = `<style>
  html, body { background: white !important; background-color: white !important; }
  p { margin-block: 0.3em !important; }
</style>`;
        finalHtml = finalHtml.replace('</head>', `${pdfStyle}\n</head>`);

        const response = await fetch('/api/web/pdf/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: finalHtml,
        });
        if (!response.ok) {
          throw new Error(`PDF 生成失败: ${response.status} ${response.statusText}`);
        }

        await this.writeFile(`${filename}.pdf`, await response.blob());
      },
      { concurrency: 2, progressEvent: 'export:write:progress' }
    );
    await sleep(100);
    return result;
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * 获取渲染后的完整 HTML 文档
   * 使用 parseCgiDataNew + renderHTMLFromCgiDataNew 管线
   */
  private async getRenderedHTML(url: string, comments = false): Promise<string> {
    const cached = await getHtmlCache(url);
    if (!cached) {
      console.warn(`文章(url: ${url})的 html 还未下载，不能导出其内容`);
      return '';
    }
    const html = await cached.file.text();
    const cgiData = await parseCgiDataNew(html);
    if (!cgiData) {
      console.warn(`文章(url: ${url})无法解析 cgiDataNew，跳过导出`);
      return '';
    }
    return await renderHTMLFromCgiDataNew(cgiData, comments);
  }

  /**
   * 获取渲染后的纯文本内容
   * 使用 parseCgiDataNew + renderTextFromCgiDataNew 管线
   */
  private async getRenderedText(url: string): Promise<string> {
    const cached = await getHtmlCache(url);
    if (!cached) {
      console.warn(`文章(url: ${url})的 html 还未下载，不能导出其内容`);
      return '';
    }
    const html = await cached.file.text();
    const cgiData = await parseCgiDataNew(html);
    if (!cgiData) {
      console.warn(`文章(url: ${url})无法解析 cgiDataNew，跳过导出`);
      return '';
    }
    return renderTextFromCgiDataNew(cgiData);
  }

  static async getHtmlContent(url: string) {
    const exporter = new Exporter([]);
    return exporter.getRenderedHTML(url);
  }

  // 调整最终的 html
  private async normalizeHtml(
    cachedHtml: HtmlAsset,
    html: string,
    urlmap: Map<string, string> = new Map()
  ): Promise<string> {
    // 替换背景图片为本地路径
    // 背景图片无法用选择器选中并修改，因此只能用正则进行匹配替换
    html = html.replaceAll(
      /((?:background|background-image): url\((?:&quot;)?)((?:https?|\/\/)[^)]+?)((?:&quot;)?\))/gs,
      (_, p1, url, p3) => {
        if (urlmap.has(url)) {
          const path = urlmap.get(url)!;
          return `${p1}./${path}${p3}`;
        } else {
          console.warn('背景图片丢失: ', url);
          return `${p1}${url}${p3}`;
        }
      }
    );

    const parser = new DOMParser();
    const document = parser.parseFromString(html, 'text/html');
    const $jsArticleContent = document.querySelector('#js_article')!;

    // #js_content 默认是不可见的(通过js修改为可见)，需要移除该样式
    $jsArticleContent.querySelector('#js_content')?.removeAttribute('style');

    // 删除无用dom元素
    $jsArticleContent.querySelector('#js_top_ad_area')?.remove();
    $jsArticleContent.querySelector('#js_tags_preview_toast')?.remove();
    $jsArticleContent.querySelector('#content_bottom_area')?.remove();
    $jsArticleContent.querySelectorAll('script').forEach(el => {
      el.remove();
    });
    $jsArticleContent.querySelector('#js_pc_qr_code')?.remove();
    $jsArticleContent.querySelector('#wx_stream_article_slide_tip')?.remove();

    let bodyCls = document.body.className;

    // 渲染发布时间
    function __setPubTime(oriTimestamp: number, dom: HTMLElement) {
      const dateObj = new Date(oriTimestamp * 1000);
      const padStart = function padStart(v: number) {
        return '0'.concat(v.toString()).slice(-2);
      };
      const year = dateObj.getFullYear().toString();
      const month = padStart(dateObj.getMonth() + 1);
      const date = padStart(dateObj.getDate());
      const hour = padStart(dateObj.getHours());
      const minute = padStart(dateObj.getMinutes());
      const timeString = ''.concat(hour, ':').concat(minute);
      const dateString = ''.concat(year, '年').concat(month, '月').concat(date, '日');
      const showDate = ''.concat(dateString, ' ').concat(timeString);

      if (dom) {
        dom.innerText = showDate;
      }
    }
    const pubTimeMatchResult = html.match(/var oriCreateTime = '(?<date>\d+)'/);
    if (pubTimeMatchResult && pubTimeMatchResult.groups && pubTimeMatchResult.groups.date) {
      __setPubTime(parseInt(pubTimeMatchResult.groups.date), document.getElementById('publish_time')!);
    }

    // 渲染ip属地
    function getIpWoridng(ipConfig: any) {
      let ipWording = '';
      if (parseInt(ipConfig.countryId, 10) === 156) {
        ipWording = ipConfig.provinceName;
      } else if (ipConfig.countryId) {
        ipWording = ipConfig.countryName;
      }
      return ipWording;
    }
    const ipWrp = document.getElementById('js_ip_wording_wrp')!;
    const ipWording = document.getElementById('js_ip_wording')!;
    const ipConfig = asSafeScriptRecord(extractWechatScriptAssignment(html, 'window.ip_wording'));
    if (ipWrp && ipWording && ipConfig) {
      const ipWordingDisplay = getIpWoridng(ipConfig);
      if (ipWordingDisplay !== '') {
        ipWording.innerHTML = ipWordingDisplay;
        ipWrp.style.display = 'inline-block';
      }
    }

    // 渲染 标题已修改
    function __setTitleModify(isTitleModified: boolean) {
      const wrp = document.getElementById('js_title_modify_wrp')!;
      const titleModifyNode = document.getElementById('js_title_modify')!;
      if (!wrp) return;
      if (isTitleModified) {
        titleModifyNode.innerHTML = '标题已修改';
        wrp.style.display = 'inline-block';
      } else {
        wrp.parentNode?.removeChild(wrp);
      }
    }
    const titleModifiedMatchResult = html.match(/window\.isTitleModified = "(?<data>\d*)" \* 1;/);
    if (titleModifiedMatchResult && titleModifiedMatchResult.groups && titleModifiedMatchResult.groups.data) {
      __setTitleModify(titleModifiedMatchResult.groups.data === '1');
    }

    // 文章引用
    const js_share_source = document.getElementById('js_share_source');
    const contentTpl = document.getElementById('content_tpl');
    if (js_share_source && contentTpl) {
      const html = contentTpl.innerHTML
        .replace(/<img[^>]*>/g, '<p>[图片]</p>')
        .replace(
          /<iframe [^>]*?class=\"res_iframe card_iframe js_editor_card\"[^>]*?data-cardid=[\'\"][^\'\"]*[^>]*?><\/iframe>/gi,
          '<p>[卡券]</p>'
        )
        .replace(/<mpvoice([^>]*?)js_editor_audio([^>]*?)><\/mpvoice>/g, '<p>[语音]</p>')
        .replace(/<mpgongyi([^>]*?)js_editor_gy([^>]*?)><\/mpgongyi>/g, '<p>[公益]</p>')
        .replace(/<qqmusic([^>]*?)js_editor_qqmusic([^>]*?)><\/qqmusic>/g, '<p>[音乐]</p>')
        .replace(/<mpshop([^>]*?)js_editor_shop([^>]*?)><\/mpshop>/g, '<p>[小店]</p>')
        .replace(/<iframe([^>]*?)class=[\'\"][^\'\"]*video_iframe([^>]*?)><\/iframe>/g, '<p>[视频]</p>')
        .replace(/(<iframe[^>]*?js_editor_vote_card[^<]*?<\/iframe>)/gi, '<p>[投票]</p>')
        .replace(/<mp-weapp([^>]*?)weapp_element([^>]*?)><\/mp-weapp>/g, '<p>[小程序]</p>')
        .replace(/<mp-miniprogram([^>]*?)><\/mp-miniprogram>/g, '<p>[小程序]</p>')
        .replace(/<mpproduct([^>]*?)><\/mpproduct>/g, '<p>[商品]</p>')
        .replace(/<mpcps([^>]*?)><\/mpcps>/g, '<p>[商品]</p>');
      const div = document.createElement('div');
      div.innerHTML = html;
      let content = div.innerText;
      content = content.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
      if (content.length > 140) {
        content = content.substr(0, 140) + '...';
      }
      const digest = content.split('\n').map(function (line) {
        return '<p>' + line + '</p>';
      });
      document.getElementById('js_content')!.innerHTML = digest.join('');

      // 替换url
      const sourceURL = js_share_source.getAttribute('data-url');
      if (sourceURL) {
        const link = document.createElement('a');
        link.href = sourceURL;
        link.className = js_share_source.className;
        link.innerHTML = js_share_source.innerHTML;
        js_share_source.replaceWith(link);
      }
    }

    // 渲染阅读量
    const metadata = await getMetadataCache(cachedHtml.url);
    const $interaction_bar = document.querySelector('#js_article_bottom_bar .interaction_bar');
    if ($interaction_bar) {
      $interaction_bar.insertAdjacentHTML(
        'afterbegin',
        '<button id="js_temp_sns_sc_readnum_btn" aria-labelledby="js_a11y_zan_btn_txt readNum" style="-webkit-text-size-adjust:  100% ;" class="sns_opr_btn sns_view_btn weui-wa-hotarea js_wx_tap_highlight wx_tap_link">' +
          `<span class="sns_opr_gap" aria-hidden="true" id="js_bar_readnum_btn">${metadata?.readNum}</span></button>`
      );
    }

    // 渲染留言
    let commentHTML = '';
    if ((preferences.value as Preferences).exportConfig.exportHtmlIncludeComments) {
      commentHTML = await renderComments(cachedHtml.url);
    }

    // 文本分享消息
    const $js_text_desc = $jsArticleContent.querySelector('#js_text_desc') as HTMLElement | null;
    if ($js_text_desc) {
      // 文本分享页面样式
      bodyCls += ' page_share_text';

      // 顶部作者栏
      const textPageData = asSafeScriptRecord(extractWechatScriptAssignment(html, 'window.__QMTPL_SSR_DATA__'));
      if (textPageData) {
        if (typeof textPageData.title === 'string' && !$js_text_desc.innerHTML.trim()) {
          let text = textPageData.title;
          text = text.replace(/\r/g, '').replace(/\n/g, '<br>');
          $js_text_desc.innerHTML = text;
        }
        $jsArticleContent.querySelector('#js_top_profile')?.classList.remove('profile_area_hide');
      }

      // 正文内容
      if (!$js_text_desc.innerHTML.trim()) {
        const textContentMatch = html.match(
          /var\s+TextContentNoEncode\s*=\s*window\.a_value_which_never_exists\s*\|\|\s*(?<value>'[^']*')/s
        );
        const contentMatch = html.match(
          /var\s+ContentNoEncode\s*=\s*window\.a_value_which_never_exists\s*\|\|\s*(?<value>'[^']*')/s
        );

        let desc = parseSafeScriptString(textContentMatch?.groups?.value);
        if (!desc) {
          desc = parseSafeScriptString(contentMatch?.groups?.value);
        }

        if (desc) {
          desc = desc.replace(/\r/g, '').replace(/\n/g, '<br>');
          $js_text_desc.innerHTML = desc;
        }
      }
    }

    // 图片分享消息
    const $js_image_desc = $jsArticleContent.querySelector('#js_image_desc');
    if ($js_image_desc) {
      bodyCls += 'pages_skin_pc page_share_img';

      function decode_html(data: string, encode: boolean) {
        const replace = [
          '&#39;',
          "'",
          '&quot;',
          '"',
          '&nbsp;',
          ' ',
          '&gt;',
          '>',
          '&lt;',
          '<',
          '&yen;',
          '¥',
          '&amp;',
          '&',
        ];
        const replaceReverse = [
          '&',
          '&amp;',
          '¥',
          '&yen;',
          '<',
          '&lt;',
          '>',
          '&gt;',
          ' ',
          '&nbsp;',
          '"',
          '&quot;',
          "'",
          '&#39;',
        ];

        let target = encode ? replaceReverse : replace;
        let str = data;
        for (let i = 0; i < target.length; i += 2) {
          str = str.replace(new RegExp(target[i], 'g'), target[i + 1]);
        }
        return str;
      }

      const imagePageData = asSafeScriptRecord(extractWechatScriptAssignment(html, 'window.__QMTPL_SSR_DATA__'));
      if (imagePageData && typeof imagePageData.desc === 'string') {
        let desc = imagePageData.desc.replace(/\r/g, '').replace(/\n/g, '<br>').replace(/\s/g, '&nbsp;');
        desc = decode_html(desc, false);
        $js_image_desc.innerHTML = desc;

        $jsArticleContent.querySelector('#js_top_profile')?.classList.remove('profile_area_hide');
      }
      const pictureMatchResult = html.match(/(?<code>window\.picture_page_info_list\s*=.+\.slice\(0,\s*20\);)/s);
      if (pictureMatchResult && pictureMatchResult.groups && pictureMatchResult.groups.code) {
        const code = pictureMatchResult.groups.code;
        const withoutSlice = code.replace(/\.slice\(0,\s*20\);\s*$/, ';');
        const pictureValue = extractWechatScriptAssignment(withoutSlice, 'window.picture_page_info_list');
        const pictureUrls = Array.isArray(pictureValue)
          ? pictureValue
              .slice(0, 20)
              .map(item => asSafeScriptRecord(item)?.cdn_url)
              .filter((value): value is string => typeof value === 'string')
          : extractTopLevelPictureUrls(code).slice(0, 20);
        const containerEl = $jsArticleContent.querySelector('#js_share_content_page_hd')!;
        let innerHTML =
          '<div style="display: flex;flex-direction: column;align-items: center;gap: 10px;padding-block: 20px;">';
        for (const pictureUrl of pictureUrls) {
          innerHTML += `<img src="${pictureUrl}" alt="" style="display: block;border: 1px solid gray;border-radius: 5px;max-width: 90%;" />`;
        }
        innerHTML += '</div>';
        containerEl.innerHTML = innerHTML;
      }
    }

    // 替换图片路径为本地路径
    const imgs = document.querySelectorAll<HTMLImageElement>('img');
    for (const img of imgs) {
      const imgUrl = img.getAttribute('src') || img.getAttribute('data-src');
      if (imgUrl && urlmap.has(imgUrl)) {
        img.src = urlmap.get(imgUrl)!;
      }
    }

    // 所有图片都替换完成后，重新解析得到最终的主内容和bottom内容
    const newDocument = parser.parseFromString(document.documentElement.outerHTML, 'text/html');
    const pageContentHTML = newDocument.querySelector('#js_article')!.outerHTML;
    const jsArticleBottomBarHTML = newDocument.querySelector('#js_article_bottom_bar')?.outerHTML;

    // 替换样式路径为本地路径
    let localLinks: string = '';
    const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
    for (const link of links) {
      let linkUrl = link.href;
      if (linkUrl && urlmap.has(linkUrl)) {
        localLinks += `<link rel="stylesheet" href="${urlmap.get(linkUrl)}">\n`;
      }
    }

    return `<!DOCTYPE html>
<html lang="zh_CN">
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=0,viewport-fit=cover">
    <title>${cachedHtml.title}</title>
    ${localLinks}
    <style>
        #page-content,
        #js_article_bottom_bar,
        .__page_content__ {
            max-width: 667px;
            margin: 0 auto;
        }
        img {
            max-width: 100%;
        }
        .sns_opr_btn::before {
            width: 16px;
            height: 16px;
            margin-right: 3px;
        }
    </style>
</head>
<body class="${bodyCls}">
${pageContentHTML}
${jsArticleBottomBarHTML}

<!-- 评论数据 -->
${commentHTML}
</body>
</html>`;
  }

  // 获取文件存储目录
  private async acquireExportDirectoryHandle(): Promise<void> {
    if (this.serverOutputDir) return;
    if (!this.exportRootDirectoryHandle) {
      // @ts-ignore
      this.exportRootDirectoryHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'downloads',
      });
    }
  }

  // 写入文件
  public async writeFile(path: string, file: Blob): Promise<void> {
    if (this.serverOutputDir) {
      const fullPath = `${this.serverOutputDir}/${path}`;
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
      const result = await $fetch<{ success: boolean; error?: string }>('/api/local/write-file', {
        method: 'POST',
        body: { path: fullPath, base64 },
      });
      if (!result.success) {
        throw new Error(result.error || `写入文件失败: ${fullPath}`);
      }
      return;
    }

    const segment = path.split('/');
    const filename = segment[segment.length - 1];
    let directory = this.exportRootDirectoryHandle!;
    if (segment.length > 1) {
      // 创建目录
      for (const name of segment.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(name, { create: true }).catch(e => {
          console.warn(`路径(${path})(${name})中包含非法字符，不能作为文件系统的路径名`);
          throw e;
        });
      }
    }
    const fileHandle = await directory.getFileHandle(filename, { create: true });
    // @ts-ignore
    const writable = await fileHandle.createWritable();
    try {
      // File System Access stages writes and commits the replacement only when close succeeds.
      await writable.write(file);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  // 确定导出文件的目录名
  private async exportDirName(articleUrl: string): Promise<string> {
    let dirnameTpl = (preferences.value as Preferences).exportConfig.dirname;
    const maxlength = (preferences.value as Preferences).exportConfig.maxlength;

    const article = await getArticleByLink(articleUrl);
    const articleUpdateTime = dayjs.unix(article.update_time);
    const account = this.allAccountInfo.find(account => account.fakeid === article.fakeid);
    const accountName = account?.nickname ? filterInvalidFilenameChars(account.nickname) : article.fakeid;
    dirnameTpl = dirnameTpl.replace(/\$\{account}/g, accountName);

    dirnameTpl = dirnameTpl.replace(/\$\{title}/g, filterInvalidFilenameChars(article.title));
    dirnameTpl = dirnameTpl.replace(/\$\{aid}/g, article.aid);
    dirnameTpl = dirnameTpl.replace(/\$\{author}/g, article.author_name);
    dirnameTpl = dirnameTpl.replace(/\$\{YYYY}/g, articleUpdateTime.format('YYYY'));
    dirnameTpl = dirnameTpl.replace(/\$\{MM}/g, articleUpdateTime.format('MM'));
    dirnameTpl = dirnameTpl.replace(/\$\{DD}/g, articleUpdateTime.format('DD'));
    dirnameTpl = dirnameTpl.replace(/\$\{HH}/g, articleUpdateTime.format('HH'));
    dirnameTpl = dirnameTpl.replace(/\$\{mm}/g, articleUpdateTime.format('mm'));

    if (maxlength) {
      return dirnameTpl.slice(0, maxlength);
    }
    return dirnameTpl;
  }
}

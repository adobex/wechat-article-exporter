import toastFactory from '~/composables/toast';
import type { FileExportQueueResult } from '~/utils/download/Exporter';

export type Wechat2mdMode = 'lite' | 'playwright';
export type MdImageMode = 'indexed' | 'base64' | 'cdn';
export type ExportFormat = 'excel' | 'json' | 'html' | 'text' | 'markdown' | 'word' | 'pdf';
export type Wechat2mdMetadata = {
  title?: string;
  accountName?: string;
  canonicalUrl?: string;
  publishDate?: string;
  markdownExported?: boolean;
  contentCached?: boolean;
};
export type Wechat2mdMetadataMap = Record<string, Wechat2mdMetadata | undefined>;
export interface RunDownloadOptions {
  forceMarkdown?: boolean;
  requireCacheForMarkdown?: boolean;
}
export interface RunWechat2mdResult {
  successCount: number;
  failCount: number;
  skippedCount: number;
  successUrls: string[];
}

const LOCAL_OUTPUT_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function resolveLocalOutputDirectory(
  configuredOutputDir: string | null | undefined,
  hostname: string | null | undefined
): string | undefined {
  const outputDir = String(configuredOutputDir || '').trim();
  const normalizedHostname = String(hostname || '')
    .trim()
    .toLowerCase();
  return outputDir && LOCAL_OUTPUT_HOSTS.has(normalizedHostname) ? outputDir : undefined;
}

function getFileExportResult(error: unknown): FileExportQueueResult | undefined {
  const result = (error as { result?: FileExportQueueResult })?.result;
  if (result && Array.isArray(result.successUrls) && Array.isArray(result.failedUrls)) {
    return result;
  }
}

export const WECHAT2MD_MODE_LABELS: Record<Wechat2mdMode, string> = {
  lite: '轻量版',
  playwright: 'Playwright',
};

export const MD_IMAGE_MODE_LABELS: Record<MdImageMode, string> = {
  indexed: '图片下载到本地',
  base64: '图片 Base64 内嵌',
  cdn: '保留 CDN 链接',
};

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  excel: 'Excel',
  json: 'JSON',
  html: 'HTML',
  text: 'Txt',
  markdown: 'Markdown',
  word: 'Word',
  pdf: 'PDF',
};

export default function useDownloadOptions() {
  const toast = toastFactory();
  const runtimeConfig = useRuntimeConfig();
  const outputDir = resolveLocalOutputDirectory(
    runtimeConfig.public.outputDir as string | undefined,
    typeof window === 'undefined' ? '' : window.location.hostname
  );

  const wechat2mdMode = ref<Wechat2mdMode>('lite');
  const mdImageMode = ref<MdImageMode>('cdn');
  const exportFormat = ref<ExportFormat>('markdown');
  const wechat2mdLoading = ref(false);

  const {
    loading: exportBtnLoading,
    phase: exportPhase,
    completed_count: exportCompletedCount,
    total_count: exportTotalCount,
    exportFile,
  } = useExporter({ serverOutputDir: outputDir, mdImageMode });

  async function runWechat2md(
    urls: string[],
    metadataByUrl: Wechat2mdMetadataMap = {},
    options: RunDownloadOptions = {}
  ): Promise<RunWechat2mdResult | undefined> {
    if (urls.length === 0) {
      toast.info('提示', '请先选择至少一篇文章');
      return;
    }
    wechat2mdLoading.value = true;
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;
    const successUrls: string[] = [];
    const mode = wechat2mdMode.value;
    const label = `wechat2md (${WECHAT2MD_MODE_LABELS[mode]})`;
    const targetUrls = options.forceMarkdown
      ? urls
      : urls.filter(url => {
          if (metadataByUrl[url]?.markdownExported) {
            skippedCount++;
            return false;
          }
          return true;
        });

    try {
      if (targetUrls.length === 0) {
        toast.info('Markdown已导出', `已跳过 ${skippedCount} 篇；如需重下，请使用“覆盖导出”。`);
        return { successCount, failCount, skippedCount, successUrls };
      }
      if (!outputDir) {
        failCount = targetUrls.length;
        toast.warning(label, '本地服务端输出未启用，请先缓存正文并使用浏览器目录选择器导出');
        return { successCount, failCount, skippedCount, successUrls };
      }

      for (const url of targetUrls) {
        try {
          const metadata = { ...(metadataByUrl[url] || {}) };
          delete metadata.markdownExported;
          delete metadata.contentCached;
          const data = await $fetch<{ success: boolean; filepath?: string; error?: string }>('/api/local/wechat2md', {
            method: 'POST',
            body: { url, imageMode: mdImageMode.value, mode, outputDir, ...metadata },
          });
          if (data.success) {
            successCount++;
            successUrls.push(url);
          } else {
            failCount++;
            console.warn(`${label} 失败: ${url}`, data.error);
          }
        } catch (e: any) {
          failCount++;
          console.warn(`${label} 异常: ${url}`, e?.message);
        }
      }

      if (successCount > 0) {
        const skipText = skippedCount > 0 ? `，跳过 ${skippedCount} 篇已导出` : '';
        toast.success(label, `成功 ${successCount} 篇${skipText}，输出到 ${outputDir}/`);
      } else if (skippedCount > 0) {
        toast.info('Markdown已导出', `已跳过 ${skippedCount} 篇；如需重下，请使用“覆盖导出”。`);
      }
      if (failCount > 0) {
        toast.warning(label, `失败 ${failCount} 篇`);
      }
      return { successCount, failCount, skippedCount, successUrls };
    } finally {
      wechat2mdLoading.value = false;
    }
  }

  async function runMarkdownDownload(
    urls: string[],
    metadataByUrl: Wechat2mdMetadataMap = {},
    options: RunDownloadOptions = {}
  ): Promise<RunWechat2mdResult | undefined> {
    let skippedCount = 0;
    const targetUrls = options.forceMarkdown
      ? urls
      : urls.filter(url => {
          if (metadataByUrl[url]?.markdownExported) {
            skippedCount++;
            return false;
          }
          return true;
        });

    const result: RunWechat2mdResult = {
      successCount: 0,
      failCount: 0,
      skippedCount,
      successUrls: [],
    };

    if (targetUrls.length === 0) {
      toast.info('Markdown已导出', `已跳过 ${skippedCount} 篇；如需重下，请使用“覆盖导出”。`);
      return result;
    }

    const cachedUrls = targetUrls.filter(url => metadataByUrl[url]?.contentCached);
    const remoteUrls = targetUrls.filter(url => !metadataByUrl[url]?.contentCached);

    if (cachedUrls.length > 0) {
      try {
        const fileResult = await exportFile('markdown', cachedUrls, 0);
        const successUrls = fileResult?.successUrls || cachedUrls;
        result.successCount += successUrls.length;
        result.successUrls.push(...successUrls);
      } catch (error) {
        const fileResult = getFileExportResult(error);
        if (fileResult) {
          result.successCount += fileResult.successUrls.length;
          result.failCount += fileResult.failedUrls.length;
          result.successUrls.push(...fileResult.successUrls);
        } else {
          result.failCount += cachedUrls.length;
        }
      }
    }

    if (remoteUrls.length > 0) {
      if (options.requireCacheForMarkdown) {
        result.failCount += remoteUrls.length;
        toast.warning('Markdown导出未完成', `${remoteUrls.length} 篇正文未缓存成功，未导出`);
      } else {
        const remoteResult = await runWechat2md(remoteUrls, metadataByUrl, { forceMarkdown: true });
        if (remoteResult) {
          result.successCount += remoteResult.successCount;
          result.failCount += remoteResult.failCount;
          result.successUrls.push(...remoteResult.successUrls);
        }
      }
    } else if (skippedCount > 0 && result.successCount > 0) {
      toast.info('Markdown已导出', `已跳过 ${skippedCount} 篇已导出文章`);
    }

    return result;
  }

  function runDownload(
    urls: string[],
    contentNotDownloadedCount = 0,
    metadataByUrl: Wechat2mdMetadataMap = {},
    options: RunDownloadOptions = {}
  ) {
    if (urls.length === 0) {
      toast.info('提示', '请先选择至少一篇文章');
      return;
    }
    if (exportFormat.value === 'markdown') {
      return runMarkdownDownload(urls, metadataByUrl, options);
    }
    const needsContent = ['html', 'text', 'word', 'pdf'].includes(exportFormat.value);
    return exportFile(exportFormat.value, urls, needsContent ? contentNotDownloadedCount : 0);
  }

  return {
    wechat2mdMode,
    mdImageMode,
    exportFormat,
    wechat2mdLoading,
    exportBtnLoading,
    exportPhase,
    exportCompletedCount,
    exportTotalCount,
    runDownload,
    exportFile,
  };
}

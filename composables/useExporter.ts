import { formatElapsedTime } from '#shared/utils/helpers';
import toastFactory from '~/composables/toast';
import { Exporter, type FileExportQueueResult } from '~/utils/download/Exporter';
import type { ExporterStatus } from '~/utils/download/types';

type ExportType = 'excel' | 'json' | 'html' | 'txt' | 'markdown' | 'word' | 'pdf';

interface ExportConfig {
  label: string;
  beginPhase: string;
  events: (ctx: {
    phase: Ref<string>;
    completed_count: Ref<number>;
    total_count: Ref<number>;
  }) => Record<string, (...args: any[]) => void>;
}

const EXPORT_CONFIGS: Record<ExportType, ExportConfig> = {
  excel: {
    label: 'Excel',
    beginPhase: '导出中',
    events: ctx => ({
      'export:begin': () => {
        ctx.phase.value = '导出中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = 0;
      },
      'export:total': (total: number) => {
        ctx.total_count.value = total;
      },
      'export:progress': (num: number) => {
        ctx.completed_count.value = num;
      },
    }),
  },
  json: {
    label: 'Json',
    beginPhase: '导出中',
    events: ctx => ({
      'export:begin': () => {
        ctx.phase.value = '导出中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = 0;
      },
      'export:total': (total: number) => {
        ctx.total_count.value = total;
      },
      'export:progress': (num: number) => {
        ctx.completed_count.value = num;
      },
    }),
  },
  html: {
    label: 'HTML',
    beginPhase: '资源解析中',
    events: ctx => ({
      'export:begin': () => {
        ctx.phase.value = '资源解析中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = 0;
      },
      'export:download': (total: number) => {
        ctx.phase.value = '资源下载中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = total;
      },
      'export:download:progress': (_url: string, _success: boolean, status: ExporterStatus) => {
        ctx.completed_count.value = status.completed.length;
      },
      'export:write': (total: number) => {
        ctx.phase.value = '文件写入中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = total;
      },
      'export:write:progress': (index: number) => {
        ctx.completed_count.value = index;
      },
    }),
  },
  txt: {
    label: 'Txt',
    beginPhase: '资源解析中',
    events: ctx => ({
      'export:begin': () => {
        ctx.phase.value = '资源解析中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = 0;
      },
      'export:total': (total: number) => {
        ctx.phase.value = '导出中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = total;
      },
      'export:progress': (index: number) => {
        ctx.completed_count.value = index;
      },
    }),
  },
  markdown: {
    label: 'Markdown',
    beginPhase: '资源解析中',
    events: ctx => ({
      'export:begin': () => {
        ctx.phase.value = '资源解析中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = 0;
      },
      'export:total': (total: number) => {
        ctx.phase.value = '导出中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = total;
      },
      'export:progress': (index: number) => {
        ctx.completed_count.value = index;
      },
    }),
  },
  word: {
    label: 'Word',
    beginPhase: '资源解析中',
    events: ctx => ({
      'export:begin': () => {
        ctx.phase.value = '资源解析中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = 0;
      },
      'export:total': (total: number) => {
        ctx.phase.value = '导出中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = total;
      },
      'export:progress': (index: number) => {
        ctx.completed_count.value = index;
      },
    }),
  },
  pdf: {
    label: 'PDF',
    beginPhase: '资源解析中',
    events: ctx => ({
      'export:begin': () => {
        ctx.phase.value = '资源解析中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = 0;
      },
      'export:download': (total: number) => {
        ctx.phase.value = '资源下载中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = total;
      },
      'export:download:progress': (_url: string, _success: boolean, status: ExporterStatus) => {
        ctx.completed_count.value = status.completed.length;
      },
      'export:write': (total: number) => {
        ctx.phase.value = 'PDF 生成中';
        ctx.completed_count.value = 0;
        ctx.total_count.value = total;
      },
      'export:write:progress': (index: number) => {
        ctx.completed_count.value = index;
      },
    }),
  },
};

export default (opts: { serverOutputDir?: string; mdImageMode?: Ref<'indexed' | 'base64' | 'cdn'> } = {}) => {
  const toast = toastFactory();

  const loading = ref(false);
  const phase = ref('导出中');
  const completed_count = ref(0);
  const total_count = ref(0);

  function createExporter(urls: string[]) {
    const exporter = new Exporter(urls);
    if (opts.serverOutputDir) {
      exporter.serverOutputDir = opts.serverOutputDir;
    }
    if (opts.mdImageMode) {
      exporter.mdImageMode = opts.mdImageMode.value;
    }
    return exporter;
  }

  async function runExport(type: ExportType, urls: string[]): Promise<FileExportQueueResult | undefined> {
    if (urls.length === 0) {
      toast.warning('提示', '请先选择文章');
      return;
    }

    const config = EXPORT_CONFIGS[type];
    const manager = createExporter(urls);

    const eventHandlers = config.events({ phase, completed_count, total_count });
    for (const [event, handler] of Object.entries(eventHandlers)) {
      manager.on(event, handler);
    }
    let elapsedText = '';
    manager.on('export:finish', (seconds: number) => {
      elapsedText = formatElapsedTime(seconds);
      console.debug('耗时:', elapsedText);
    });

    try {
      loading.value = true;
      const result = await manager.startExport(type);
      toast.success(`${config.label} 导出完成`, `本次导出耗时 ${elapsedText}`);
      return result;
    } catch (error) {
      console.error('导出任务失败:', error);
      alert((error as Error).message);
      throw error;
    } finally {
      loading.value = false;
    }
  }

  const needsContentFormats = new Set<string>(['html', 'text', 'markdown', 'word', 'pdf']);

  function exportFile(
    type: 'excel' | 'json' | 'html' | 'text' | 'markdown' | 'word' | 'pdf',
    urls: string[],
    contentNotDownloadedCount?: number
  ) {
    if (needsContentFormats.has(type) && contentNotDownloadedCount) {
      toast.warning('提示', `有 ${contentNotDownloadedCount} 篇文章尚未缓存正文，请先缓存正文后再导出`);
      return;
    }

    const exportType: ExportType = type === 'text' ? 'txt' : type;
    return runExport(exportType, urls);
  }

  return {
    loading,
    phase,
    completed_count,
    total_count,
    exportFile,
  };
};

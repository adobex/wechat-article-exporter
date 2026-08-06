<script setup lang="ts">
import type {
  ColDef,
  FilterChangedEvent,
  GetRowIdParams,
  GridApi,
  GridOptions,
  GridReadyEvent,
  ICellRendererParams,
  SelectionChangedEvent,
  ValueFormatterParams,
  ValueGetterParams,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { defu } from 'defu';
import type { PreviewArticle } from '#components';
import { durationToSeconds, formatItemShowType, formatTimeStamp, sleep } from '#shared/utils/helpers';
import { validateHTMLContent } from '#shared/utils/html';
import GridAlbum from '~/components/grid/Album.vue';
import GridArticleActions from '~/components/grid/ArticleActions.vue';
import GridCoverTooltip from '~/components/grid/CoverTooltip.vue';
import GridStatusBar from '~/components/grid/StatusBar.vue';
import AccountSelectorForArticle from '~/components/selector/AccountSelectorForArticle.vue';
import {
  EXPORT_FORMAT_LABELS,
  MD_IMAGE_MODE_LABELS,
  WECHAT2MD_MODE_LABELS,
  type Wechat2mdMetadataMap,
} from '~/composables/useDownloadOptions';
import { isDev, websiteName } from '~/config';
import { sharedGridOptions } from '~/config/shared-grid-options';
import { articleDeleted, getArticleCache, updateArticleStatus } from '~/store/v2/article';
import { getCommentCache } from '~/store/v2/comment';
import { getDebugCache } from '~/store/v2/debug';
import { getHtmlCache } from '~/store/v2/html';
import { type MpAccount } from '~/store/v2/info';
import { getMetadataCache, type Metadata } from '~/store/v2/metadata';
import type { Preferences } from '~/types/preferences';
import type { AppMsgExWithFakeID } from '~/types/types';
import type { ArticleMetadata } from '~/utils/download/types';
import { createBooleanColumnFilterParams, createDateColumnFilterParams } from '~/utils/grid';

useHead({
  title: `文章下载 | ${websiteName}`,
});

// 当前页面的数据模型
interface Article extends AppMsgExWithFakeID, Partial<ArticleMetadata> {
  /**
   * 文章正文是否已缓存
   */
  contentDownload: boolean;

  /**
   * 留言内容是否已同步
   */
  commentDownload: boolean;

  /**
   * 是否已经通过 wechat2md 导出为本地 Markdown
   */
  markdownExported: boolean;
  markdownPath?: string;
  articleDir?: string;
}

interface Wechat2mdManifestEntry {
  title: string;
  accountName: string;
  publishDate: string;
  url: string;
  filepath: string;
  articleDir: string;
  relativePath: string;
  mtimeMs: number;
}

let globalRowData: Article[] = [];

const columnDefs = ref<ColDef[]>([
  {
    headerName: 'ID',
    field: 'aid',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '链接',
    field: 'link',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    minWidth: 150,
    initialHide: true,
    cellClass: 'font-mono',
  },
  {
    headerName: '标题',
    field: 'title',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    tooltipField: 'title',
    minWidth: 200,
  },
  {
    headerName: '封面',
    field: 'cover',
    sortable: false,
    filter: false,
    cellRenderer: (params: ICellRendererParams) => {
      return `<img alt="" src="${params.value}" style="height: 40px; width: 40px; object-fit: cover;" />`;
    },
    tooltipField: 'cover',
    tooltipComponent: GridCoverTooltip,
    minWidth: 80,
    hide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '摘要',
    field: 'digest',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    tooltipField: 'digest',
    minWidth: 200,
    initialHide: true,
  },
  {
    headerName: '创建时间',
    field: 'create_time',
    valueFormatter: p => formatTimeStamp(p.value),
    filter: 'agDateColumnFilter',
    filterParams: createDateColumnFilterParams(),
    filterValueGetter: (params: ValueGetterParams) => {
      return new Date(params.getValue('create_time') * 1000);
    },
    minWidth: 180,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '发布时间',
    field: 'update_time',
    valueFormatter: p => formatTimeStamp(p.value),
    filter: 'agDateColumnFilter',
    filterParams: createDateColumnFilterParams(),
    filterValueGetter: (params: ValueGetterParams) => {
      return new Date(params.getValue('update_time') * 1000);
    },
    minWidth: 180,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '是否已删除',
    field: 'is_deleted',
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('已删除', '未删除'),
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '文章状态',
    field: '_status',
    valueFormatter: p => p.value,
    filter: 'agSetColumnFilter',
    filterParams: {
      valueFormatter: (p: ValueFormatterParams) => p.value,
    },
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '正文已缓存',
    field: 'contentDownload',
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('已缓存', '未缓存'),
    minWidth: 150,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: 'Markdown已导出',
    field: 'markdownExported',
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('已导出', '未导出'),
    minWidth: 150,
    cellClass: 'flex justify-center items-center',
  },
  {
    field: 'commentDownload',
    headerName: '留言已同步',
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('已同步', '未同步'),
    minWidth: 150,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '阅读',
    field: 'readNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '点赞',
    field: 'oldLikeNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '分享',
    field: 'shareNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '喜欢',
    field: 'likeNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '留言',
    field: 'commentNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    field: 'author_name',
    headerName: '作者',
    cellDataType: 'text',
    filter: 'agSetColumnFilter',
    minWidth: 150,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '是否原创',
    valueGetter: p => p.data && p.data.copyright_stat === 1 && p.data.copyright_type === 1,
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('原创', '非原创'),
    minWidth: 150,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '是否付费',
    field: 'is_pay_subscribe',
    valueGetter: p => p.data && p.data.is_pay_subscribe === 1,
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('付费', '免费'),
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '付费金额',
    field: 'wecoin_count',
    valueFormatter: p => (p.value ? `${p.value} 微币` : ''),
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 120,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '文章类型',
    field: 'item_show_type',
    valueFormatter: p => formatItemShowType(p.value),
    filter: 'agSetColumnFilter',
    filterParams: {
      valueFormatter: (p: ValueFormatterParams) => formatItemShowType(p.value),
    },
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '媒体时长',
    field: 'media_duration',
    valueGetter: params => durationToSeconds(params.data.media_duration), // 用于排序和过滤
    valueFormatter: params => params.data.media_duration,
    filter: 'agNumberColumnFilter',
    comparator: (a, b) => a - b,
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '所属合集',
    field: 'appmsg_album_infos',
    cellRenderer: GridAlbum,
    sortable: false,
    filter: false,
    valueFormatter: p => p.value.map((album: any) => album.title).join(','),
    minWidth: 150,
    initialHide: true,
  },
  {
    headerName: 'Markdown路径',
    field: 'markdownPath',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    minWidth: 260,
    initialHide: true,
    cellClass: 'font-mono',
  },
  {
    headerName: '操作',
    field: 'link',
    sortable: false,
    filter: false,
    cellRenderer: GridArticleActions,
    cellRendererParams: {
      onPreview: (params: ICellRendererParams) => {
        preview(params.data);
      },
      onGotoLink: (params: ICellRendererParams) => {
        window.open(params.value, '_blank');
      },
    },
    maxWidth: 100,
    pinned: 'right',
    cellClass: 'flex justify-center items-center',
  },
]);

// 注意，`defu`函数最左边的参数优先级最高
const gridOptions: GridOptions = defu(
  {
    getRowId: (params: GetRowIdParams) => `${params.data.fakeid}:${params.data.aid}`,
    isExternalFilterPresent: () => normalizedTitleKeyword().length > 0,
    doesExternalFilterPass: node => {
      const keyword = normalizedTitleKeyword();
      if (!keyword) return true;
      return normalizeText(node.data?.title).toLowerCase().includes(keyword);
    },
    statusBar: {
      statusPanels: [
        {
          statusPanel: GridStatusBar,
          align: 'left',
        },
      ],
    },
  },
  sharedGridOptions
);

const gridApi = shallowRef<GridApi | null>(null);
const titleKeyword = ref('');
function onGridReady(params: GridReadyEvent) {
  gridApi.value = params.api;

  restoreColumnState();
  applyTitleKeywordFilter();
}

function onColumnStateChange() {
  if (gridApi.value) {
    saveColumnState();
  }
}
function saveColumnState() {
  const state = gridApi.value?.getColumnState();
  localStorage.setItem('agGridColumnState', JSON.stringify(state));
}

function restoreColumnState() {
  const stateStr = localStorage.getItem('agGridColumnState');
  if (stateStr) {
    const state = JSON.parse(stateStr);
    gridApi.value?.applyColumnState({
      state,
      applyOrder: true,
    });
  }
}

function onFilterChanged(event: FilterChangedEvent) {
  event.api.deselectAll();
}

function normalizedTitleKeyword() {
  return normalizeText(titleKeyword.value).toLowerCase();
}

function applyTitleKeywordFilter() {
  gridApi.value?.onFilterChanged();
}

function clearTitleKeyword() {
  titleKeyword.value = '';
}

watch(titleKeyword, () => {
  applyTitleKeywordFilter();
});

const preferences = usePreferences();
const hideDeleted = computed(() => (preferences.value as unknown as Preferences).hideDeleted);

const previewArticleRef = ref<typeof PreviewArticle | null>(null);

function preview(article: Article) {
  previewArticleRef.value!.open(article);
}

const loading = ref(false);
const localExportLoading = ref(false);
const localExportLoaded = ref(false);
const localExportRecords = shallowRef<Wechat2mdManifestEntry[]>([]);

// 只能选择单个账号
const selectedAccount = ref<MpAccount | undefined>();

watch(selectedAccount, newVal => {
  if (!newVal) {
    globalRowData = [];
    gridApi.value?.setGridOption('rowData', globalRowData);
    return;
  }
  switchTableData(newVal.fakeid).catch(() => {});
});

async function switchTableData(fakeid: string) {
  loading.value = true;
  await loadLocalExportRecords();
  const articles: Article[] = [];
  const data = await getArticleCache(fakeid, Math.floor(Date.now() / 1000));
  for (const article of data) {
    const contentDownload = (await getHtmlCache(article.link)) !== undefined;
    const commentDownload = (await getCommentCache(article.link)) !== undefined;
    const metadata = await getMetadataCache(article.link);
    const localExport = findLocalExportRecord(article);
    if (metadata) {
      articles.push({
        ...metadata,
        ...article,
        contentDownload: contentDownload,
        commentDownload: commentDownload,
        markdownExported: !!localExport,
        markdownPath: localExport?.filepath,
        articleDir: localExport?.articleDir,
      });
    } else {
      articles.push({
        ...article,
        contentDownload: contentDownload,
        commentDownload: commentDownload,
        markdownExported: !!localExport,
        markdownPath: localExport?.filepath,
        articleDir: localExport?.articleDir,
      });
    }
  }
  await sleep(200);
  globalRowData = articles.filter(article => (hideDeleted.value ? !article.is_deleted : true));
  gridApi.value?.setGridOption('rowData', globalRowData);
  applyTitleKeywordFilter();
  loading.value = false;
}

async function loadLocalExportRecords(force = false) {
  if (localExportLoaded.value && !force) return;

  localExportLoading.value = true;
  try {
    const data = await $fetch<{
      success: boolean;
      records: Wechat2mdManifestEntry[];
    }>('/api/local/wechat2md-manifest');
    localExportRecords.value = data.success ? data.records || [] : [];
    localExportLoaded.value = data.success;
  } catch (error) {
    console.warn('读取本地 Markdown 导出记录失败', error);
    localExportRecords.value = [];
    localExportLoaded.value = false;
  } finally {
    localExportLoading.value = false;
  }
}

function normalizeText(value?: string | null) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrlForMatch(value?: string | null) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    return url.toString();
  } catch {
    return normalizeText(value);
  }
}

const localExportByUrl = computed(() => {
  const index = new Map<string, Wechat2mdManifestEntry>();
  for (const record of localExportRecords.value) {
    const key = normalizeUrlForMatch(record.url);
    if (key) index.set(key, record);
  }
  return index;
});

const localExportByAccountTitle = computed(() => {
  const index = new Map<string, Wechat2mdManifestEntry>();
  for (const record of localExportRecords.value) {
    const accountName = normalizeText(record.accountName);
    const title = normalizeText(record.title);
    if (accountName && title) {
      index.set(`${accountName}\u0000${title}`, record);
    }
  }
  return index;
});

const localExportByUniqueTitle = computed(() => {
  const index = new Map<string, Wechat2mdManifestEntry>();
  const duplicated = new Set<string>();
  for (const record of localExportRecords.value) {
    const title = normalizeText(record.title);
    if (!title) continue;
    if (index.has(title)) {
      duplicated.add(title);
    } else {
      index.set(title, record);
    }
  }
  for (const title of duplicated) {
    index.delete(title);
  }
  return index;
});

function findLocalExportRecord(article: Pick<Article, 'link' | 'title'>): Wechat2mdManifestEntry | undefined {
  const urlMatch = localExportByUrl.value.get(normalizeUrlForMatch(article.link));
  if (urlMatch) return urlMatch;

  const title = normalizeText(article.title);
  const accountName = normalizeText(selectedAccount.value?.nickname);
  if (accountName && title) {
    const accountTitleMatch = localExportByAccountTitle.value.get(`${accountName}\u0000${title}`);
    if (accountTitleMatch) return accountTitleMatch;
  }

  return localExportByUniqueTitle.value.get(title);
}

function refreshLocalExportStatus() {
  for (const article of globalRowData) {
    const localExport = findLocalExportRecord(article);
    article.markdownExported = !!localExport;
    article.markdownPath = localExport?.filepath;
    article.articleDir = localExport?.articleDir;
  }
  gridApi.value?.setGridOption('rowData', globalRowData);
  applyTitleKeywordFilter();
}

async function reloadLocalExportStatus() {
  await loadLocalExportRecords(true);
  refreshLocalExportStatus();
}

function updateRow(article: Article) {
  const rowNode = gridApi.value?.getRowNode(`${article.fakeid}:${article.aid}`);
  if (rowNode) {
    rowNode.updateData(article);
  }
}

const selectedArticles = shallowRef<Article[]>([]);
function onSelectionChanged(event: SelectionChangedEvent) {
  selectedArticles.value = (event.selectedNodes || []).map(node => node.data);
}
const selectedArticleUrls = computed(() => {
  return selectedArticles.value.map(article => article.link);
});
const selectedWechat2mdMetadata = computed<Wechat2mdMetadataMap>(() => {
  const accountName = selectedAccount.value?.nickname?.trim();
  return Object.fromEntries(
    selectedArticles.value.map(article => [
      article.link,
      {
        title: article.title,
        accountName,
        canonicalUrl: article.canonical_link,
        publishDate: article.update_time ? formatTimeStamp(article.update_time) : undefined,
        markdownExported: article.markdownExported,
        contentCached: article.contentDownload,
      },
    ])
  );
});
const contentNotDownloadedCount = computed(() => {
  return selectedArticles.value.filter(article => !article.contentDownload).length;
});

const {
  loading: downloadBtnLoading,
  completed_count: downloadCompletedCount,
  total_count: downloadTotalCount,
  download,
  stop: stopDownload,
} = useDownloader({
  onContent(url: string) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article.contentDownload = true;
      article._status = '正常';
      updateRow(article);

      updateArticleStatus(url, '正常');

      // 修复之前代码逻辑错误导致的数据库状态被误设置为【已删除】
      article.is_deleted = false;
      articleDeleted(url, false);
    } else {
      console.warn(`${url} not found in table data when update contentDownload`);
    }
  },
  onStatusChange(url: string, status: string) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article._status = status;
      updateRow(article);

      updateArticleStatus(url, status);
    }
  },
  onDelete(url: string) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article.is_deleted = true;
      article._status = '已删除';
      updateRow(article);

      updateArticleStatus(url, '已删除');
      articleDeleted(url);
    }
  },
  onMetadata(url: string, metadata: Metadata) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article.readNum = metadata.readNum;
      article.oldLikeNum = metadata.oldLikeNum;
      article.shareNum = metadata.shareNum;
      article.likeNum = metadata.likeNum;
      article.commentNum = metadata.commentNum;

      if ((preferences.value as unknown as Preferences).downloadConfig.metadataOverrideContent) {
        // 如果同步阅读量时覆盖正文缓存，则更新相关字段
        article.contentDownload = true;
        article._status = '正常';
        updateArticleStatus(url, '正常');

        // 修复之前代码逻辑错误导致的数据库状态被误设置为【已删除】
        article.is_deleted = false;
        articleDeleted(url, false);
      }

      updateRow(article);
    } else {
      console.warn(`${url} not found in table data when update metadata`);
    }
  },
  onComment(url: string) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article.commentDownload = true;
      updateRow(article);
    } else {
      console.warn(`${url} not found in table data when update commentDownload`);
    }
  },
});

const {
  wechat2mdMode,
  mdImageMode,
  exportFormat,
  wechat2mdLoading,
  exportBtnLoading,
  exportPhase,
  exportCompletedCount,
  exportTotalCount,
  runDownload,
} = useDownloadOptions();

const exportActionLabel = computed(() => {
  return exportFormat.value === 'markdown' ? '导出未导出' : '导出文件';
});

function getMarkdownTargetArticles(forceMarkdown: boolean) {
  if (exportFormat.value !== 'markdown') return [];
  return selectedArticles.value.filter(article => forceMarkdown || !article.markdownExported);
}

async function ensureMarkdownContentCached(forceMarkdown: boolean) {
  const missing = getMarkdownTargetArticles(forceMarkdown).filter(article => !article.contentDownload);
  if (missing.length === 0) return;

  await download(
    'html',
    missing.map(article => article.link)
  );
}

async function runSelectedDownload(forceMarkdown: boolean | Event = false) {
  const shouldForceMarkdown = forceMarkdown === true;
  if (exportFormat.value === 'markdown') {
    await ensureMarkdownContentCached(shouldForceMarkdown);
  }
  await runDownload(selectedArticleUrls.value, contentNotDownloadedCount.value, selectedWechat2mdMetadata.value, {
    forceMarkdown: shouldForceMarkdown,
    requireCacheForMarkdown: true,
  });
  if (exportFormat.value === 'markdown') {
    await reloadLocalExportStatus();
  }
}

async function debug() {
  const cache = await getDebugCache('https://mp.weixin.qq.com/s/0IEaqpJIBGykHFKqj-7xqw');
  console.log(cache);
  if (cache) {
    const html = await cache.file.text();
    console.log(html);
    const result = validateHTMLContent(html);
    console.log(result);
  }
}

const copied = ref(false);
function copyWechatLink() {
  const link = `https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=${selectedAccount.value?.fakeid}&scene=124#wechat_redirect`;
  navigator.clipboard.writeText(link);

  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 1000);
}
</script>

<template>
  <div class="h-full">
    <Teleport defer to="#title">
      <h1 class="text-[28px] leading-[34px] text-slate-12 dark:text-slate-50 font-bold">文章下载</h1>
    </Teleport>

    <div class="flex flex-col h-full divide-y divide-gray-200">
      <!-- 顶部筛选与操作区 -->
      <header class="flex flex-col gap-3 px-3 py-2">
        <div class="flex flex-col gap-2 md:flex-row md:items-center">
          <AccountSelectorForArticle v-model="selectedAccount" class="w-full shrink-0 md:w-80" />
          <UInput
            v-model="titleKeyword"
            icon="i-heroicons-magnifying-glass-20-solid"
            color="white"
            class="w-full min-w-0 md:w-96"
            placeholder="按标题关键词过滤"
            :disabled="!selectedAccount"
            aria-label="按标题关键词过滤"
            @keydown.esc="clearTitleKeyword"
          >
            <template #trailing>
              <UButton
                v-if="titleKeyword"
                color="gray"
                variant="ghost"
                icon="i-heroicons-x-mark-20-solid"
                size="xs"
                :padded="false"
                aria-label="清空标题关键词"
                @mousedown.prevent
                @click="clearTitleKeyword"
              />
            </template>
          </UInput>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UButton v-if="downloadBtnLoading" color="black" class="shrink-0 whitespace-nowrap" @click="stopDownload">
            停止
          </UButton>
          <ButtonGroup
            class="shrink-0"
            :items="[
              { label: '缓存正文', event: 'download-article-html' },
              { label: '同步阅读量 (需要Credential)', event: 'download-article-metadata' },
              { label: '同步留言 (需要Credential)', event: 'download-article-comment' },
            ]"
            @download-article-html="download('html', selectedArticleUrls)"
            @download-article-metadata="download('metadata', selectedArticleUrls)"
            @download-article-comment="download('comment', selectedArticleUrls)"
          >
            <UButton
              :loading="downloadBtnLoading"
              :disabled="!selectedAccount"
              color="white"
              class="font-mono whitespace-nowrap"
              :label="downloadBtnLoading ? `缓存中 ${downloadCompletedCount}/${downloadTotalCount}` : '缓存正文'"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <ButtonGroup
            class="shrink-0"
            :items="[
              { label: '轻量版 (fetch)', event: 'select-lite' },
              { label: 'Playwright 版', event: 'select-playwright' },
            ]"
            @select-lite="wechat2mdMode = 'lite'"
            @select-playwright="wechat2mdMode = 'playwright'"
          >
            <UButton
              color="teal"
              variant="soft"
              class="whitespace-nowrap"
              :label="WECHAT2MD_MODE_LABELS[wechat2mdMode]"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <ButtonGroup
            class="shrink-0"
            :items="[
              { label: 'Excel', event: 'fmt-excel' },
              { label: 'JSON', event: 'fmt-json' },
              { label: 'HTML', event: 'fmt-html' },
              { label: 'Txt', event: 'fmt-text' },
              { label: 'Markdown', event: 'fmt-markdown' },
              { label: 'Word (内测中)', event: 'fmt-word' },
              { label: 'PDF (内测中)', event: 'fmt-pdf' },
            ]"
            @fmt-excel="exportFormat = 'excel'"
            @fmt-json="exportFormat = 'json'"
            @fmt-html="exportFormat = 'html'"
            @fmt-text="exportFormat = 'text'"
            @fmt-markdown="exportFormat = 'markdown'"
            @fmt-word="exportFormat = 'word'"
            @fmt-pdf="exportFormat = 'pdf'"
          >
            <UButton
              :loading="exportBtnLoading"
              color="white"
              class="font-mono whitespace-nowrap"
              :label="exportBtnLoading ? `${exportPhase} ${exportCompletedCount}/${exportTotalCount}` : EXPORT_FORMAT_LABELS[exportFormat]"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <ButtonGroup
            v-if="exportFormat === 'markdown'"
            class="shrink-0"
            :items="[
              { label: '图片下载到本地', event: 'img-indexed' },
              { label: '图片 Base64 内嵌', event: 'img-base64' },
              { label: '保留 CDN 链接', event: 'img-cdn' },
            ]"
            @img-indexed="mdImageMode = 'indexed'"
            @img-base64="mdImageMode = 'base64'"
            @img-cdn="mdImageMode = 'cdn'"
          >
            <UButton
              color="white"
              variant="soft"
              class="whitespace-nowrap"
              :label="MD_IMAGE_MODE_LABELS[mdImageMode]"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <UButton
            color="primary"
            class="shrink-0 whitespace-nowrap"
            :loading="wechat2mdLoading || exportBtnLoading"
            :disabled="!selectedAccount || selectedArticleUrls.length === 0"
            @click="runSelectedDownload()"
          >
            {{ wechat2mdLoading ? 'wechat2md...' : exportBtnLoading ? '导出中...' : exportActionLabel }}
          </UButton>

          <UButton
            v-if="exportFormat === 'markdown'"
            color="amber"
            variant="soft"
            icon="i-lucide:refresh-cw"
            class="shrink-0 whitespace-nowrap"
            :loading="wechat2mdLoading"
            :disabled="!selectedAccount || selectedArticleUrls.length === 0 || exportBtnLoading"
            label="覆盖导出"
            @click="runSelectedDownload(true)"
          />

          <UButton
            :loading="localExportLoading"
            :disabled="!selectedAccount"
            icon="i-lucide:folder-sync"
            label="刷新本地导出状态"
            class="shrink-0 whitespace-nowrap"
            color="emerald"
            variant="soft"
            @click="reloadLocalExportStatus"
          />

          <UButton
            :disabled="!selectedAccount"
            :icon="copied ? 'i-lucide:check' : 'i-heroicons-link-16-solid'"
            label="复制公众号链接"
            :color="copied ? 'green' : 'blue'"
            class="shrink-0 whitespace-nowrap"
            @click="copyWechatLink"
          />
          <UButton v-if="isDev" class="shrink-0 whitespace-nowrap" @click="debug">调试</UButton>
        </div>
      </header>

      <ag-grid-vue
        style="width: 100%; height: 100%"
        :loading="loading"
        :rowData="globalRowData"
        :columnDefs="columnDefs"
        :gridOptions="gridOptions"
        @grid-ready="onGridReady"
        @filter-changed="onFilterChanged"
        @column-moved="onColumnStateChange"
        @column-visible="onColumnStateChange"
        @column-pinned="onColumnStateChange"
        @column-resized="onColumnStateChange"
        @selection-changed="onSelectionChanged"
      ></ag-grid-vue>
    </div>

    <PreviewArticle ref="previewArticleRef" />
  </div>
</template>

<script setup lang="ts">
import {
  type ColDef,
  type FilterChangedEvent,
  type GetRowIdParams,
  type GridApi,
  type GridOptions,
  type GridReadyEvent,
  type ICellRendererParams,
  type SelectionChangedEvent,
  type ValueFormatterParams,
  type ValueGetterParams,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import dayjs from 'dayjs';
import { defu } from 'defu';
import { onMounted } from 'vue';
import { formatTimeStamp } from '#shared/utils/helpers';
import GridArticleActions from '~/components/grid/ArticleActions.vue';
import GridLoading from '~/components/grid/Loading.vue';
import GridNoRows from '~/components/grid/NoRows.vue';
import PreviewArticle from '~/components/preview/Article.vue';
import toastFactory from '~/composables/toast';
import {
  EXPORT_FORMAT_LABELS,
  MD_IMAGE_MODE_LABELS,
  WECHAT2MD_MODE_LABELS,
  type Wechat2mdMetadataMap,
} from '~/composables/useDownloadOptions';
import { websiteName } from '~/config';
import { sharedGridOptions } from '~/config/shared-grid-options';
import { articleDeleted, updateArticleFakeid, updateArticleStatus } from '~/store/v2/article';
import { db } from '~/store/v2/db';
import { getHtmlCache } from '~/store/v2/html';
import type { Metadata } from '~/store/v2/metadata';
import type { Preferences } from '~/types/preferences';
import type { AppMsgExWithFakeID } from '~/types/types';
import type { ArticleMetadata } from '~/utils/download/types';
import { createBooleanColumnFilterParams, createDateColumnFilterParams } from '~/utils/grid';

useHead({
  title: `单篇文章下载 | ${websiteName}`,
});

interface SingleArticleRow extends Partial<ArticleMetadata> {
  id: string;
  fakeid: string;
  link: string;
  title: string;
  author_name: string;
  digest: string;
  cover?: string;
  create_time: number;
  update_time: number;
  appmsgid: number;
  itemidx: number;
  aid: string;
  contentDownload: boolean;
  commentDownload: boolean;
  accountName?: string | null;
  markdownExported?: boolean;
  markdownPath?: string;
  articleDir?: string;
  _status: string;
  is_deleted: boolean;
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

const preferences = usePreferences();

const toast = toastFactory();
const inputUrl = ref('');

const globalRowData = useLocalStorage<SingleArticleRow[]>('single-article:rows', []);
if (!globalRowData.value) {
  globalRowData.value = [];
}

const columnDefs = ref<ColDef[]>([
  {
    headerName: 'fakeid',
    field: 'fakeid',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    minWidth: 220,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '标题',
    field: 'title',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    flex: 2,
    minWidth: 220,
    tooltipField: 'title',
  },
  {
    headerName: '链接',
    field: 'link',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    flex: 3,
    minWidth: 240,
    cellClass: 'font-mono',
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
    headerName: '作者',
    field: 'author_name',
    cellDataType: 'text',
    filter: 'agSetColumnFilter',
    flex: 1,
    minWidth: 140,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '发布时间',
    field: 'update_time',
    valueFormatter: (params: ValueFormatterParams) => (params.value ? formatTimeStamp(params.value) : '--'),
    filter: 'agDateColumnFilter',
    filterParams: createDateColumnFilterParams(),
    filterValueGetter: (params: ValueGetterParams) => {
      return new Date(params.getValue('update_time') * 1000);
    },
    flex: 1,
    minWidth: 180,
    cellClass: 'flex justify-center items-center font-mono',
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
    headerName: '正文已缓存',
    field: 'contentDownload',
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('已缓存', '未缓存'),
    minWidth: 140,
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
    colId: 'single-action',
    field: 'link',
    sortable: false,
    filter: false,
    cellRenderer: GridArticleActions,
    cellRendererParams: {
      onPreview: (params: ICellRendererParams) => {
        previewRow(params.data as SingleArticleRow);
      },
      onGotoLink: (params: ICellRendererParams) => {
        window.open(params.value as string, '_blank', 'noopener');
      },
    },
    width: 110,
    pinned: 'right',
    cellClass: 'flex justify-center items-center',
  },
]);

// 注意，`defu`函数最左边的参数优先级最高
const gridOptions: GridOptions = defu(
  {
    animateRows: true,
    columnDefs: columnDefs.value,
    getRowId: (params: GetRowIdParams) => params.data.id,
    components: {
      agLoadingOverlay: GridLoading,
      agNoRowsOverlay: GridNoRows,
    },
    overlayLoadingTemplate: '<grid-loading />',
    overlayNoRowsTemplate: '<grid-no-rows />',
  },
  sharedGridOptions
);

const gridApi = shallowRef<GridApi | null>(null);
const previewArticleRef = ref<typeof PreviewArticle | null>(null);

function refreshGrid() {
  gridApi.value?.setGridOption('rowData', globalRowData.value);
}

function onGridReady(event: GridReadyEvent) {
  gridApi.value = event.api;
}

function onFilterChanged(event: FilterChangedEvent) {
  event.api.deselectAll();
}

watch(
  globalRowData,
  () => {
    refreshGrid();
  },
  { deep: true }
);

onMounted(() => {
  globalRowData.value.forEach(row => {
    upsertArticleStub(row);
  });
});

function normalizeUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('链接不能为空');
  const hasProtocol = /^https?:\/\//i.test(trimmed);
  const normalized = hasProtocol ? trimmed : `https://${trimmed}`;
  const parsed = new URL(normalized);
  if (parsed.hostname !== 'mp.weixin.qq.com') {
    throw new Error('请输入有效的公众号文章链接!');
  }
  return parsed.toString();
}

function parseUrlParams(url: string) {
  const parsed = new URL(url);
  const params = parsed.searchParams;
  const fakeid = params.get('__biz') || 'SINGLE_ARTICLE_FAKEID';
  const mid = params.get('mid') || params.get('appmsgid') || String(stableNumber(url));
  const idx = params.get('idx') || params.get('itemidx') || '1';
  return { fakeid, mid: Number(mid), idx: Number(idx) || 1 };
}

function stableNumber(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash || Date.now();
}

function stableId(value: string) {
  return stableNumber(value).toString(36);
}

function createRow(url: string): SingleArticleRow {
  const { fakeid, mid, idx } = parseUrlParams(url);
  const timestamp = dayjs().unix();
  const aid = `${mid}_${idx}`;
  const generatedId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  return {
    id: generatedId,
    fakeid,
    link: url,
    title: '未命名文章',
    author_name: '--',
    digest: '',
    create_time: timestamp,
    update_time: timestamp,
    appmsgid: mid,
    itemidx: idx,
    aid,
    contentDownload: false,
    commentDownload: false,
    accountName: null,
    markdownExported: false,
    markdownPath: '',
    articleDir: '',
    _status: '',
    is_deleted: false,
  };
}

function createRecoveredRow(entry: Wechat2mdManifestEntry): SingleArticleRow {
  const normalized = normalizeUrl(entry.url);
  const row = createRow(normalized);
  const publishTime = parsePublishTime(entry.publishDate, entry.mtimeMs);

  row.id = `wechat2md:${stableId(normalized)}`;
  row.title = entry.title || row.title;
  row.author_name = entry.accountName || '--';
  row.accountName = entry.accountName || null;
  row.create_time = publishTime;
  row.update_time = publishTime;
  row.markdownExported = true;
  row.markdownPath = entry.filepath;
  row.articleDir = entry.articleDir;
  row._status = '已导出Markdown';

  return row;
}

function parsePublishTime(publishDate: string, mtimeMs: number) {
  const parsed = publishDate ? dayjs(publishDate) : null;
  if (parsed?.isValid()) return parsed.unix();
  return Math.floor(mtimeMs / 1000);
}

async function addArticle() {
  try {
    const normalized = normalizeUrl(inputUrl.value);
    if (globalRowData.value.some(row => row.link === normalized)) {
      toast.info('提示', '该链接已存在列表中');
      return;
    }
    const row = createRow(normalized);
    globalRowData.value = [row, ...globalRowData.value];
    await upsertArticleStub(row);
    refreshGrid();
    inputUrl.value = '';

    // 通过服务端获取文章元数据（标题、作者等）
    try {
      const meta = await $fetch<{
        success: boolean;
        title?: string;
        author?: string;
        accountName?: string;
        publishDate?: string;
        cover?: string;
        digest?: string;
      }>('/api/local/article-meta', { params: { url: normalized } });
      if (meta.success) {
        if (meta.title) row.title = meta.title;
        if (meta.author) row.author_name = meta.author;
        if (meta.accountName) row.accountName = meta.accountName;
        if (meta.digest) row.digest = meta.digest;
        if (meta.cover) row.cover = meta.cover;
        await upsertArticleStub(row);
        updateRow(row);
      }
    } catch {}
  } catch (error: any) {
    toast.error('添加失败', error?.message || '链接格式不正确');
  }
}

function buildVirtualArticle(row: SingleArticleRow): AppMsgExWithFakeID {
  return {
    fakeid: row.fakeid,
    _status: '',
    aid: row.aid,
    album_id: '',
    appmsg_album_infos: [],
    appmsgid: row.appmsgid,
    author_name: row.author_name || '',
    ban_flag: 0,
    checking: 0,
    copyright_stat: 0,
    copyright_type: 0,
    cover: row.cover || '',
    cover_img: row.cover || '',
    cover_img_theme_color: undefined,
    create_time: row.create_time,
    digest: row.digest,
    has_red_packet_cover: 0,
    is_deleted: false,
    is_pay_subscribe: 0,
    wecoin_count: 0,
    item_show_type: 0,
    itemidx: row.itemidx,
    link: row.link,
    media_duration: '0:00',
    mediaapi_publish_status: 0,
    pic_cdn_url_1_1: row.cover || '',
    pic_cdn_url_3_4: row.cover || '',
    pic_cdn_url_16_9: row.cover || '',
    pic_cdn_url_235_1: row.cover || '',
    title: row.title,
    update_time: row.update_time,
    _single: true,
  };
}

function upsertArticleStub(row: SingleArticleRow) {
  return db.article.put(buildVirtualArticle(row), `${row.fakeid}:${row.aid}`);
}

const recoverWechat2mdLoading = ref(false);
async function recoverWechat2mdRecords() {
  recoverWechat2mdLoading.value = true;

  try {
    const data = await $fetch<{
      success: boolean;
      error?: string;
      outputDir: string;
      total: number;
      skipped: number;
      records: Wechat2mdManifestEntry[];
    }>('/api/local/wechat2md-manifest');

    if (!data.success) {
      toast.error('恢复失败', data.error || '扫描本地导出目录失败');
      return;
    }

    let added = 0;
    let updated = 0;
    const rowsByLink = new Map(globalRowData.value.map(row => [row.link, row]));

    for (const entry of data.records) {
      let recovered: SingleArticleRow;
      try {
        recovered = createRecoveredRow(entry);
      } catch {
        continue;
      }

      const existing = rowsByLink.get(recovered.link);
      if (existing) {
        existing.title = existing.title === '未命名文章' ? recovered.title : existing.title;
        existing.author_name = existing.author_name === '--' ? recovered.author_name : existing.author_name;
        existing.accountName = existing.accountName || recovered.accountName;
        existing.update_time = existing.update_time || recovered.update_time;
        existing.markdownExported = true;
        existing.markdownPath = recovered.markdownPath;
        existing.articleDir = recovered.articleDir;
        existing._status = existing._status || '已导出Markdown';
        await upsertArticleStub(existing);
        updated++;
      } else {
        globalRowData.value.push(recovered);
        rowsByLink.set(recovered.link, recovered);
        await upsertArticleStub(recovered);
        added++;
      }
    }

    globalRowData.value = [...globalRowData.value].sort((a, b) => b.update_time - a.update_time);
    refreshGrid();
    toast.success(
      '恢复完成',
      `新增 ${added} 篇，更新 ${updated} 篇；扫描 ${data.total} 个本地导出文件${data.skipped ? `，跳过 ${data.skipped} 个无 URL 文件` : ''}`
    );
  } catch (error: any) {
    toast.error('恢复失败', error?.message || '无法读取本地导出记录');
  } finally {
    recoverWechat2mdLoading.value = false;
  }
}

function getSelectedRows(): SingleArticleRow[] {
  if (!gridApi.value) return [];
  return gridApi.value.getSelectedRows() as SingleArticleRow[];
}

function updateRow(article: SingleArticleRow) {
  const rowNode = gridApi.value?.getRowNode(article.id);
  if (rowNode) {
    rowNode.updateData(article);
  }
}

const selectedArticles = shallowRef<SingleArticleRow[]>([]);
function onSelectionChanged(event: SelectionChangedEvent) {
  selectedArticles.value = (event.selectedNodes || []).map(node => node.data);
}
const selectedArticleUrls = computed(() => {
  return selectedArticles.value.map(article => article.link);
});
const selectedWechat2mdMetadata = computed<Wechat2mdMetadataMap>(() => {
  return Object.fromEntries(
    selectedArticles.value.map(article => {
      const accountName = article.accountName?.trim();
      return [
        article.link,
        {
          title: article.title,
          accountName: accountName && accountName !== '未知公众号' ? accountName : undefined,
          publishDate: article.update_time ? formatTimeStamp(article.update_time) : undefined,
          markdownExported: article.markdownExported,
          contentCached: article.contentDownload,
        },
      ];
    })
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
} = useDownloader({
  onFakeID(url: string, fakeid: string) {
    const article = globalRowData.value.find(article => article.link === url);
    if (article) {
      article.fakeid = fakeid;
      updateRow(article);

      updateArticleFakeid(url, fakeid);
    }
  },
  async onContent(url: string) {
    const article = globalRowData.value.find(article => article.link === url);
    if (article) {
      article.contentDownload = true;
      article._status = '正常';
      await updateRowFromHtml(article);

      await updateArticleStatus(url, '正常');

      // 修复之前代码逻辑错误导致的数据库状态被误设置为【已删除】
      article.is_deleted = false;
      await articleDeleted(url, false);

      updateRow(article);
    } else {
      console.warn(`${url} not found in table data when update contentDownload`);
    }
  },
  onStatusChange(url: string, status: string) {
    const article = globalRowData.value.find(article => article.link === url);
    if (article) {
      article._status = status;
      updateRow(article);

      updateArticleStatus(url, status);
    }
  },
  onDelete(url: string) {
    const article = globalRowData.value.find(article => article.link === url);
    if (article) {
      article.is_deleted = true;
      article._status = '已删除';
      updateRow(article);

      updateArticleStatus(url, '已删除');
      articleDeleted(url);
    }
  },
  onMetadata(url: string, metadata: Metadata) {
    const article = globalRowData.value.find(article => article.link === url);
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
    const article = globalRowData.value.find(article => article.link === url);
    if (article) {
      article.commentDownload = true;
      updateRow(article);
    } else {
      console.warn(`${url} not found in table data when update commentDownload`);
    }
  },
});

async function downloadRows(targetRows: SingleArticleRow[], options: { silent?: boolean } = {}) {
  const { silent = false } = options;
  if (targetRows.length === 0) {
    if (!silent) {
      toast.info('提示', '请先选择至少一篇文章');
    }
    return;
  }

  await Promise.all(
    targetRows.map(async row => {
      updateRow(row);
      await upsertArticleStub(row);
    })
  );

  const urls = targetRows.map(row => row.link);
  await download('html', urls);
}

async function updateRowFromHtml(row: SingleArticleRow) {
  const cache = await getHtmlCache(row.link);
  if (!cache) return;
  const html = await cache.file.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const title = doc.querySelector('#activity-name')?.textContent?.trim();
  const author =
    doc.querySelector('#js_author_name')?.textContent?.trim() || doc.querySelector('#js_name')?.textContent?.trim();
  const digest = doc.querySelector('#js_content')?.textContent?.trim()?.slice(0, 160) || row.digest;
  const cover =
    doc.querySelector<HTMLImageElement>('#js_cover')?.getAttribute('data-src') ||
    doc.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.getAttribute('content') ||
    row.cover ||
    '';
  const publishText = doc.querySelector('#publish_time')?.textContent?.trim();
  const ctMatch = html.match(/var ct = "(?<ts>\d+)";/);

  if (title) row.title = title;
  if (author) row.author_name = author;
  row.accountName = doc.querySelector('#js_name')?.textContent?.trim() || row.accountName || null;
  row.digest = digest || '';
  row.cover = cover;

  if (ctMatch?.groups?.ts) {
    row.update_time = Number(ctMatch.groups.ts);
  } else if (publishText) {
    const parsed = dayjs(publishText);
    if (parsed.isValid()) {
      row.update_time = parsed.unix();
    }
  }

  await db.article.put(
    {
      ...buildVirtualArticle(row),
      digest: row.digest,
      cover: cover,
      cover_img: cover,
      pic_cdn_url_1_1: cover,
      pic_cdn_url_3_4: cover,
      pic_cdn_url_16_9: cover,
      pic_cdn_url_235_1: cover,
    },
    `${row.fakeid}:${row.aid}`
  );
}

function previewRow(row: SingleArticleRow) {
  if (!row.contentDownload) {
    toast.warning('提示', '请先缓存该文章正文');
    return;
  }
  const article = buildVirtualArticle(row) as AppMsgExWithFakeID;
  previewArticleRef.value?.open(article);
}

// ===== 搜狗微信搜索 =====
interface SogouResult {
  title: string;
  url: string;
  account: string;
  abstract: string;
  cover: string;
  time: string;
}
const searchKeyword = ref('');
const searchResults = ref<SogouResult[]>([]);
const searchLoading = ref(false);
const showSearchModal = ref(false);

async function sogouSearch() {
  if (!searchKeyword.value.trim()) {
    toast.warning('提示', '请输入搜索关键词');
    return;
  }
  searchLoading.value = true;
  searchResults.value = [];
  showSearchModal.value = true;
  try {
    const data = await $fetch<{ results: SogouResult[] }>('/api/local/sogou-search', {
      params: { query: searchKeyword.value.trim() },
    });
    searchResults.value = data.results || [];
    if (searchResults.value.length === 0) {
      toast.info('提示', '未找到相关文章');
    }
  } catch (e: any) {
    toast.error('搜索失败', e?.message || '请稍后重试');
  } finally {
    searchLoading.value = false;
  }
}

function addFromSearch(result: SogouResult) {
  const url = result.url;
  if (globalRowData.value.some(row => row.link === url)) {
    toast.info('提示', '该文章已在列表中');
    return;
  }
  const row = createRow(url);
  row.title = result.title || row.title;
  row.author_name = result.account || row.author_name;
  row.digest = result.abstract || row.digest;
  globalRowData.value = [row, ...globalRowData.value];
  upsertArticleStub(row);
  refreshGrid();
  toast.success('已添加', result.title);
}

function addAllSearchResults() {
  let added = 0;
  for (const result of searchResults.value) {
    if (!globalRowData.value.some(row => row.link === result.url)) {
      const row = createRow(result.url);
      row.title = result.title || row.title;
      row.author_name = result.account || row.author_name;
      row.digest = result.abstract || row.digest;
      globalRowData.value = [row, ...globalRowData.value];
      upsertArticleStub(row);
      added++;
    }
  }
  refreshGrid();
  if (added > 0) {
    toast.success('批量添加', `已添加 ${added} 篇文章`);
  } else {
    toast.info('提示', '所有文章已在列表中');
  }
}

// ===== 下载选项（共享） =====
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

  await downloadRows(missing, { silent: true });
}

async function runSelectedDownload(forceMarkdown: boolean | Event = false) {
  const shouldForceMarkdown = forceMarkdown === true;
  if (exportFormat.value === 'markdown') {
    await ensureMarkdownContentCached(shouldForceMarkdown);
  }
  const result = (await runDownload(
    selectedArticleUrls.value,
    contentNotDownloadedCount.value,
    selectedWechat2mdMetadata.value,
    {
      forceMarkdown: shouldForceMarkdown,
      requireCacheForMarkdown: true,
    }
  )) as { successUrls?: string[] } | undefined;
  if (exportFormat.value === 'markdown' && result?.successUrls?.length) {
    const successUrlSet = new Set(result.successUrls);
    await Promise.all(
      selectedArticles.value
        .filter(article => successUrlSet.has(article.link))
        .map(async article => {
          article.markdownExported = true;
          article._status = '已导出Markdown';
          updateRow(article);
          await upsertArticleStub(article);
        })
    );
  }
  return result;
}

async function deleteRowData(row: SingleArticleRow) {
  const key = `${row.fakeid}:${row.aid}`;
  await db.transaction('rw', ['article', 'html'], async () => {
    await db.article.delete(key);
    await db.html.delete(row.link);
  });
}

async function removeRows() {
  const selectedRows = getSelectedRows();
  if (selectedRows.length === 0) {
    toast.info('提示', '请选择要移除的文章');
    return;
  }
  try {
    await Promise.all(selectedRows.map(row => deleteRowData(row)));
    globalRowData.value = globalRowData.value.filter(row => !selectedRows.some(sel => sel.id === row.id));
    gridApi.value?.deselectAll();
    refreshGrid();
    toast.success('移除成功', `已移除 ${selectedRows.length} 篇文章`);
  } catch (error: any) {
    toast.error('移除失败', error?.message || '删除本地缓存时出错');
  }
}
</script>

<template>
  <div class="h-full">
    <Teleport defer to="#title">
      <h1 class="text-[28px] leading-[34px] text-slate-12 dark:text-slate-50 font-bold">单篇文章下载</h1>
    </Teleport>

    <div class="flex flex-col h-full divide-y divide-gray-200">
      <!-- 顶部操作区 -->
      <header class="flex flex-col gap-3 px-3 py-3">
        <!-- 第一行：链接输入 + 搜狗搜索 -->
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div class="flex flex-1 gap-3">
            <UInput v-model="inputUrl" placeholder="请输入公众号文章链接" class="flex-1" @keyup.enter="addArticle" />
            <UButton color="blue" @click="addArticle">添加</UButton>
          </div>
          <div class="flex flex-1 gap-3">
            <UInput v-model="searchKeyword" placeholder="搜狗微信搜索关键词" class="flex-1" @keyup.enter="sogouSearch" />
            <UButton color="indigo" :loading="searchLoading" @click="sogouSearch">搜索</UButton>
          </div>
        </div>
        <!-- 第二行：操作按钮 -->
        <div class="flex items-center gap-3 flex-wrap">
          <ButtonGroup
            :items="[
              { label: '修复fakeid', event: 'fix-fakeid' },
              { label: '缓存正文', event: 'download-article-html' },
              { label: '同步阅读量 (需要Credential)', event: 'download-article-metadata' },
              { label: '同步留言 (需要Credential)', event: 'download-article-comment' },
            ]"
            @fix-fakeid="download('fakeid', selectedArticleUrls)"
            @download-article-html="download('html', selectedArticleUrls)"
            @download-article-metadata="download('metadata', selectedArticleUrls)"
            @download-article-comment="download('comment', selectedArticleUrls)"
          >
            <UButton
              :loading="downloadBtnLoading"
              :disabled="selectedArticleUrls.length === 0"
              color="white"
              class="font-mono"
              :label="downloadBtnLoading ? `缓存中 ${downloadCompletedCount}/${downloadTotalCount}` : '缓存正文'"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <ButtonGroup
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
              :label="WECHAT2MD_MODE_LABELS[wechat2mdMode]"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <ButtonGroup
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
              class="font-mono"
              :label="exportBtnLoading ? `${exportPhase} ${exportCompletedCount}/${exportTotalCount}` : EXPORT_FORMAT_LABELS[exportFormat]"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <ButtonGroup
            v-if="exportFormat === 'markdown'"
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
              :label="MD_IMAGE_MODE_LABELS[mdImageMode]"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <UButton
            color="primary"
            :loading="wechat2mdLoading || exportBtnLoading"
            :disabled="selectedArticleUrls.length === 0"
            @click="runSelectedDownload()"
          >
            {{ wechat2mdLoading ? 'wechat2md...' : exportBtnLoading ? '导出中...' : exportActionLabel }}
          </UButton>

          <UButton
            v-if="exportFormat === 'markdown'"
            color="amber"
            variant="soft"
            icon="i-lucide:refresh-cw"
            :loading="wechat2mdLoading"
            :disabled="selectedArticleUrls.length === 0 || exportBtnLoading"
            label="覆盖导出"
            @click="runSelectedDownload(true)"
          />

          <UButton color="rose" variant="soft" :disabled="selectedArticleUrls.length === 0" @click="removeRows">
            移除
          </UButton>
          <UButton
            color="emerald"
            variant="soft"
            icon="i-lucide:folder-sync"
            :loading="recoverWechat2mdLoading"
            @click="recoverWechat2mdRecords"
          >
            恢复本地导出
          </UButton>
        </div>
      </header>

      <ag-grid-vue
        style="width: 100%; height: 100%"
        :rowData="globalRowData"
        :columnDefs="columnDefs"
        :gridOptions="gridOptions"
        @grid-ready="onGridReady"
        @filter-changed="onFilterChanged"
        @selection-changed="onSelectionChanged"
      />
    </div>

    <PreviewArticle ref="previewArticleRef" />

    <!-- 搜狗搜索结果弹窗 -->
    <UModal v-model="showSearchModal" :ui="{ width: 'sm:max-w-3xl' }">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold">搜索结果：{{ searchKeyword }}</h3>
            <div class="flex gap-2">
              <UButton v-if="searchResults.length > 0" size="sm" color="blue" variant="soft" @click="addAllSearchResults">
                全部添加
              </UButton>
              <UButton size="sm" color="gray" variant="ghost" icon="i-heroicons-x-mark" @click="showSearchModal = false" />
            </div>
          </div>
        </template>
        <div v-if="searchLoading" class="flex justify-center py-8">
          <UIcon name="i-heroicons-arrow-path" class="w-6 h-6 animate-spin text-gray-400" />
        </div>
        <div v-else-if="searchResults.length === 0" class="py-8 text-center text-gray-400">
          未找到相关文章
        </div>
        <div v-else class="divide-y divide-gray-100 dark:divide-gray-800 max-h-[60vh] overflow-y-auto">
          <div
            v-for="(item, idx) in searchResults"
            :key="idx"
            class="flex gap-3 py-3 px-1 hover:bg-gray-50 dark:hover:bg-gray-800 rounded"
          >
            <img
              v-if="item.cover"
              :src="item.cover"
              class="w-20 h-14 object-cover rounded flex-shrink-0"
              referrerpolicy="no-referrer"
            />
            <div class="flex-1 min-w-0">
              <div class="font-medium text-sm truncate">{{ item.title }}</div>
              <p class="text-xs text-gray-500 mt-1 line-clamp-2">{{ item.abstract }}</p>
              <div class="flex items-center gap-3 mt-1 text-xs text-gray-400">
                <span v-if="item.account">{{ item.account }}</span>
                <span v-if="item.time">{{ item.time }}</span>
              </div>
            </div>
            <UButton size="xs" color="blue" variant="soft" class="flex-shrink-0 self-center" @click="addFromSearch(item)">
              添加
            </UButton>
          </div>
        </div>
      </UCard>
    </UModal>
  </div>
</template>

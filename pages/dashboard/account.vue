<script setup lang="ts">
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridOptions,
  GridReadyEvent,
  ICellRendererParams,
  SelectionChangedEvent,
  ValueGetterParams,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { defu } from 'defu';
import { planAfterLocalReconciliation, planAfterPublicSourceFailure } from '#shared/utils/account-refresh-plan';
import { formatTimeStamp } from '#shared/utils/helpers';
import {
  getBoundedOverlapPolicy,
  getOverlapDateFloor,
  isBoundedOverlapComplete,
  pageCrossesHighWatermark,
} from '#shared/utils/incremental-sync';
import {
  buildLocalExportArticle,
  isLocalExportCandidateForAccount,
  type LocalExportManifestEntry,
} from '#shared/utils/local-export-recovery';
import {
  type ArticleListPageResult,
  type ArticleListSource,
  AuthenticatedArticleListUnavailableError,
  getArticleList,
} from '~/apis';
import type GlobalSearchAccountDialog from '~/components/global/SearchAccountDialog.vue';
import GridAccountActions from '~/components/grid/AccountActions.vue';
import GridLoadProgress from '~/components/grid/LoadProgress.vue';
import ConfirmModal from '~/components/modal/Confirm.vue';
import LoginModal from '~/components/modal/Login.vue';
import toastFactory from '~/composables/toast';
import useLoginCheck from '~/composables/useLoginCheck';
import { IMAGE_PROXY, websiteName } from '~/config';
import { sharedGridOptions } from '~/config/shared-grid-options';
import { deleteAccountData } from '~/store/v2';
import { getArticleHighWatermark, recoverLocalArticleCache } from '~/store/v2/article';
import { getAllInfo, getInfoCache, importMpAccounts, type MpAccount, updateLastUpdateTime } from '~/store/v2/info';
import type { AccountManifest } from '~/types/account';
import type { Preferences } from '~/types/preferences';
import { exportAccountJsonFile } from '~/utils/exporter';
import { createBooleanColumnFilterParams, createDateColumnFilterParams } from '~/utils/grid';

useHead({
  title: `公众号管理 | ${websiteName}`,
});

const toast = toastFactory();
const modal = useModal();
const { checkLogin } = useLoginCheck();

const { getSyncTimestamp, getSyncRangeLabel, isSyncAll } = useSyncDeadline();
const syncToTimestamp = getSyncTimestamp();

const preferences = usePreferences();

// 账号事件总线，用于和 Credentials 面板保持列表同步
const { accountEventBus } = useAccountEventBus();
const stopAccountEventListener = accountEventBus.on(event => {
  if (event === 'account-added' || event === 'account-removed') {
    void refresh();
  }
});

const searchAccountDialogRef = ref<typeof GlobalSearchAccountDialog | null>(null);

const addBtnLoading = ref(false);
function addAccount() {
  if (!checkLogin()) return;

  searchAccountDialogRef.value!.open();
}
async function onSelectAccount(account: MpAccount) {
  addBtnLoading.value = true;
  try {
    const result = await loadAccountArticle(account, false);
    await refresh();
    if (result.coverage === 'partial') {
      toast.warning(
        '公众号已添加',
        `已添加公众号【${account.nickname}】；${formatPartialSourceHint(result)}；未标记为完整同步`
      );
    } else {
      toast.success('公众号添加成功', `已成功添加公众号【${account.nickname}】，并同步了第一页的文章数据`);
    }
    // 通知 Credentials 面板按钮立即变更为“已添加”
    accountEventBus.emit('account-added', { fakeid: account.fakeid });
  } finally {
    addBtnLoading.value = false;
  }
}

const isDeleting = ref(false);
const isSyncing = ref(false);
const syncStatusText = ref('');

interface AccountSyncResult {
  account: MpAccount;
  articleCount: number;
  coverage: 'complete' | 'partial';
  highWatermarkReached: boolean;
  pagesAfterHighWatermark: number;
  pagesScanned: number;
  source: ArticleListSource;
  localCanonicalRecords?: number;
  localRejectedRecords?: number;
  localRecoveredArticles?: number;
  sourceArticleCount?: number;
  sourceRetryCount?: number;
  warnings?: string[];
  stopReason: 'date-floor' | 'high-watermark-overlap' | 'partial-source' | 'requested-first-page' | 'source-complete';
}

// 当前正在同步的公众号id
const syncingRowId = ref<string | null>(null);

class AccountSyncCancelledError extends Error {
  constructor() {
    super('已取消同步');
    this.name = 'AccountSyncCancelledError';
  }
}

interface ActiveAccountSync {
  accountId: string;
  cancelled: boolean;
  controller: AbortController;
  timer: number | null;
  cancellation: Promise<never>;
  rejectCancellation: (reason: Error) => void;
}

let activeAccountSync: ActiveAccountSync | null = null;

function createAccountSync(accountId: string): ActiveAccountSync {
  let rejectCancellation!: (reason: Error) => void;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  void cancellation.catch(() => {});
  return {
    accountId,
    cancelled: false,
    controller: new AbortController(),
    timer: null,
    cancellation,
    rejectCancellation,
  };
}

function cancelActiveAccountSync(accountId?: string) {
  const sync = activeAccountSync;
  if (!sync || sync.cancelled || (accountId && sync.accountId !== accountId)) return;
  sync.cancelled = true;
  if (sync.timer !== null) {
    window.clearTimeout(sync.timer);
    sync.timer = null;
  }
  sync.controller.abort(new AccountSyncCancelledError());
  sync.rejectCancellation(new AccountSyncCancelledError());
}

function runWhileActive<T>(task: Promise<T>, sync: ActiveAccountSync): Promise<T> {
  return Promise.race([task, sync.cancellation]);
}

async function waitForNextPage(sync: ActiveAccountSync): Promise<void> {
  const delay = ((preferences.value as unknown as Preferences).accountSyncSeconds || 5) * 1000;
  const timer = new Promise<void>(resolve => {
    sync.timer = window.setTimeout(() => {
      sync.timer = null;
      resolve();
    }, delay);
  });
  await runWhileActive(timer, sync);
}

interface LocalExportRecoveryResult {
  articleCount: number;
  canonicalRecords: number;
  messageCount: number;
  rejectedRecords: number;
}

async function getLocalExportManifest(): Promise<LocalExportManifestEntry[]> {
  const result = await $fetch<{
    success: boolean;
    error?: string;
    records: LocalExportManifestEntry[];
  }>('/api/local/wechat2md-manifest');
  if (!result.success) throw new Error(result.error || '无法读取本地导出记录');
  return result.records;
}

async function recoverLocalExportForAccount(
  account: MpAccount,
  records?: LocalExportManifestEntry[]
): Promise<LocalExportRecoveryResult> {
  const manifest = records ?? (await getLocalExportManifest());
  const accountName = String(account.nickname || '').trim();
  const accountEntries = manifest.filter(entry => isLocalExportCandidateForAccount(entry, accountName, account.fakeid));
  let rejectedRecords = 0;
  const articles = accountEntries.flatMap(entry => {
    const article = buildLocalExportArticle(entry, account.fakeid, {
      requireCanonicalIdentity: true,
    });
    if (!article) {
      rejectedRecords += 1;
      return [];
    }
    return [{ ...article, author_name: accountName || entry.accountName }];
  });
  const recovered = await recoverLocalArticleCache(account, articles);
  return {
    ...recovered,
    canonicalRecords: articles.length,
    rejectedRecords,
  };
}

// 同步指定公众号
async function loadAccountArticle(account: MpAccount, loadMore = true): Promise<AccountSyncResult> {
  if (activeAccountSync) {
    throw new Error('已有公众号正在同步');
  }

  const sync = createAccountSync(account.fakeid);
  activeAccountSync = sync;
  syncingRowId.value = account.fakeid;
  isSyncing.value = true;
  const accountLabel = account.nickname || account.fakeid;
  syncStatusText.value = `公众号【${accountLabel}】：正在对齐本地导出`;
  let begin = 0;
  let source: ArticleListSource = planAfterLocalReconciliation(0).nextSource;
  let articleCount = 0;
  let sourceArticleCount = 0;
  let sourceRetryCount = 0;
  let frequencyControlNoticeShown = false;
  let highWatermarkReached = false;
  let pagesAfterHighWatermark = 0;
  let pagesScanned = 0;
  const syncWarnings: string[] = [];
  let local: LocalExportRecoveryResult = {
    articleCount: 0,
    canonicalRecords: 0,
    messageCount: 0,
    rejectedRecords: 0,
  };

  try {
    try {
      local = await runWhileActive(recoverLocalExportForAccount(account), sync);
    } catch (error) {
      if (error instanceof AccountSyncCancelledError) throw error;
      syncWarnings.push(`本地导出暂不可用：${(error as Error).message}`);
    }
    articleCount = local.articleCount;
    source = planAfterLocalReconciliation(local.canonicalRecords).nextSource;

    const priorInfo = await runWhileActive(getInfoCache(account.fakeid), sync);
    const highWatermark = await runWhileActive(getArticleHighWatermark(account.fakeid), sync);
    const overlapPolicy = getBoundedOverlapPolicy(priorInfo?.last_update_time);
    const overlapDateFloor = highWatermark
      ? getOverlapDateFloor(highWatermark, overlapPolicy.days, syncToTimestamp)
      : syncToTimestamp;
    syncStatusText.value = `公众号【${accountLabel}】：正在扫描公开索引`;
    if (!isBatchSyncing.value) {
      toast.info('正在扫描公开索引', `公众号【${accountLabel}】正在核验候选文章，请稍候`);
    }

    async function finish(
      stopReason: AccountSyncResult['stopReason'],
      coverage: AccountSyncResult['coverage'] = 'complete'
    ): Promise<AccountSyncResult> {
      if (stopReason !== 'requested-first-page') {
        await runWhileActive(updateLastUpdateTime(account.fakeid), sync);
      }
      await runWhileActive(updateRow(account.fakeid), sync);
      return {
        account,
        articleCount,
        coverage,
        highWatermarkReached,
        pagesAfterHighWatermark,
        pagesScanned,
        source,
        localCanonicalRecords: local.canonicalRecords,
        localRejectedRecords: local.rejectedRecords,
        localRecoveredArticles: local.articleCount,
        sourceArticleCount,
        sourceRetryCount,
        stopReason,
        warnings: syncWarnings.length > 0 ? syncWarnings : undefined,
      };
    }

    while (true) {
      let page: ArticleListPageResult;
      try {
        page = await runWhileActive(
          getArticleList(account, begin, '', {
            deferLastUpdate: true,
            onFrequencyControl: () => {
              if (frequencyControlNoticeShown) return;
              frequencyControlNoticeShown = true;
              toast.warning('完整数据源受限', '已保留本地与公开来源结果');
            },
            allowPublicFallback: false,
            signal: sync.controller.signal,
            source,
            notBefore: overlapDateFloor,
          }),
          sync
        );
      } catch (error) {
        if (error instanceof AccountSyncCancelledError) throw error;
        if (source !== 'public_index') throw error;
        syncWarnings.push(`公开索引暂不可用：${(error as Error).message}`);
        const fallbackPlan = planAfterPublicSourceFailure(local.canonicalRecords);
        if (fallbackPlan.action === 'finish-local-partial') {
          await runWhileActive(updateRow(account.fakeid), sync);
          return {
            account,
            articleCount,
            coverage: 'partial',
            highWatermarkReached: false,
            localCanonicalRecords: local.canonicalRecords,
            localRejectedRecords: local.rejectedRecords,
            localRecoveredArticles: local.articleCount,
            pagesAfterHighWatermark: 0,
            pagesScanned: 0,
            source: 'local_export',
            sourceArticleCount: 0,
            stopReason: 'partial-source',
            warnings: syncWarnings,
          };
        }
        syncWarnings.push('本地与公开来源均无可用结果，最后尝试完整数据源');
        source = fallbackPlan.nextSource;
        syncStatusText.value = `公众号【${accountLabel}】：正在尝试完整数据源`;
        continue;
      }
      const { articles, completed, nextBegin, pageBegin } = page;
      source = page.source;
      pagesScanned += 1;
      sourceArticleCount += articles.length;
      sourceRetryCount += page.sourceRetryCount || 0;
      articleCount += articles.length;
      if (page.coverage === 'partial') {
        pagesScanned = page.sourcePageCount || pagesScanned;
        await runWhileActive(updateRow(account.fakeid), sync);
        return {
          account,
          articleCount,
          coverage: 'partial',
          highWatermarkReached: false,
          pagesAfterHighWatermark: 0,
          pagesScanned,
          source: page.source,
          localCanonicalRecords: local.canonicalRecords,
          localRejectedRecords: local.rejectedRecords,
          localRecoveredArticles: local.articleCount,
          sourceArticleCount,
          sourceRetryCount,
          stopReason: 'partial-source',
          warnings: [...syncWarnings, ...(page.warnings || [])],
        };
      }

      const crossedBeforePage = highWatermarkReached;
      if (highWatermark && !highWatermarkReached && pageCrossesHighWatermark(articles, highWatermark)) {
        highWatermarkReached = true;
      } else if (crossedBeforePage) {
        pagesAfterHighWatermark += 1;
      }

      if (completed) {
        return finish('source-complete', page.coverage || 'complete');
      }

      if (nextBegin <= pageBegin) {
        throw new Error(`公众号【${account.nickname || account.fakeid}】同步分页未推进`);
      }
      begin = nextBegin;

      const lastArticle = articles.at(-1);
      if (!lastArticle) {
        throw new Error(`公众号【${account.nickname || account.fakeid}】返回了空的未完成分页`);
      }

      await runWhileActive(updateRow(account.fakeid), sync);
      if (!loadMore) {
        return finish('requested-first-page', page.coverage || 'complete');
      }
      if (lastArticle.create_time < syncToTimestamp) {
        return finish('date-floor', page.coverage || 'complete');
      }
      if (
        highWatermark &&
        isBoundedOverlapComplete({
          calendarFloor: overlapDateFloor,
          oldestPublishTimestamp: lastArticle.create_time,
          pagesAfterCrossing: pagesAfterHighWatermark,
          requiredPagesAfterCrossing: overlapPolicy.pagesAfterCrossing,
          watermarkCrossed: highWatermarkReached,
        })
      ) {
        return finish('high-watermark-overlap', page.coverage || 'complete');
      }
      await waitForNextPage(sync);
    }
  } catch (error) {
    if (error instanceof AuthenticatedArticleListUnavailableError) {
      throw new Error(
        `公众号【${account.nickname || account.fakeid}】的完整数据源当前不可用；本页没有启动普通 Chrome。请先运行 Codex 补全任务，再对齐本地导出。`
      );
    }
    if ((error as Error)?.message === 'session expired') {
      modal.open(LoginModal);
    }
    throw error;
  } finally {
    if (sync.timer !== null) {
      window.clearTimeout(sync.timer);
    }
    if (activeAccountSync === sync) {
      activeAccountSync = null;
    }
    syncingRowId.value = null;
    isSyncing.value = false;
    syncStatusText.value = '';
  }
}

const isBatchSyncing = ref(false);
const batchSyncCompletedCount = ref(0);
const batchSyncTotalCount = ref(0);
const selectedRowCount = ref(0);
const hasSelectedRows = computed(() => selectedRowCount.value > 0);
const recoverLocalLoading = ref(false);

async function recoverSelectedLocalExports() {
  const accounts = getSelectedRows();
  if (accounts.length === 0) {
    toast.warning('对齐本地导出', '请先勾选需要对齐的公众号');
    return;
  }

  recoverLocalLoading.value = true;
  try {
    const records = await getLocalExportManifest();

    let articleCount = 0;
    let messageCount = 0;
    let rejectedCount = 0;
    for (const account of accounts) {
      const recovered = await recoverLocalExportForAccount(account, records);
      articleCount += recovered.articleCount;
      messageCount += recovered.messageCount;
      rejectedCount += recovered.rejectedRecords;
    }
    await refresh();
    toast.success(
      '本地导出已对齐',
      `新增 ${articleCount} 篇、${messageCount} 条消息${rejectedCount ? `，跳过 ${rejectedCount} 条无法稳定归属的历史记录` : ''}`
    );
  } catch (error) {
    toast.error('对齐本地导出失败', (error as Error).message);
  } finally {
    recoverLocalLoading.value = false;
  }
}

function formatPartialSourceHint(result: AccountSyncResult): string {
  const hints: string[] = [];
  if ((result.localCanonicalRecords || 0) > 0 || (result.localRejectedRecords || 0) > 0) {
    hints.push(
      `本地导出核验 ${result.localCanonicalRecords || 0} 篇、新增 ${result.localRecoveredArticles || 0} 篇、跳过 ${result.localRejectedRecords || 0} 条无效记录`
    );
  }
  if (result.source === 'public_index') {
    const retryHint = result.sourceRetryCount ? `、自动复核 ${result.sourceRetryCount} 次` : '';
    hints.push(`公开索引扫描 ${result.pagesScanned} 页${retryHint}、核验 ${result.sourceArticleCount || 0} 篇`);
  }
  return hints.join('；') || '没有发现可验证的新文章';
}

function partialSyncTitle(result: AccountSyncResult): string {
  if (result.source === 'local_export') return '本地导出已对齐';
  if ((result.localCanonicalRecords || 0) > 0) return '本地导出与公开来源已对齐';
  return '公开部分补充完成';
}

const batchSyncButtonLabel = computed(() => {
  if (isBatchSyncing.value) {
    return `批量同步中 ${batchSyncCompletedCount.value}/${batchSyncTotalCount.value}`;
  }
  return selectedRowCount.value > 0 ? `批量同步 (${selectedRowCount.value})` : '批量同步';
});

// 同步所选公众号
async function loadSelectedAccountArticle() {
  try {
    const rows = getSelectedRows();
    if (rows.length === 0) {
      toast.warning('批量同步', '请先勾选需要同步的公众号');
      return;
    }

    isBatchSyncing.value = true;
    batchSyncCompletedCount.value = 0;
    batchSyncTotalCount.value = rows.length;
    const failedAccounts: string[] = [];
    let completeCount = 0;
    let partialCount = 0;
    for (const account of rows) {
      try {
        const result = await loadAccountArticle(account);
        if (result.coverage === 'complete') completeCount += 1;
        else partialCount += 1;
      } catch (error) {
        failedAccounts.push(`${account.nickname || account.fakeid}（${(error as Error).message}）`);
      } finally {
        batchSyncCompletedCount.value += 1;
      }
    }
    const rangeHint = isSyncAll() ? '' : `（同步范围：${getSyncRangeLabel()}）`;
    if (failedAccounts.length > 0) {
      toast.error(
        '批量同步未完成',
        `完整同步 ${completeCount} 个，部分来源补充 ${partialCount} 个，失败 ${failedAccounts.length} 个：${failedAccounts.join('、')}`
      );
    } else if (partialCount > 0) {
      toast.warning(
        '批量补充完成',
        `完整同步 ${completeCount} 个，部分来源补充 ${partialCount} 个；部分覆盖不会更新完整同步时间`
      );
    } else {
      toast.success('批量同步完成', `已完成 ${completeCount} 个公众号的增量扫描${rangeHint}`);
    }
  } catch (e: any) {
    toast.error('批量同步失败', e.message);
  } finally {
    isBatchSyncing.value = false;
    batchSyncCompletedCount.value = 0;
    batchSyncTotalCount.value = 0;
  }
}

let globalRowData: MpAccount[] = [];

const columnDefs = ref<ColDef[]>([
  {
    colId: 'fakeid',
    headerName: 'fakeid',
    field: 'fakeid',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    minWidth: 200,
    cellClass: 'font-mono',
    initialHide: true,
  },
  {
    colId: 'round_head_img',
    headerName: '头像',
    field: 'round_head_img',
    sortable: false,
    filter: false,
    cellRenderer: (params: ICellRendererParams) => {
      return `<img alt="" src="${IMAGE_PROXY + params.value}" style="height: 30px; width: 30px; object-fit: cover; border: 1px solid #e5e7eb; border-radius: 100%;" />`;
    },
    cellClass: 'flex justify-center items-center',
    minWidth: 80,
  },
  {
    colId: 'nickname',
    headerName: '名称',
    field: 'nickname',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    tooltipField: 'nickname',
    minWidth: 200,
  },
  {
    colId: 'create_time',
    headerName: '添加时间',
    field: 'create_time',
    valueFormatter: p => (p.value ? formatTimeStamp(p.value) : ''),
    filter: 'agDateColumnFilter',
    filterParams: createDateColumnFilterParams(),
    filterValueGetter: (params: ValueGetterParams) => {
      return new Date(params.getValue('create_time') * 1000);
    },
    sort: 'desc',
    minWidth: 180,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    colId: 'update_time',
    headerName: '数据更新时间',
    field: 'update_time',
    valueFormatter: p => (p.value ? formatTimeStamp(p.value) : ''),
    filter: 'agDateColumnFilter',
    filterParams: createDateColumnFilterParams(),
    filterValueGetter: (params: ValueGetterParams) => {
      return new Date(params.getValue('update_time') * 1000);
    },
    minWidth: 180,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    colId: 'last_update_time',
    headerName: '完整同步时间',
    field: 'last_update_time',
    valueFormatter: p => (p.value ? formatTimeStamp(p.value) : ''),
    filter: 'agDateColumnFilter',
    filterParams: createDateColumnFilterParams(),
    filterValueGetter: (params: ValueGetterParams) => {
      return new Date(params.getValue('last_update_time') * 1000);
    },
    minWidth: 180,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    colId: 'total_count',
    headerName: '消息总数',
    field: 'total_count',
    cellDataType: 'number',
    cellRenderer: 'agAnimateShowChangeCellRenderer',
    filter: 'agNumberColumnFilter',
    cellClass: 'flex justify-center items-center font-mono',
    minWidth: 150,
  },
  {
    colId: 'count',
    headerName: '已同步消息数',
    field: 'count',
    cellDataType: 'number',
    cellRenderer: 'agAnimateShowChangeCellRenderer',
    filter: 'agNumberColumnFilter',
    cellClass: 'flex justify-center items-center font-mono',
    minWidth: 180,
  },
  {
    colId: 'articles',
    headerName: '已同步文章数',
    field: 'articles',
    cellDataType: 'number',
    cellRenderer: 'agAnimateShowChangeCellRenderer',
    filter: 'agNumberColumnFilter',
    cellClass: 'flex justify-center items-center font-mono',
    minWidth: 180,
    initialHide: true,
  },
  {
    colId: 'load_percent',
    headerName: '同步进度',
    valueGetter: params => (params.data.total_count === 0 ? 0 : params.data.count / params.data.total_count),
    cellDataType: 'number',
    cellRenderer: GridLoadProgress,
    filter: 'agNumberColumnFilter',
    minWidth: 200,
  },
  {
    colId: 'completed',
    headerName: '是否同步完成',
    field: 'completed',
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('已同步完成', '未同步完成'),
    cellClass: 'flex justify-center items-center',
    headerClass: 'justify-center',
    minWidth: 200,
  },
  {
    colId: 'action',
    headerName: '操作',
    field: 'fakeid',
    sortable: false,
    filter: false,
    cellRenderer: GridAccountActions,
    cellRendererParams: {
      onSync: (params: ICellRendererParams) => {
        loadAccountArticle(params.data)
          .then(result => {
            if (result.coverage === 'partial') {
              toast.warning(
                partialSyncTitle(result),
                `公众号【${params.data.nickname}】${formatPartialSourceHint(result)}；未更新完整同步时间`
              );
              return;
            }
            const rangeHint = isSyncAll() ? '' : `（同步范围：${getSyncRangeLabel()}）`;
            const watermarkHint = result.highWatermarkReached
              ? `，已越过上次最新文章并继续扫描 ${result.pagesAfterHighWatermark} 页`
              : '';
            toast.success(
              '完整增量同步完成',
              `公众号【${params.data.nickname}】扫描 ${result.pagesScanned} 页${watermarkHint}${rangeHint}`
            );
          })
          .catch(e => {
            toast.error('同步失败', e.message);
          });
      },
      onStop: (params: ICellRendererParams) => {
        cancelActiveAccountSync(params.data.fakeid);
      },
      isDeleting: isDeleting,
      isSyncing: isSyncing,
      syncingRowId: syncingRowId,
    },
    cellClass: 'flex justify-center items-center',
    maxWidth: 130,
    pinned: 'right',
  },
]);

// 注意，`defu`函数最左边的参数优先级最高
const gridOptions: GridOptions = defu(
  {
    getRowId: (params: GetRowIdParams) => String(params.data.fakeid),
  },
  sharedGridOptions
);

const gridApi = shallowRef<GridApi | null>(null);
function onGridReady(params: GridReadyEvent) {
  gridApi.value = params.api;

  restoreColumnState();
  refresh();
}

function onColumnStateChange() {
  if (gridApi.value) {
    saveColumnState();
  }
}
function saveColumnState() {
  const state = gridApi.value?.getColumnState();
  localStorage.setItem('agGridColumnState-account', JSON.stringify(state));
}

function restoreColumnState() {
  const stateStr = localStorage.getItem('agGridColumnState-account');
  if (stateStr) {
    const state = JSON.parse(stateStr);
    gridApi.value?.applyColumnState({
      state,
      applyOrder: true,
    });
  }
}

async function refresh() {
  globalRowData = await getAllInfo();
  gridApi.value?.setGridOption('rowData', globalRowData);
}

async function updateRow(fakeid: string) {
  const rowNode = gridApi.value?.getRowNode(fakeid);
  if (rowNode) {
    const info = await getInfoCache(fakeid);
    rowNode.updateData(info);
  }
}

function onSelectionChanged(evt: SelectionChangedEvent) {
  selectedRowCount.value = evt.api.getSelectedRows().length;
}
function getSelectedRows() {
  const rows: MpAccount[] = [];
  gridApi.value?.forEachNodeAfterFilterAndSort(node => {
    if (node.isSelected()) {
      rows.push(node.data);
    }
  });
  return rows;
}

// 删除所选的公众号数据
function deleteSelectedAccounts() {
  const rows = getSelectedRows();
  const ids = rows.map(info => info.fakeid);
  modal.open(ConfirmModal, {
    title: '确定要删除所选公众号的数据吗？',
    description: '删除之后，该公众号的所有数据(包括已下载的文章和留言等)都将被清空。',
    async onConfirm() {
      try {
        isDeleting.value = true;
        await deleteAccountData(ids);
        // 通知 Credentials 面板这些公众号已被移除
        ids.forEach(fakeid => {
          accountEventBus.emit('account-removed', { fakeid: fakeid });
        });
      } finally {
        isDeleting.value = false;
        await refresh();
      }
    },
  });
}

// 导入公众号
const fileRef = ref<HTMLInputElement | null>(null);
const importBtnLoading = ref(false);
function importAccount() {
  fileRef.value!.click();
}
async function handleFileChange(evt: Event) {
  const files = (evt.target as HTMLInputElement).files;
  if (files && files.length > 0) {
    const file = files[0];

    try {
      importBtnLoading.value = true;

      // 解析 JSON
      const jsonData = JSON.parse(await file.text());
      if (jsonData.usefor !== 'wechat-article-exporter') {
        // 文件格式不正确
        toast.error('导入公众号失败', '导入文件格式不正确，请选择该网站导出的文件进行导入。');
        return;
      }
      const infos = jsonData.accounts;
      if (!infos || infos.length <= 0) {
        // 文件格式不正确
        toast.error('导入公众号失败', '导入文件格式不正确，请选择该网站导出的文件进行导入。');
        return;
      }

      await importMpAccounts(infos);
      await refresh();
    } catch (error) {
      console.error('导入公众号时 JSON 解析失败:', error);
      toast.error('导入公众号', (error as Error).message);
    } finally {
      importBtnLoading.value = false;
    }
  }
}

// 导出公众号
const exportBtnLoading = ref(false);
function exportAccount() {
  exportBtnLoading.value = true;
  try {
    const rows = getSelectedRows();
    const data: AccountManifest = {
      version: '1.0',
      usefor: 'wechat-article-exporter',
      accounts: rows,
    };
    exportAccountJsonFile(data, '公众号');
    toast.success('导出公众号', `成功导出了 ${rows.length} 个公众号`);
  } finally {
    exportBtnLoading.value = false;
  }
}

const { getActualDateRange } = useSyncDeadline();

onUnmounted(() => {
  stopAccountEventListener();
  cancelActiveAccountSync();
});
</script>

<template>
  <div class="h-full">
    <Teleport defer to="#title">
      <h1 class="text-[28px] leading-[34px] text-slate-12 dark:text-slate-50 font-bold">公众号管理</h1>
    </Teleport>

    <div class="flex flex-col h-full divide-y divide-gray-200">
      <!-- 顶部操作区 -->
      <header class="flex items-stretch gap-3 px-3 py-3">
        <UButton icon="i-lucide:user-plus" color="blue" :disabled="isDeleting || addBtnLoading" @click="addAccount">
          {{ addBtnLoading ? '添加中...' : '添加' }}
        </UButton>
        <UButton icon="i-lucide:arrow-down-to-line" color="blue" :loading="importBtnLoading" @click="importAccount">
          批量导入
          <input ref="fileRef" type="file" accept=".json" class="hidden" @change="handleFileChange" />
        </UButton>
        <UButton
          icon="i-lucide:arrow-up-from-line"
          color="blue"
          :loading="exportBtnLoading"
          :disabled="!hasSelectedRows"
          @click="exportAccount"
        >
          批量导出
        </UButton>
        <UButton
          icon="i-lucide:folder-sync"
          color="blue"
          :loading="recoverLocalLoading"
          :disabled="isDeleting || isSyncing || !hasSelectedRows"
          @click="recoverSelectedLocalExports"
        >
          对齐本地导出
        </UButton>
        <UButton
          color="rose"
          icon="i-lucide:user-minus"
          class="disabled:opacity-35"
          :loading="isDeleting"
          :disabled="!hasSelectedRows"
          @click="deleteSelectedAccounts"
          >删除</UButton
        >
        <UButton
          color="black"
          icon="i-heroicons:arrow-path-rounded-square-20-solid"
          class="disabled:opacity-35"
          :loading="isBatchSyncing"
          :disabled="isDeleting || isSyncing || !hasSelectedRows"
          @click="loadSelectedAccountArticle"
          >{{ batchSyncButtonLabel }}</UButton
        >
        <div class="hidden xl:flex flex-1 justify-end items-center">
          <span v-if="syncStatusText" class="flex items-center gap-2 text-sm text-orange-600 font-medium">
            <UIcon name="i-lucide:loader-circle" class="size-4 animate-spin" />
            {{ syncStatusText }}
          </span>
          <span v-else class="text-sm text-blue-500 font-medium">同步范围: {{ getActualDateRange() }}</span>
        </div>
      </header>

      <!-- 数据表格 -->
      <ag-grid-vue
        style="width: 100%; height: 100%"
        :rowData="globalRowData"
        :columnDefs="columnDefs"
        :gridOptions="gridOptions"
        @grid-ready="onGridReady"
        @selection-changed="onSelectionChanged"
        @column-moved="onColumnStateChange"
        @column-visible="onColumnStateChange"
        @column-pinned="onColumnStateChange"
        @column-resized="onColumnStateChange"
      ></ag-grid-vue>
    </div>

    <!-- 添加公众号弹框 -->
    <GlobalSearchAccountDialog ref="searchAccountDialogRef" @select:account="onSelectAccount" />
  </div>
</template>

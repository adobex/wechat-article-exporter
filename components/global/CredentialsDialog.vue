<template>
  <USlideover v-model="open" :ui="{ width: 'max-w-[500px]' }">
    <UCard
      class="flex flex-col flex-1"
      :ui="{ body: { base: 'flex-1' }, ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }"
    >
      <template #header>
        <div class="flex justify-between items-center">
          <h2 class="font-bold text-2xl">获取临时凭据</h2>
        </div>
      </template>

      <div>
        <UTabs
          :items="tabs"
          :ui="{ list: { marker: { background: 'bg-blue-500 text-white' }, tab: { active: 'text-white' } } }"
        >
          <template #item="{ item }">
            <div v-if="item.key === 'wxdown'" class="space-y-5">
              <p class="flex items-center text-sm">
                <span class="text-rose-500 font-semibold">所需软件：</span>
                <UButton @click="downloadProgram" variant="ghost" color="gray"
                  >打开 wxdown 下载页
                  <UIcon name="i-lucide:arrow-up-right" class="size-5" />
                </UButton>
              </p>
              <div class="flex justify-between items-center gap-3">
                <UInput
                  class="flex-1"
                  color="gray"
                  type="url"
                  v-model="wsURL"
                  :disabled="monitoring || wsMonitoring"
                  placeholder="请输入 ws 监听地址"
                />
                <UButton
                  v-if="!wsMonitoring"
                  :disabled="!wsURL || monitoring"
                  color="blue"
                  @click="startListenService(true)"
                >
                  开始监控
                </UButton>
                <UButton v-else icon="i-line-md:loading-twotone-loop" color="green" @click="stopListenService"
                  >监控中，结束监控</UButton
                >
              </div>
            </div>
            <div v-if="item.key === 'mitmproxy'">
              <p class="flex items-center text-sm">
                <span class="text-rose-500 font-semibold">所需软件：</span>
                <UButton @click="downloadPlugin" variant="ghost" color="gray"
                  >去下载 mitmproxy 插件
                  <UIcon name="i-lucide:arrow-up-right" class="size-5" />
                </UButton>
              </p>
              <div class="text-sm my-5">
                <p class="flex justify-between items-end">执行以下命令启动 mitmproxy 服务并加载 credential.py 插件：</p>
                <p class="flex justify-between items-center bg-black text-white p-2 my-2 rounded-md">
                  <code>mitmdump -s credential.py -q</code>
                  <UIcon v-if="copied" name="i-lucide:copy-check" />
                  <UIcon
                    v-else
                    name="i-lucide:copy"
                    class="cursor-pointer"
                    @click="copy('mitmdump -s credential.py -q')"
                  />
                </p>
              </div>
              <div class="flex justify-between items-center gap-3">
                <UInput
                  class="flex-1"
                  color="gray"
                  v-model="apiKey"
                  :disabled="authorized || wsMonitoring"
                  placeholder="请输入API Key"
                />
                <UButton
                  class="px-5"
                  color="blue"
                  :loading="authorizeBtnLoading"
                  :disabled="!apiKey || authorized || wsMonitoring || monitoring"
                  @click="authorize"
                  >认证</UButton
                >

                <UButton v-if="!monitoring" :disabled="!authorized || wsMonitoring" color="blue" @click="start"
                  >开始监控</UButton
                >
                <UButton v-else icon="i-line-md:loading-twotone-loop" color="green" @click="stop"
                  >监控中，结束监控</UButton
                >
              </div>
            </div>
          </template>
        </UTabs>
        <ul class="flex flex-col mt-3 p-1 gap-4 overflow-y-scroll h-[calc(100vh-20rem)] no-scrollbar">
          <li
            v-for="credential in credentials"
            :key="credential.biz"
            class="relative flex items-center border rounded-md hover:ring ring-blue-500 hover:shadow-md transition-all duration-300 p-3 space-x-5"
          >
            <div class="size-20 border rounded-full">
              <img :src="credential.avatar" alt="" />
            </div>
            <div class="flex-1">
              <p>公众号名称：{{ credential.nickname || '--' }}</p>
              <p>fakeid: {{ credential.biz }}</p>
              <p>获取时间: {{ credential.time }}</p>
              <div class="flex items-center justify-between mt-4">
                <span v-if="credential.valid" class="font-sans font-bold text-green-500">有效</span>
                <span v-else class="font-sans font-bold text-rose-500">已过期</span>
                <UButton
                  size="xs"
                  :color="credential.added ? 'green' : 'blue'"
                  :variant="credential.added ? 'soft' : 'solid'"
                  :disabled="credential.added || addingBiz === credential.biz"
                  :loading="addingBiz === credential.biz"
                  @click="addAccount(credential)"
                >
                  {{ credential.added ? '已添加' : '添加公众号' }}
                </UButton>
              </div>
            </div>
            <UButton
              v-if="isDev"
              :loading="pullArticleLoading"
              class="absolute top-3 right-3"
              @click="pullData(credential.biz)"
            >
              拉取数据
            </UButton>
          </li>
        </ul>
      </div>
    </UCard>
  </USlideover>
</template>

<script setup lang="ts">
import dayjs from 'dayjs';
import { getArticleList, getArticleListWithCredential } from '~/apis';
import LoginModal from '~/components/modal/Login.vue';
import toastFactory from '~/composables/toast';
import useLoginCheck from '~/composables/useLoginCheck';
import { CREDENTIAL_API_HOST, CREDENTIAL_LIVE_MINUTES, isDev } from '~/config';
import { getInfoCache, type MpAccount } from '~/store/v2/info';
import type { ParsedCredential } from '~/types/credential';

export type CredentialState = 'active' | 'inactive' | 'warning';

const emit = defineEmits<(e: 'update:pendingCount', value: number) => void>();

const open = defineModel<boolean>('open', { default: false });
const state = defineModel<CredentialState>('state', { default: 'inactive' });
const runtimeConfig = useRuntimeConfig();

const pullArticleLoading = ref(false);
async function pullData(fakeid: string) {
  pullArticleLoading.value = true;
  const articles = await getArticleListWithCredential(fakeid);
  console.log(articles);
  pullArticleLoading.value = false;
}

const tabs = [
  {
    key: 'wxdown',
    label: 'wxdown 自动获取',
  },
  {
    key: 'mitmproxy',
    label: 'mitmproxy 手动获取',
  },
];

const { checkLogin } = useLoginCheck();

const credentials = useLocalStorage<ParsedCredential[]>('auto-detect-credentials:credentials', []);
for (const item of credentials.value) {
  item.valid = Date.now() < item.timestamp + 1000 * 60 * CREDENTIAL_LIVE_MINUTES;
}
const validCredentialCount = computed(() => credentials.value.filter(c => c.valid).length);
const pendingCredentialCount = computed(() => credentials.value.filter(c => c.valid && !c.added).length);
const toast = toastFactory();
const modal = useModal();

const addingBiz = ref<string | null>(null);

/**
 * 从 set_cookie 字符串中解析 appmsg_token 和完整 cookie 字符串
 * set_cookie 格式: "name=value; Path=/; HttpOnly, name2=value2; Path=/; HttpOnly, ..."
 */
function parseSetCookie(setCookie: string): { appmsg_token: string; cookie: string } {
  let appmsg_token = '';
  const tokenMatch = setCookie.match(/appmsg_token=(?<token>[^;]+)/);
  if (tokenMatch?.groups?.token) {
    try {
      appmsg_token = decodeURIComponent(tokenMatch.groups.token.trim());
    } catch {
      appmsg_token = tokenMatch.groups.token.trim();
    }
  }

  // 按逗号分隔各 cookie 条目，提取有效的 name=value 对
  const cookieParts: string[] = [];
  const entries = setCookie.split(',');
  for (const entry of entries) {
    const nameValue = entry.trim().split(';')[0].trim();
    if (!nameValue || !nameValue.includes('=')) continue;
    // 跳过 EXPIRED 值和纯属性条目
    if (nameValue.includes('EXPIRED')) continue;
    const name = nameValue.split('=')[0].trim();
    if (['Path', 'Expires', 'HttpOnly', 'Secure', 'Domain', 'SameSite'].includes(name)) continue;
    // 跳过空值（如 rewardsn=）
    const value = nameValue.split('=').slice(1).join('=');
    if (!value) continue;
    cookieParts.push(nameValue);
  }

  return { appmsg_token, cookie: cookieParts.join('; ') };
}

async function refreshCredentialAddedState() {
  const pending = credentials.value.map(async credential => {
    const info = await getInfoCache(credential.biz);
    credential.added = Boolean(info);
  });
  await Promise.allSettled(pending);
}

// 监听账号事件，及时更新当前凭据项的按钮状态
const { accountEventBus } = useAccountEventBus();
const stopAccountEventListener = accountEventBus.on((event, payload) => {
  if (event === 'account-added') {
    const target = credentials.value.find(item => item.biz === payload?.fakeid);
    if (target) {
      target.added = true;
    }
  } else if (event === 'account-removed') {
    const target = credentials.value.find(item => item.biz === payload?.fakeid);
    if (target) {
      target.added = false;
    }
  }
});

interface CredentialSnapshotItem {
  url?: unknown;
  set_cookie?: unknown;
  timestamp?: unknown;
  name?: unknown;
  avatar?: unknown;
}

let timer: number | null = null;
let manualStopped = false;
let listenRetryTimer: number | null = null;
let httpFetchInFlight = false;
let httpFetchController: AbortController | null = null;
let snapshotVersion = 0;
let appliedSnapshotVersion = 0;
let disposed = false;
let copyTimer: number | null = null;
let credentialSyncInFlight = false;
let credentialSyncPending = false;
const monitoring = ref(localStorage.getItem('auto-detect-credentials:monitoring') === 'true');

function start() {
  if (disposed) return;
  monitoring.value = true;
  clearCredentialPolling(false);
  void fetchCredentials();
  timer = window.setInterval(() => {
    void fetchCredentials();
  }, 3000);
  localStorage.setItem('auto-detect-credentials:monitoring', 'true');
}

function clearCredentialPolling(abortRequest = true) {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (abortRequest) {
    httpFetchController?.abort();
    httpFetchController = null;
  }
  localStorage.removeItem('auto-detect-credentials:monitoring-timer');
}

function stop() {
  monitoring.value = false;
  localStorage.setItem('auto-detect-credentials:monitoring', 'false');
  clearCredentialPolling();
}

// 监听服务重试机制
function scheduleListenRetry() {
  if (listenRetryTimer) {
    window.clearTimeout(listenRetryTimer);
  }

  // 如果是手动停止的，则不重试
  if (manualStopped || disposed) return;

  listenRetryTimer = window.setTimeout(() => {
    void startListenService();
  }, 5000);
}

// 清除重试定时器
function clearRetryTimer() {
  if (listenRetryTimer) {
    window.clearTimeout(listenRetryTimer);
    listenRetryTimer = null;
  }
}

onMounted(() => {
  disposed = false;
  if (monitoring.value) {
    start();
  }
  void refreshCredentialAddedState();
  void syncCredentialsToLocalServer();
  void startListenService();
});

onUnmounted(() => {
  disposed = true;
  credentialSyncPending = false;
  clearCredentialPolling();
  clearRetryTimer();
  closeListenService(false);
  stopAccountEventListener();
  if (copyTimer !== null) {
    window.clearTimeout(copyTimer);
    copyTimer = null;
  }
});

// 下载 credential.py 插件
async function downloadPlugin() {
  const link = document.createElement('a');
  link.href = '/plugins/credential.py';
  link.download = 'credential.py';
  link.click();
}

// 下载 wxdown-service 程序
async function downloadProgram() {
  const link = document.createElement('a');
  link.target = '_blank';
  link.href = 'https://github.com/wechat-article/wxdown-service/releases';
  link.download = 'wxdown-service';
  link.click();
}

const apiKey = ref(localStorage.getItem('auto-detect-credentials:apikey') as string);
const authorizeBtnLoading = ref(false);
const authorized = ref(false);

// 认证
async function authorize() {
  try {
    authorizeBtnLoading.value = true;
    const response = await fetch(`${CREDENTIAL_API_HOST}/authorize`, {
      method: 'GET',
      headers: {
        Authorization: apiKey.value,
      },
    });
    if (response.status === 200) {
      authorized.value = true;
      localStorage.setItem('auto-detect-credentials:apikey', apiKey.value);
      alert('认证成功');
    } else {
      authorized.value = false;
      localStorage.removeItem('auto-detect-credentials:apikey');
      alert('认证失败，请确认 API Key 是否正确');
    }
  } catch (error: any) {
    if (error.message === 'Failed to fetch') {
      alert('mitmproxy 服务未启动');
    } else {
      alert(error.message);
    }
    authorized.value = false;
  } finally {
    authorizeBtnLoading.value = false;
  }
}

// 获取数据
function getSnapshotItems(payload: unknown): CredentialSnapshotItem[] | null {
  if (Array.isArray(payload)) return payload as CredentialSnapshotItem[];
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload as Record<string, unknown>;
  const items = envelope.credentials ?? envelope.data ?? envelope.result;
  return Array.isArray(items) ? (items as CredentialSnapshotItem[]) : null;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function parseCredentialItem(item: CredentialSnapshotItem): Promise<ParsedCredential | undefined> {
  try {
    const itemUrl = asNonEmptyString(item.url);
    const setCookie = asNonEmptyString(item.set_cookie);
    const timestamp = Number(item.timestamp);
    if (!itemUrl || !setCookie || !Number.isFinite(timestamp) || timestamp <= 0) return;

    const searchParams = new URL(itemUrl).searchParams;
    const biz = searchParams.get('__biz')?.trim() || '';
    const uin = searchParams.get('uin')?.trim() || '';
    const key = searchParams.get('key')?.trim() || '';
    const passTicket = searchParams.get('pass_ticket')?.trim() || '';
    const wapSidMatch = setCookie.match(/(?:^|[,;]\s*)wap_sid2=(?<wapSid>[^;,\s]+)/);
    const wapSid = wapSidMatch?.groups?.wapSid?.trim() || '';
    if (!biz || !uin || !key || !passTicket || !wapSid) return;

    const { appmsg_token, cookie } = parseSetCookie(setCookie);
    const info = await getInfoCache(biz);
    return {
      nickname: asNonEmptyString(item.name) || info?.nickname,
      avatar: asNonEmptyString(item.avatar) || info?.round_head_img,
      biz,
      uin,
      key,
      pass_ticket: passTicket,
      wap_sid2: wapSid,
      appmsg_token,
      cookie,
      timestamp,
      time: dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss'),
      valid: Date.now() < timestamp + 1000 * 60 * CREDENTIAL_LIVE_MINUTES,
      added: Boolean(info),
    };
  } catch (error) {
    console.warn('已忽略畸形 Credential 记录:', error);
  }
}

function replaceCredentialSnapshot(incoming: ParsedCredential[]): void {
  const currentByBiz = new Map(credentials.value.map(item => [item.biz, item]));
  const replacement = new Map<string, ParsedCredential>();
  for (const next of incoming) {
    const previous = replacement.get(next.biz);
    if (previous && previous.timestamp > next.timestamp) continue;
    const current = currentByBiz.get(next.biz);
    replacement.set(next.biz, {
      ...current,
      ...next,
      nickname: next.nickname || current?.nickname,
      avatar: next.avatar || current?.avatar,
      added: Boolean(current?.added || next.added),
    });
  }

  credentials.value = Array.from(replacement.values()).sort((a, b) => b.timestamp - a.timestamp);
  void syncCredentialsToLocalServer();
}

async function syncCredentialsToLocalServer(): Promise<void> {
  if (disposed || !runtimeConfig.public.outputDir || window.location.hostname !== 'localhost') {
    return;
  }

  credentialSyncPending = true;
  if (credentialSyncInFlight) return;
  credentialSyncInFlight = true;
  try {
    while (credentialSyncPending && !disposed) {
      credentialSyncPending = false;
      const now = Date.now();
      const activeCredentials = credentials.value
        .filter(item => item.valid && item.timestamp + 1000 * 60 * CREDENTIAL_LIVE_MINUTES > now)
        .map(item => ({
          nickname: item.nickname,
          biz: item.biz,
          uin: item.uin,
          key: item.key,
          pass_ticket: item.pass_ticket,
          wap_sid2: item.wap_sid2,
          appmsg_token: item.appmsg_token,
          cookie: item.cookie,
          timestamp: item.timestamp,
        }));

      try {
        const response = await fetch('/api/local/wechat2md/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credentials: activeCredentials }),
        });
        const result = (await response.json().catch(() => null)) as { applied?: boolean; success?: boolean } | null;
        if (!response.ok || result?.success !== true || result.applied !== true) {
          console.warn(`本地 Credential 同步被拒绝: HTTP ${response.status}`);
        }
      } catch (error) {
        console.warn('本地 Credential 同步失败:', error);
      }
    }
  } finally {
    credentialSyncInFlight = false;
  }
}

async function applyCredentialSnapshot(payload: unknown, source: 'HTTP' | 'WS'): Promise<void> {
  const version = ++snapshotVersion;
  const items = getSnapshotItems(payload);
  if (!items) {
    console.warn(`${source} Credential 快照格式不正确，已保留现有凭据`);
    return;
  }
  if (items.length === 0) {
    if (version < appliedSnapshotVersion || disposed) return;
    replaceCredentialSnapshot([]);
    appliedSnapshotVersion = version;
    return;
  }

  const parsed = (await Promise.all(items.map(item => parseCredentialItem(item)))).filter(
    (item): item is ParsedCredential => Boolean(item)
  );
  if (parsed.length === 0 || version < appliedSnapshotVersion || disposed) return;

  replaceCredentialSnapshot(parsed);
  appliedSnapshotVersion = version;
}

async function fetchCredentials() {
  if (httpFetchInFlight || disposed) return;
  httpFetchInFlight = true;
  const controller = new AbortController();
  httpFetchController = controller;

  try {
    const response = await fetch(`${CREDENTIAL_API_HOST}/credentials`, {
      method: 'GET',
      headers: { Authorization: apiKey.value },
      signal: controller.signal,
    });
    if (response.status === 404) {
      await applyCredentialSnapshot([], 'HTTP');
      return;
    }
    if (response.status !== 200) {
      authorized.value = false;
      stop();
      return;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      console.warn('HTTP Credential 快照解析失败，已保留现有凭据:', error);
      return;
    }
    await applyCredentialSnapshot(payload, 'HTTP');
  } catch (error) {
    if ((error as DOMException)?.name !== 'AbortError') {
      console.error(error);
      authorized.value = false;
      stop();
    }
  } finally {
    if (httpFetchController === controller) {
      httpFetchController = null;
    }
    httpFetchInFlight = false;
  }
}

const wsURL = ref('wss://127.0.0.1:65001');
const wsMonitoring = ref(false);
let _ws: WebSocket | null = null;
let wsGeneration = 0;
let wsListeners:
  | {
      socket: WebSocket;
      open: () => void;
      message: (event: MessageEvent) => void;
      close: () => void;
      error: () => void;
    }
  | undefined;

function detachWebSocketListeners(socket: WebSocket) {
  if (!wsListeners || wsListeners.socket !== socket) return;
  socket.removeEventListener('open', wsListeners.open);
  socket.removeEventListener('message', wsListeners.message);
  socket.removeEventListener('close', wsListeners.close);
  socket.removeEventListener('error', wsListeners.error);
  wsListeners = undefined;
}

function closeListenService(markAsManual: boolean) {
  if (markAsManual) manualStopped = true;
  wsGeneration++;
  clearRetryTimer();

  const socket = _ws;
  _ws = null;
  wsMonitoring.value = false;
  if (!socket) return;
  detachWebSocketListeners(socket);
  if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
}

// 启动监听服务
async function startListenService(isManual = false) {
  if (disposed) return;
  const url = wsURL.value.trim();
  if (!url) return;
  if (isManual) {
    manualStopped = false;
  }
  if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;

  closeListenService(false);
  const generation = ++wsGeneration;
  const ws = new WebSocket(url);
  _ws = ws;

  const onOpen = () => {
    if (disposed || generation !== wsGeneration || _ws !== ws) return;
    wsMonitoring.value = true;
    clearRetryTimer();
  };
  const onMessage = (event: MessageEvent) => {
    if (disposed || generation !== wsGeneration || _ws !== ws) return;
    let payload: unknown;
    try {
      payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch (error) {
      console.warn('WS Credential 快照解析失败，已保留现有凭据:', error);
      return;
    }
    void applyCredentialSnapshot(payload, 'WS');
  };
  const onClose = () => {
    detachWebSocketListeners(ws);
    if (generation !== wsGeneration || _ws !== ws) return;
    _ws = null;
    wsMonitoring.value = false;
    scheduleListenRetry();
  };
  const onError = () => {
    if (generation !== wsGeneration || _ws !== ws) return;
    wsMonitoring.value = false;
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      ws.close();
    } else {
      scheduleListenRetry();
    }
  };

  wsListeners = { socket: ws, open: onOpen, message: onMessage, close: onClose, error: onError };
  ws.addEventListener('open', onOpen);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);
}

// 停止监听服务
async function stopListenService() {
  closeListenService(true);
}

async function addAccount(credential: ParsedCredential) {
  if (credential.added || addingBiz.value === credential.biz) {
    return;
  }
  if (!checkLogin()) return;

  addingBiz.value = credential.biz;
  const nickname = credential.nickname || credential.biz;
  const account: MpAccount = {
    fakeid: credential.biz,
    completed: false,
    count: 0,
    articles: 0,
    total_count: 0,
    nickname: credential.nickname,
    round_head_img: credential.avatar,
  };

  try {
    await getArticleList(account, 0, '', { deferLastUpdate: true });
    credential.added = true;
    toast.success('公众号添加成功', `已成功添加公众号【${nickname}】`);
    // 通知其他视图（如公众号管理列表）立即刷新
    accountEventBus.emit('account-added', { fakeid: credential.biz });
  } catch (error: any) {
    if (error?.message === 'session expired') {
      modal.open(LoginModal);
    } else {
      toast.error('添加公众号失败', error?.message || '未知错误');
    }
  } finally {
    addingBiz.value = null;
  }
}

watchEffect(() => {
  if (!monitoring.value && !wsMonitoring.value) {
    state.value = 'inactive';
  } else if (monitoring.value || wsMonitoring.value) {
    state.value = 'active';
  } else {
    state.value = 'warning';
  }
});

watchEffect(() => {
  emit('update:pendingCount', pendingCredentialCount.value);
});

const copied = ref(false);
function copy(text: string) {
  navigator.clipboard.writeText(text);
  copied.value = true;
  if (copyTimer !== null) {
    window.clearTimeout(copyTimer);
  }
  copyTimer = window.setTimeout(() => {
    copied.value = false;
    copyTimer = null;
  }, 1000);
}
</script>

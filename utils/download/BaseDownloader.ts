import { sleep, timeout } from '#shared/utils/helpers';
import usePreferences from '~/composables/usePreferences';
import { PUBLIC_PROXY_LIST } from '~/config/public-proxy';
import type { ParsedCredential } from '~/types/credential';
import type { Preferences } from '~/types/preferences';
import { getBestConcurrencyCount } from '~/utils/concurrency';
import { DEFAULT_OPTIONS } from './constants';
import { ProxyManager } from './ProxyManager';
import type { Callback, DownloaderStatus, DownloadOptions } from './types';

const credentials = useLocalStorage<ParsedCredential[]>('auto-detect-credentials:credentials', []);
const preferences: Ref<Preferences> = usePreferences() as unknown as Ref<Preferences>;

const LOCAL_PROXY_PATH = '/api/local/proxy';

function getProxyOrigin(proxy: string): string | null {
  try {
    const url = new URL(proxy);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const PUBLIC_PROXY_ORIGINS = new Set(
  PUBLIC_PROXY_LIST.map(getProxyOrigin).filter((origin): origin is string => !!origin)
);

function isKnownPublicProxy(proxy: string): boolean {
  const origin = getProxyOrigin(proxy);
  return origin !== null && PUBLIC_PROXY_ORIGINS.has(origin);
}

function isLoopbackPage(): boolean {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return ['localhost', '127.0.0.1', '::1'].includes(hostname) && ['http:', 'https:'].includes(window.location.protocol);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

interface ProxyConfiguration {
  downloadProxies: string[];
  credentialProxies: string[];
  privateProxies: Set<string>;
}

function resolveProxyConfiguration(configuredProxies: string[]): ProxyConfiguration {
  const configured = unique(configuredProxies.map(proxy => proxy.trim()).filter(Boolean));
  const validConfigured = configured.filter(proxy => getProxyOrigin(proxy) !== null);
  const privateProxies = validConfigured.filter(proxy => !isKnownPublicProxy(proxy));
  const isLocal = isLoopbackPage();

  if (isLocal) {
    if (validConfigured.some(isKnownPublicProxy)) {
      console.warn('本地环境已忽略公共代理配置');
    }
  }
  if (validConfigured.length !== configured.length) {
    console.warn('已忽略无效的私有代理地址');
  }

  const downloadProxies = isLocal
    ? unique([...privateProxies, LOCAL_PROXY_PATH])
    : validConfigured.length > 0
      ? validConfigured
      : [...PUBLIC_PROXY_LIST];
  const credentialProxies = unique([...privateProxies, ...(isLocal ? [LOCAL_PROXY_PATH] : [])]);

  return {
    downloadProxies,
    credentialProxies,
    privateProxies: new Set(privateProxies),
  };
}

function proxyForLog(proxy: string): string {
  if (proxy.startsWith('/')) return proxy.split(/[?#]/, 1)[0];
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid-proxy>';
  }
}

// 下载器
// 支持下载文章HTML、阅读量、留言列表
// 注意：
//   1. 文章HTML可并发下载
//   2. 阅读量和留言数据由于使用了Credential，为了防止抓取过快，只能设置较低的并发量（通常为5）

export class BaseDownloader {
  protected readonly urls: string[]; // 需要爬取的文章url列表
  protected readonly pending: Set<string>; // 文章抓取中列表
  protected readonly completed: Set<string>; // 文章抓取成功列表
  protected readonly failed: Set<string>; // 文章抓取异常列表
  protected readonly deleted: Set<string>; // 文章已删除列表

  protected readonly options: Required<DownloadOptions>;
  protected isRunning: boolean;
  protected readonly abortControllers: Map<string, AbortController>; // 每个文章url对应一个controller，方便进行取消
  public readonly proxyManager: ProxyManager;
  protected readonly credentialProxyManager: ProxyManager | null;
  private readonly credentialProxySet: Set<string>;
  private readonly privateProxySet: Set<string>;
  protected events: Map<string, Callback[]>;

  constructor(urls: string[], options: DownloadOptions = {}) {
    this.validateInputs(urls);

    const proxyConfiguration = resolveProxyConfiguration((preferences.value as Preferences).privateProxyList || []);

    this.urls = [...urls].reverse();
    this.pending = new Set();
    this.completed = new Set();
    this.failed = new Set();
    this.deleted = new Set();
    this.isRunning = false;
    this.abortControllers = new Map();
    this.events = new Map();

    this.options = {
      concurrency: options.concurrency ?? getBestConcurrencyCount(proxyConfiguration.downloadProxies.length),
      timeout: options.timeout ?? DEFAULT_OPTIONS.TIMEOUT,
      maxRetries: options.maxRetries ?? DEFAULT_OPTIONS.MAX_RETRIES,
      cooldownPeriod: options.cooldownPeriod ?? DEFAULT_OPTIONS.COOLDOWN_PERIOD,
      maxFailures: options.maxFailures ?? DEFAULT_OPTIONS.MAX_FAILURES,
    };

    this.proxyManager = new ProxyManager(
      proxyConfiguration.downloadProxies,
      this.options.cooldownPeriod,
      this.options.maxFailures
    );
    this.credentialProxyManager =
      proxyConfiguration.credentialProxies.length > 0
        ? new ProxyManager(proxyConfiguration.credentialProxies, this.options.cooldownPeriod, this.options.maxFailures)
        : null;
    this.credentialProxySet = new Set(proxyConfiguration.credentialProxies);
    this.privateProxySet = proxyConfiguration.privateProxies;
  }

  /**
   * 添加事件监听器
   * @param type 事件类型
   * @param listener 监听器
   */
  public on(type: string, listener: Callback) {
    const listeners = this.events.get(type) || [];
    listeners.push(listener);
    this.events.set(type, listeners);
  }

  /**
   * 删除事件监听器
   * @param type 事件类型
   * @param listener 监听器
   */
  public off(type: string, listener?: Callback) {
    if (!this.events.has(type)) {
      return;
    }
    if (!listener) {
      this.events.delete(type);
    } else {
      const listeners = this.events.get(type);
      if (!listeners) return;
      const idx = listeners.indexOf(listener);
      if (idx > -1) {
        listeners.splice(idx, 1);
      }
    }
  }

  /**
   * 移除所有事件监听器
   */
  public removeAllListeners() {
    this.events.clear();
  }

  /**
   * 取消所有正在下载的请求
   */
  public cancelAllPending(): void {
    this.abortControllers.forEach(controller => {
      controller.abort();
    });
    this.abortControllers.clear();
  }

  /**
   * 获取下载器状态
   */
  public getStatus(): DownloaderStatus {
    return {
      pending: Array.from(this.pending),
      completed: Array.from(this.completed),
      failed: Array.from(this.failed),
      deleted: Array.from(this.deleted),
      proxy: this.proxyManager.getProxyStatus(),
    };
  }

  // 触发指定类型的监听器
  protected emit(type: string, ...args: Parameters<Callback>) {
    const listeners = this.events.get(type);
    if (listeners) {
      listeners.forEach(fn => {
        fn.call(type, ...args);
      });
    }
  }

  // 代理下载失败时的处理逻辑
  protected async handleDownloadFailure(
    proxyManager: ProxyManager,
    proxy: string,
    url: string,
    attempt: number,
    error: unknown
  ): Promise<void> {
    proxyManager.recordFailure(proxy);
    const reason =
      error instanceof Error && /^HTTP error! status: \d+$/.test(error.message) ? error.message : 'request failed';
    console.warn(`Attempt ${attempt + 1} failed for ${url} using ${proxyForLog(proxy)}: ${reason}`);

    if (attempt < this.options.maxRetries - 1) {
      const delay = 2 ** attempt;
      console.warn('下载失败，延迟', delay, '秒后重试');
      await sleep(1000 * delay);
    }
  }

  protected getRequestProxyManager(withCredential: boolean): ProxyManager {
    if (!withCredential) return this.proxyManager;
    if (!this.credentialProxyManager) {
      throw new Error('凭据请求仅允许使用 localhost 同源代理或明确配置的非公共私有代理');
    }
    return this.credentialProxyManager;
  }

  protected assertCredentialProxy(proxy: string): void {
    if (!this.credentialProxySet.has(proxy)) {
      throw new Error('拒绝通过公共或未授权代理发送微信凭据');
    }
  }

  protected buildProxyRequestUrl(proxy: string, targetUrl: string, headers: Record<string, string>): string {
    const query = new URLSearchParams({
      url: targetUrl,
      headers: JSON.stringify(headers),
    });
    const authorization = (preferences.value as Preferences).privateProxyAuthorization || '';
    if (authorization && this.privateProxySet.has(proxy)) {
      query.set('authorization', authorization);
    }

    const separator = proxy.includes('?') ? (/[?&]$/.test(proxy) ? '' : '&') : '?';
    return `${proxy}${separator}${query.toString()}`;
  }

  // 下载
  protected async download(fakeid: string, url: string, proxy: string, withCredential = false): Promise<Blob> {
    const abortController = new AbortController();
    this.abortControllers.set(url, abortController);

    try {
      const headers: Record<string, string> = {};

      // 使用设置的 credentials 来抓取元数据
      if (withCredential) {
        this.assertCredentialProxy(proxy);
        const targetCredential = credentials.value.find(item => item.biz === fakeid && item.valid);
        if (!targetCredential) {
          throw new Error('目标公众号的 Credential 未设置');
        }
        headers.cookie = `pass_ticket=${targetCredential.pass_ticket};wap_sid2=${targetCredential.wap_sid2}`;
      }

      const proxyUrl = this.buildProxyRequestUrl(proxy, url, headers);
      const response = (await Promise.race([
        fetch(proxyUrl, {
          signal: abortController.signal,
          referrerPolicy: 'no-referrer',
        }),
        timeout(this.options.timeout),
      ])) as Response;

      if (!response || !response.ok) {
        throw new Error(`HTTP error! status: ${response?.status ?? 0}`);
      }

      return response.blob();
    } finally {
      this.abortControllers.delete(url);
    }
  }

  // 验证输入 urls 是否全部合法
  protected validateInputs(urls: string[]): void {
    urls.forEach(url => {
      try {
        new URL(url);
      } catch {
        throw new Error(`非法URL: ${url}`);
      }
    });
  }

  // 当获取阅读量和留言数据时，需要验证 Credential 是否设置正确
  protected validateCredential(fakeid: string): void {
    const targetCredential = credentials.value.find(item => item.biz === fakeid && item.valid);
    if (!targetCredential) {
      throw new Error('目标公众号的 Credential 未设置');
    }
  }
}

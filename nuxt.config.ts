// https://nuxt.com/docs/api/configuration/nuxt-config
import { randomBytes } from 'node:crypto';

const sentryAuthToken = process.env.NUXT_SENTRY_AUTH_TOKEN?.trim();
const localOutputDir =
  process.env.WECHAT2MD_LOCAL_OUTPUT_ENABLED === 'true' ? process.env.WECHAT2MD_OUTPUT_DIR?.trim() || '' : '';
const localApiProxySecret = randomBytes(32).toString('hex');

export default defineNuxtConfig({
  compatibilityDate: '2025-10-30',
  devtools: {
    enabled: false,
  },
  modules: ['@vueuse/nuxt', '@nuxt/ui', '@sentry/nuxt/module', 'nuxt-monaco-editor', 'nuxt-umami'],
  ignore: ['**/.local/**'],
  ssr: false,
  // Nuxt 3.21.8 SPA dev-server workaround; remove after the upstream 3.21.9 fix is adopted.
  hooks: {
    'vite:extendConfig'(config) {
      const input = config.build?.rollupOptions?.input;
      if (!input || typeof input === 'string' || Array.isArray(input)) return;
      const namedInput = input as Record<string, string>;
      const firstInput = Object.values(namedInput).find(value => typeof value === 'string');
      if (!firstInput) return;
      namedInput.entry ||= firstInput;
      namedInput.server ||= firstInput;
    },
  },
  vite: {
    plugins: [
      {
        name: 'wechat2md-loopback-proof',
        configureServer(server) {
          server.middlewares.use((request, _response, next) => {
            delete request.headers['x-wechat2md-loopback-proof'];
            if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')) {
              request.headers['x-wechat2md-loopback-proof'] = localApiProxySecret;
            }
            next();
          });
        },
      },
    ],
  },
  runtimeConfig: {
    localApiProxySecret,
    public: {
      aggridLicense: process.env.NUXT_AGGRID_LICENSE,
      // 公开托管站标记（仅公开托管用；默认关闭，fork 私有部署无限速、无下线提示）
      // 开启后：公开 API 按游客/会员分层限速，文档页展示限速说明与 API 下线提示
      membership: {
        enabled: process.env.NUXT_PUBLIC_MEMBERSHIP_ENABLED === 'true',
      },
      outputDir: localOutputDir,
      sentry: {
        dsn: process.env.NUXT_SENTRY_DSN,
      },
    },
    debugMpRequest: false,
  },
  app: {
    head: {
      meta: [
        {
          name: 'referrer',
          content: 'no-referrer',
        },
      ],
      script: [
        {
          src: '/vendors/html-docx-js@0.3.1/html-docx.js',
          defer: true,
        },
      ],
    },
  },
  sourcemap: {
    client: sentryAuthToken ? 'hidden' : false,
    server: false,
  },
  nitro: {
    minify: process.env.NODE_ENV === 'production',
    // 开启 wasm 支持（unwasm）：cgi 沙箱 @cf-wasm/quickjs 以 import 方式引入 .wasm 模块，
    // 需要该插件处理（含 edge/CF 约定的 `.wasm?module` 后缀），否则 rollup 无法加载 wasm。
    experimental: {
      wasm: true,
    },
    rollupConfig: {
      external: ['puppeteer'],
    },
    storage: {
      kv: {
        driver: process.env.NITRO_KV_DRIVER || 'memory',
        // cloudflare-kv-binding 驱动使用；Workers 部署时对应 wrangler.toml 中的 KV 绑定名。
        // fs / memory 驱动会忽略该选项，因此对 Docker / 本地 dev 无影响。
        binding: 'KV',
        // base 对 fs 驱动是存储目录(.data/kv)；但对 cloudflare-kv-binding 会变成键前缀，
        // 导致读到 `.data/kv:member:xxx` 而非 `member:xxx` → 键不匹配。故 CF 下不加 base。
        base: process.env.NITRO_KV_DRIVER === 'cloudflare-kv-binding' ? undefined : process.env.NITRO_KV_BASE,
      },
    },
  },
  monacoEditor: {
    locale: 'en',
    componentName: {
      codeEditor: 'MonacoEditor', // 普通编辑器组件名
      diffEditor: 'MonacoDiffEditor', // 差异编辑器组件名
    },
  },
  // https://docs.sentry.io/platforms/javascript/guides/nuxt/manual-setup/
  sentry: {
    org: process.env.NUXT_SENTRY_ORG,
    project: process.env.NUXT_SENTRY_PROJECT,
    authToken: sentryAuthToken,
    sourcemaps: {
      disable: !sentryAuthToken,
      filesToDeleteAfterUpload: sentryAuthToken
        ? ['.*/**/public/**/*.map', './.output/public/**/*.map', './dist/**/*.map']
        : undefined,
    },
    telemetry: false,
  },

  // https://umami.nuxt.dev/api/configuration
  umami: {
    enabled: true,
    id: process.env.NUXT_UMAMI_ID,
    host: process.env.NUXT_UMAMI_HOST,
    domains: ['down.mptext.top'],
    ignoreLocalhost: true,
    autoTrack: true,
    logErrors: true,
  },
});

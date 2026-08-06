import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function loadNuxtConfig(environment: NodeJS.ProcessEnv) {
  const script = `
    import { loadNuxtConfig } from '@nuxt/kit';
    const config = await loadNuxtConfig({ cwd: process.argv[1], dotenv: false });
    console.log(JSON.stringify({
      sourcemap: config.sourcemap,
      sentry: config.sentry,
      hasViteInputWorkaround: typeof config.hooks?.['vite:extendConfig'] === 'function',
      hasLoopbackProofPlugin: config.vite?.plugins?.some(plugin => plugin?.name === 'wechat2md-loopback-proof'),
      hasPrivateLoopbackSecret: typeof config.runtimeConfig?.localApiProxySecret === 'string' && config.runtimeConfig.localApiProxySecret.length >= 64,
      outputDir: config.runtimeConfig?.public?.outputDir,
    }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script, projectRoot], {
    cwd: projectRoot,
    env: environment,
  });
  return JSON.parse(stdout.trim());
}

test('client sourcemaps are disabled without a Sentry auth token', async () => {
  const environment = { ...process.env };
  delete environment.NUXT_SENTRY_AUTH_TOKEN;
  const config = await loadNuxtConfig(environment);

  assert.equal(config.sourcemap.client, false);
  assert.equal(config.sourcemap.server, false);
  assert.equal(config.sentry.sourcemaps.disable, true);
});

test('Sentry token enables hidden client maps and upload cleanup', async () => {
  const config = await loadNuxtConfig({ ...process.env, NUXT_SENTRY_AUTH_TOKEN: 'test-token' });

  assert.equal(config.sourcemap.client, 'hidden');
  assert.equal(config.sentry.sourcemaps.disable, false);
  assert.ok(config.sentry.sourcemaps.filesToDeleteAfterUpload.includes('./.output/public/**/*.map'));
  assert.ok(config.sentry.sourcemaps.filesToDeleteAfterUpload.includes('./dist/**/*.map'));
});

test('server output is public only behind the explicit local flag', async () => {
  const disabled = await loadNuxtConfig({
    ...process.env,
    WECHAT2MD_LOCAL_OUTPUT_ENABLED: 'false',
    WECHAT2MD_OUTPUT_DIR: '/tmp/private-output',
  });
  const enabled = await loadNuxtConfig({
    ...process.env,
    WECHAT2MD_LOCAL_OUTPUT_ENABLED: 'true',
    WECHAT2MD_OUTPUT_DIR: '/tmp/private-output',
  });

  assert.equal(disabled.outputDir, '');
  assert.equal(enabled.outputDir, '/tmp/private-output');
});

test('SPA dev mode keeps the Nuxt 3.21.8 Vite environment workaround enabled', async () => {
  const config = await loadNuxtConfig({ ...process.env });
  const packageJson = JSON.parse(await readFile(`${projectRoot}/package.json`, 'utf8'));
  assert.equal(config.hasViteInputWorkaround, true);
  assert.equal(config.hasLoopbackProofPlugin, true);
  assert.equal(config.hasPrivateLoopbackSecret, true);
  assert.equal(packageJson.devDependencies['@nuxt/kit'], '3.21.8');
  assert.equal(packageJson.scripts.predev, 'node scripts/clean-dev-cache.mjs');
  const cleanupSource = await readFile(`${projectRoot}/scripts/clean-dev-cache.mjs`, 'utf8');
  assert.match(cleanupSource, /'\.nuxt'/);
  assert.match(cleanupSource, /'node_modules\/\.vite'/);
  assert.match(cleanupSource, /'node_modules\/\.cache'/);
  assert.doesNotMatch(cleanupSource, /['"]\.output['"]/);
});

test('sync cancellation and credential lifecycle retain their settlement guards', async () => {
  const accountSource = await readFile(`${projectRoot}/pages/dashboard/account.vue`, 'utf8');
  const articleApiSource = await readFile(`${projectRoot}/apis/index.ts`, 'utf8');
  const articleCacheSource = await readFile(`${projectRoot}/store/v2/article.ts`, 'utf8');
  const credentialSource = await readFile(`${projectRoot}/components/global/CredentialsDialog.vue`, 'utf8');
  const loadProgressSource = await readFile(`${projectRoot}/components/grid/LoadProgress.vue`, 'utf8');
  const publicDiscoverySource = await readFile(`${projectRoot}/shared/utils/public-article-discovery.ts`, 'utf8');

  assert.match(accountSource, /Promise\.race\(\[task, sync\.cancellation\]\)/);
  assert.match(accountSource, /finally\s*\{[\s\S]*activeAccountSync = null/);
  assert.match(accountSource, /controller: new AbortController\(\)/);
  assert.match(accountSource, /sync\.controller\.abort/);
  assert.match(accountSource, /signal: sync\.controller\.signal/);
  assert.match(accountSource, /nextBegin <= pageBegin/);
  assert.doesNotMatch(accountSource, /_load\(account, begin/);
  assert.doesNotMatch(accountSource, /hitCache|getArticleCache/);
  assert.match(articleApiSource, /retryFrequencyControlledRequest/);
  assert.match(articleApiSource, /INTERACTIVE_FREQUENCY_CONTROL_COOLDOWN_MS = 15 \* 60 \* 1000/);
  assert.match(articleApiSource, /backoffMs: \[\]/);
  assert.match(
    articleApiSource,
    /Date\.now\(\) < appmsgpublishFrequencyControlledUntil[\s\S]*getAuthenticatedFallback\(account, 0, keyword, authenticatedFallbackOptions\)/
  );
  assert.match(articleApiSource, /resp\.base_resp\.ret === FREQUENCY_CONTROL_RET/);
  assert.match(
    articleApiSource,
    /resp\.base_resp\.ret === FREQUENCY_CONTROL_RET\)[\s\S]*return getAuthenticatedFallback\(account, 0, keyword, authenticatedFallbackOptions\)/
  );
  assert.match(
    articleApiSource,
    /function getAuthenticatedFallback[\s\S]*getProfileArticleList\(account, begin, keyword, options\)[\s\S]*AuthenticatedArticleListUnavailableError[\s\S]*getPublicArticleList\(account, keyword, options\)/
  );
  assert.match(
    articleApiSource,
    /updateProfileArticleCache\(account, allArticles, \{[\s\S]*completed: false,[\s\S]*replaceCompletion: true,[\s\S]*totalCount/
  );
  assert.match(articleApiSource, /completed: false,[\s\S]*coverage: 'partial'/);
  assert.match(
    articleApiSource,
    /const requestedSource = options\.source \?\? 'public_index';[\s\S]*requestedSource === 'public_index'[\s\S]*getPublicArticleList[\s\S]*options\.source === 'public_index'\) throw error/
  );
  assert.match(accountSource, /let source: ArticleListSource = planAfterLocalReconciliation\(0\)\.nextSource/);
  assert.match(
    accountSource,
    /recoverLocalExportForAccount\(account\)[\s\S]*source = planAfterLocalReconciliation\(local\.canonicalRecords\)\.nextSource/
  );
  assert.doesNotMatch(accountSource, /if \(local(?: &&)? local\.canonicalRecords > 0\)[\s\S]*source: 'local_export'/);
  assert.match(accountSource, /source: 'local_export'/);
  assert.match(accountSource, /allowPublicFallback: false/);
  assert.match(
    accountSource,
    /source !== 'public_index'\) throw error;[\s\S]*planAfterPublicSourceFailure\(local\.canonicalRecords\)[\s\S]*fallbackPlan\.action === 'finish-local-partial'[\s\S]*source = fallbackPlan\.nextSource/
  );
  assert.doesNotMatch(accountSource, /自动补全任务会复用已登录的普通 Chrome/);
  assert.match(accountSource, /本页没有启动普通 Chrome/);
  assert.match(accountSource, /error instanceof AccountSyncCancelledError\) throw error/);
  assert.match(accountSource, /syncWarnings\.push\(`本地导出暂不可用/);
  assert.doesNotMatch(accountSource, /正在立即切换本地备用接口/);
  assert.doesNotMatch(accountSource, /微信读书本地结果已对齐/);
  assert.match(accountSource, /本地导出与公开来源已对齐/);
  assert.match(accountSource, /if \(result\.coverage === 'partial'\)[\s\S]*未标记为完整同步/);
  assert.match(
    accountSource,
    /if \(page\.coverage === 'partial'\)[\s\S]*coverage: 'partial'[\s\S]*stopReason: 'partial-source'/
  );
  assert.doesNotMatch(accountSource, /credential-required/);
  assert.doesNotMatch(accountSource, /source: 'weread'/);
  assert.doesNotMatch(articleApiSource, /\/api\/local\/weread\/article-list/);
  assert.match(accountSource, /getArticleHighWatermark/);
  assert.match(accountSource, /isBoundedOverlapComplete/);
  assert.match(accountSource, /headerName: '完整同步时间'/);
  assert.match(loadProgressSource, /v-if="completed"/);
  assert.match(loadProgressSource, /待完整核验/);
  assert.doesNotMatch(publicDiscoverySource, /TARGET_PROFILES|NewGameOB|游戏吗喽说|新游观察|王董的新游戏/);
  assert.match(articleApiSource, /requireArticleCacheWrite\(async \(\) =>/);
  assert.match(articleApiSource, /articles\.filter\(article => article\.itemidx === 1\)\.length/);
  assert.match(articleCacheSource, /recoverLocalArticleCache[\s\S]*completed: false,[\s\S]*replaceCompletion: true/);

  assert.match(credentialSource, /httpFetchInFlight/);
  assert.match(credentialSource, /version < appliedSnapshotVersion/);
  assert.match(credentialSource, /replaceCredentialSnapshot/);
  assert.match(credentialSource, /if \(items\.length === 0\)[\s\S]*replaceCredentialSnapshot\(\[\]\)/);
  assert.match(credentialSource, /credentialSyncPending = true;[\s\S]*if \(credentialSyncInFlight\) return;/);
  assert.match(credentialSource, /while \(credentialSyncPending && !disposed\)/);
  assert.match(credentialSource, /removeEventListener\('message'/);
  assert.match(credentialSource, /clearCredentialPolling\(\)/);
  assert.match(credentialSource, /ref\('wss:\/\/127\.0\.0\.1:65001'\)/);
  assert.doesNotMatch(credentialSource, /credentials\.value = _credentials/);

  const credentialRoute = await readFile(`${projectRoot}/server/api/local/wechat2md/credentials.post.ts`, 'utf8');
  assert.match(credentialRoute, /setResponseStatus\(event, 422\)/);
  assert.match(credentialRoute, /success: result\.applied/);
  assert.match(credentialSource, /result\?\.success !== true \|\| result\.applied !== true/);
});

test('Markdown server writer uses a same-directory temporary replacement', async () => {
  const source = await readFile(`${projectRoot}/server/utils/wechat2md.ts`, 'utf8');
  assert.match(source, /function writeFileAtomic/);
  assert.match(source, /renameSync\(temporaryPath, path\)/);
  assert.match(source, /writeFileAtomic\(markdownPath, fileContent\)/);
});

test('Exporter parses embedded WeChat values without dynamic code execution', async () => {
  const source = await readFile(`${projectRoot}/utils/download/Exporter.ts`, 'utf8');
  assert.match(source, /extractWechatScriptAssignment/);
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /new\s+Function\s*\(/);
});

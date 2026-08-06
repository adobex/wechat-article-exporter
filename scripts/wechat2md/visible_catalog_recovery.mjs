#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAccountResource, DEFAULT_OUTPUT_ROOT } from './account_resource.mjs';
import {
  applyUrlRepairs,
  auditCatalog,
  planCanonicalUrlRepairs,
  readLocalArticles,
  stableWechatIdentity,
} from './weread_catalog_audit.mjs';

const DEFAULT_SERVICE_ORIGIN = 'http://localhost:3000';
const WORKFLOW_ID = 'wechat-account-visible-recovery';

function normalizeTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value) {
  const match = String(value ?? '').match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function evidenceKey(title, date) {
  return `${normalizeTitle(title)}\u0000${normalizeDate(date)}`;
}

function assertDescendant(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain below ${path.resolve(root)}`);
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertActiveLease(leaseFile, ownerToken, now) {
  const lease = await readJson(leaseFile, 'account lease');
  const normalizedOwner = String(ownerToken || '')
    .trim()
    .toLowerCase();
  if (
    !normalizedOwner ||
    String(lease.owner_token || '')
      .trim()
      .toLowerCase() !== normalizedOwner
  ) {
    throw new Error('account lease is not owned by this run');
  }
  const expiresAt = Date.parse(String(lease.expires_at || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= now().valueOf()) {
    throw new Error('account lease expired before recovery completed');
  }
  return lease;
}

function requireCleanAudit(report, localReadErrors, stage, options = {}) {
  const allowMissing = options.allowMissing === true;
  const blockers = [];
  if (localReadErrors.length) blockers.push(`localReadErrors=${localReadErrors.length}`);
  if (!allowMissing && report.missing.length) blockers.push(`missing=${report.missing.length}`);
  if (report.ambiguous.length) blockers.push(`ambiguous=${report.ambiguous.length}`);
  if (report.dateMismatches.length) blockers.push(`dateMismatches=${report.dateMismatches.length}`);
  if (blockers.length) throw new Error(`${stage} audit failed: ${blockers.join(', ')}`);
}

export function validateOfficialEvidence({ accountName, catalog, evidence, preAudit, stableBiz }) {
  if (evidence?.accountName && normalizeTitle(evidence.accountName) !== normalizeTitle(accountName)) {
    throw new Error('official evidence account name does not match the requested account');
  }
  if (evidence?.stableBiz && String(evidence.stableBiz) !== stableBiz) {
    throw new Error('official evidence stable biz does not match the requested account');
  }
  if (!Array.isArray(evidence?.entries) || evidence.entries.length === 0) {
    throw new Error('official evidence must contain a non-empty entries array');
  }

  const boundary = String(catalog.boundary || '2025-01-01');
  const eligibleByKey = new Map();
  for (const entry of catalog.entries.filter(item => item.publishDate >= boundary)) {
    const key = evidenceKey(entry.title, entry.publishDate);
    const matches = eligibleByKey.get(key) ?? [];
    matches.push(entry);
    eligibleByKey.set(key, matches);
  }

  const normalizedEntries = [];
  const byKey = new Map();
  for (const entry of evidence.entries) {
    const title = normalizeTitle(entry.title);
    const date = normalizeDate(entry.date ?? entry.publishDate);
    const url = String(entry.url ?? '');
    const bodyLength = Number(entry.bodyLength ?? entry.srcdocBytes ?? 0);
    const key = evidenceKey(title, date);
    const identity = stableWechatIdentity(url, stableBiz);
    const catalogMatches = eligibleByKey.get(key) ?? [];

    if (!title || !date || !identity) throw new Error(`invalid official article evidence: ${title || '<untitled>'}`);
    if (!Number.isSafeInteger(bodyLength) || bodyLength <= 0) {
      throw new Error(`official article body is empty: ${title}`);
    }
    if (catalogMatches.length !== 1) {
      throw new Error(`official article does not have one exact catalog match: ${title}`);
    }
    if (byKey.has(key)) throw new Error(`duplicate official article evidence: ${title}`);
    if (entry.stableBiz && String(entry.stableBiz) !== stableBiz) {
      throw new Error(`official article stable biz mismatch: ${title}`);
    }
    if (entry.mid && String(entry.mid) !== identity.mid) throw new Error(`official article mid mismatch: ${title}`);
    if (entry.idx && String(entry.idx) !== identity.idx) throw new Error(`official article idx mismatch: ${title}`);

    const normalized = { ...entry, title, date, url, bodyLength };
    normalizedEntries.push(normalized);
    byKey.set(key, normalized);
  }

  const required = [
    ...preAudit.missing,
    ...preAudit.matched.filter(item => !stableWechatIdentity(item.local.url, stableBiz)).map(item => item.official),
  ];
  for (const entry of required) {
    if (!byKey.has(evidenceKey(entry.title, entry.publishDate))) {
      throw new Error(`missing official URL evidence for recovery: ${entry.title}`);
    }
  }

  return { byKey, entries: normalizedEntries, requiredEntries: required.length };
}

async function requestJson(fetchImpl, url, init, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, { ...init, signal });
  if (!response.ok) throw new Error(`local service request failed: HTTP ${response.status}`);
  return response.json();
}

async function verifyService(fetchImpl, outputRoot, serviceOrigin) {
  if (serviceOrigin !== DEFAULT_SERVICE_ORIGIN) {
    throw new Error(`service origin must be ${DEFAULT_SERVICE_ORIGIN}`);
  }
  const status = await requestJson(fetchImpl, `${serviceOrigin}/api/local/wechat2md/credentials`, {}, 10_000);
  if (status?.success !== true || status.outputDir !== outputRoot) {
    throw new Error('localhost:3000 is not the required local-output service');
  }
}

async function persistRunArtifacts(manifestPath, reportPath, downloadedIndexFiles, report) {
  await writeFile(manifestPath, `${JSON.stringify(Array.from(new Set(downloadedIndexFiles)), null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export async function runVisibleCatalogRecovery(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const resource = buildAccountResource({
    accountName: input.accountName,
    stableBiz: input.stableBiz,
    outputRoot: input.outputRoot ?? DEFAULT_OUTPUT_ROOT,
  });
  const runDir = path.resolve(input.runDir);
  const catalogPath = path.resolve(input.catalog);
  const evidencePath = path.resolve(input.officialArticles);
  const leaseFile = path.resolve(input.leaseFile ?? resource.leaseFile);
  const serviceOrigin = input.serviceOrigin ?? DEFAULT_SERVICE_ORIGIN;
  const manifestPath = path.join(runDir, 'files.json');
  const reportPath = path.join(runDir, `${resource.resourceKey}-visible-recovery-report.json`);
  const backupDir = path.join(runDir, 'backups', 'canonical-url');
  const downloadedIndexFiles = [];
  let report = {
    version: 1,
    workflow_id: WORKFLOW_ID,
    status: 'running',
    account_name: resource.accountName,
    stable_biz: resource.stableBiz,
    resource_key: resource.resourceKey,
    lease_status: 'unchecked',
    source_order_attempted: ['normal_chrome_visible_weread'],
    local_canonical_records: 0,
    local_recovered_articles: 0,
    local_rejected_records: 0,
    weread_initial_directory_entries: 0,
    weread_directory_entries_loaded: 0,
    weread_scroll_steps: 0,
    weread_boundary_reached: false,
    public_index_verified_articles: 0,
    complete_source_probe_status: 'not-attempted',
    downloaded_index_files: downloadedIndexFiles,
    empty_batch: false,
    canonical_url_repairs: 0,
    dashboard_recovered_articles: null,
    dashboard_completion_state: 'unchanged-partial',
    dashboard_reconciliation_required: true,
    warnings: [],
  };

  try {
    assertDescendant(runDir, catalogPath, 'catalog');
    assertDescendant(runDir, evidencePath, 'official article evidence');
    const runMetadata = await readJson(path.join(runDir, 'run.json'), 'run metadata');
    if (String(runMetadata.owner_token || '').toLowerCase() !== String(input.ownerToken || '').toLowerCase()) {
      throw new Error('run artifact owner does not match the active lease owner');
    }
    await assertActiveLease(leaseFile, input.ownerToken, now);
    report.lease_status = 'active';

    const catalog = await readJson(catalogPath, 'visible catalog');
    const evidence = await readJson(evidencePath, 'official article evidence');
    if (catalog.accountName && normalizeTitle(catalog.accountName) !== normalizeTitle(resource.accountName)) {
      throw new Error('catalog account name does not match the requested account');
    }
    if (catalog.stableBiz && String(catalog.stableBiz) !== resource.stableBiz) {
      throw new Error('catalog stable biz does not match the requested account');
    }

    await mkdir(resource.outputDir, { recursive: true });
    const localBefore = await readLocalArticles(resource.outputDir);
    const beforeAudit = auditCatalog(catalog, localBefore.articles);
    requireCleanAudit(beforeAudit, localBefore.errors, 'before-download', { allowMissing: true });
    const official = validateOfficialEvidence({
      accountName: resource.accountName,
      catalog,
      evidence,
      preAudit: beforeAudit,
      stableBiz: resource.stableBiz,
    });

    report.local_canonical_records = localBefore.articles.length;
    report.local_rejected_records = localBefore.errors.length;
    report.weread_initial_directory_entries = catalog.initialDirectoryEntries;
    report.weread_directory_entries_loaded = catalog.directoryEntriesLoaded;
    report.weread_scroll_steps = catalog.scrollSteps;
    report.weread_boundary_reached = catalog.boundaryReached === true;
    report.audit_before = beforeAudit.summary;
    report.official_evidence_entries = official.entries.length;
    report.required_official_evidence_entries = official.requiredEntries;

    if (beforeAudit.missing.length > 0) {
      await verifyService(fetchImpl, resource.outputRoot, serviceOrigin);
    }
    for (const missing of beforeAudit.missing) {
      await assertActiveLease(leaseFile, input.ownerToken, now);
      const evidenceEntry = official.byKey.get(evidenceKey(missing.title, missing.publishDate));
      const payload = {
        url: evidenceEntry.url,
        canonicalUrl: evidenceEntry.url,
        accountName: resource.accountName,
        expectedBiz: resource.stableBiz,
        publishDate: missing.publishDate,
        title: missing.title,
        outputDir: resource.outputRoot,
        mode: 'lite',
        imageMode: 'cdn',
      };
      const result = await requestJson(
        fetchImpl,
        `${serviceOrigin}/api/local/wechat2md`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        130_000
      );
      if (result?.success !== true) throw new Error(`article download failed: ${result?.error || missing.title}`);
      if (normalizeTitle(result.title) !== normalizeTitle(missing.title)) {
        throw new Error(`downloaded article title mismatch: ${missing.title}`);
      }
      const filepath = path.resolve(String(result.filepath || ''));
      assertDescendant(resource.outputDir, filepath, 'downloaded index');
      if (path.basename(filepath) !== 'index.md')
        throw new Error(`download did not produce index.md: ${missing.title}`);
      await readFile(filepath, 'utf8');
      downloadedIndexFiles.push(filepath);
      await persistRunArtifacts(manifestPath, reportPath, downloadedIndexFiles, report);
    }

    const localAfterDownload = await readLocalArticles(resource.outputDir);
    const afterDownloadAudit = auditCatalog(catalog, localAfterDownload.articles);
    requireCleanAudit(afterDownloadAudit, localAfterDownload.errors, 'after-download');
    const officialForAudit = { entries: official.entries };
    let canonicalAudit = planCanonicalUrlRepairs(afterDownloadAudit.matched, officialForAudit, resource.stableBiz);
    if (canonicalAudit.evidenceErrors.length || canonicalAudit.identityMismatches.length) {
      throw new Error(
        `canonical URL audit failed: evidenceErrors=${canonicalAudit.evidenceErrors.length}, identityMismatches=${canonicalAudit.identityMismatches.length}`
      );
    }
    if (canonicalAudit.repairs.length > 0) {
      if (input.applyUrlRepairs !== true) {
        throw new Error(`canonical URL repairs required: ${canonicalAudit.repairs.length}`);
      }
      await assertActiveLease(leaseFile, input.ownerToken, now);
      await applyUrlRepairs(canonicalAudit.repairs, resource.outputDir, backupDir);
      report.canonical_url_repairs = canonicalAudit.repairs.length;
    }

    const localFinal = await readLocalArticles(resource.outputDir);
    const finalAudit = auditCatalog(catalog, localFinal.articles);
    requireCleanAudit(finalAudit, localFinal.errors, 'final');
    canonicalAudit = planCanonicalUrlRepairs(finalAudit.matched, officialForAudit, resource.stableBiz);
    if (
      canonicalAudit.repairs.length ||
      canonicalAudit.evidenceErrors.length ||
      canonicalAudit.identityMismatches.length
    ) {
      throw new Error('final canonical URL audit did not reach zero conflicts');
    }
    const unstableLocalIdentities = finalAudit.matched.filter(
      item => !stableWechatIdentity(item.local.url, resource.stableBiz)
    );
    if (unstableLocalIdentities.length) {
      throw new Error(`final audit still has ${unstableLocalIdentities.length} non-canonical local URLs`);
    }

    report = {
      ...report,
      status: 'complete',
      local_recovered_articles: downloadedIndexFiles.length,
      downloaded_index_files: downloadedIndexFiles,
      empty_batch: downloadedIndexFiles.length === 0,
      audit_after: finalAudit.summary,
      canonical_urls_verified: canonicalAudit.verified.length,
      local_stable_identities_verified: finalAudit.matched.length,
    };
    if (downloadedIndexFiles.length === 0)
      report.warnings.push('No missing official catalog entries; recovery was a no-op.');
    await persistRunArtifacts(manifestPath, reportPath, downloadedIndexFiles, report);
    return { manifestPath, report, reportPath };
  } catch (error) {
    report = {
      ...report,
      status: 'failed',
      local_recovered_articles: downloadedIndexFiles.length,
      downloaded_index_files: downloadedIndexFiles,
      empty_batch: downloadedIndexFiles.length === 0,
      error: error instanceof Error ? error.message : String(error),
    };
    await persistRunArtifacts(manifestPath, reportPath, downloadedIndexFiles, report).catch(() => {});
    throw error;
  }
}

function parseArgs(argv) {
  const allowed = new Set([
    '--account-name',
    '--stable-biz',
    '--catalog',
    '--official-articles',
    '--run-dir',
    '--owner-token',
    '--output-root',
    '--service-origin',
    '--apply-url-repairs',
  ]);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined) throw new Error(`unexpected or incomplete argument: ${flag}`);
    args[flag.slice(2)] = value;
  }
  for (const required of ['account-name', 'stable-biz', 'catalog', 'official-articles', 'run-dir', 'owner-token']) {
    if (!args[required]) throw new Error(`missing required --${required}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runVisibleCatalogRecovery({
    accountName: args['account-name'],
    stableBiz: args['stable-biz'],
    catalog: args.catalog,
    officialArticles: args['official-articles'],
    runDir: args['run-dir'],
    ownerToken: args['owner-token'],
    outputRoot: args['output-root'],
    serviceOrigin: args['service-origin'],
    applyUrlRepairs: args['apply-url-repairs'] === 'true',
  });
  process.stdout.write(
    `${JSON.stringify({ manifestPath: result.manifestPath, reportPath: result.reportPath, ...result.report })}\n`
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

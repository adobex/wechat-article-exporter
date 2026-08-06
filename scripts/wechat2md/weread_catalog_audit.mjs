#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

function normalizeTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function relaxedTitle(value) {
  return normalizeTitle(value)
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  const match = String(value ?? '').match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

export function parseFrontmatter(markdown, filePath = '<memory>') {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Missing YAML frontmatter: ${filePath}`);
  const parsed = YAML.parse(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid YAML frontmatter object: ${filePath}`);
  }
  return parsed;
}

export function replaceFrontmatterDate(markdown, expectedDate, filePath = '<memory>') {
  parseFrontmatter(markdown, filePath);
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const dateLines = [...block[1].matchAll(/^date:\s*.*$/gm)];
  if (dateLines.length !== 1) {
    throw new Error(`Expected exactly one top-level date field: ${filePath}`);
  }
  const nextBlock = block[0].replace(/^date:\s*.*$/m, `date: "${expectedDate}"`);
  return `${nextBlock}${markdown.slice(block[0].length)}`;
}

export function replaceFrontmatterUrl(markdown, actualUrl, expectedUrl, filePath = '<memory>') {
  const parsed = parseFrontmatter(markdown, filePath);
  if (String(parsed.url ?? '') !== actualUrl) {
    throw new Error(`URL changed after audit; refusing repair: ${filePath}`);
  }
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const urlLines = [...block[1].matchAll(/^url:\s*.*$/gm)];
  if (urlLines.length !== 1) {
    throw new Error(`Expected exactly one top-level url field: ${filePath}`);
  }
  const nextBlock = block[0].replace(/^url:\s*.*$/m, `url: ${JSON.stringify(expectedUrl)}`);
  return `${nextBlock}${markdown.slice(block[0].length)}`;
}

function isPositiveInteger(value) {
  const numeric = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(numeric) && numeric > 0;
}

export function stableWechatIdentity(value, expectedBiz = '') {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'mp.weixin.qq.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/s'
    ) {
      return null;
    }
    const biz = url.searchParams.get('__biz') ?? '';
    const mid = url.searchParams.get('mid') ?? url.searchParams.get('appmsgid') ?? '';
    const idx = url.searchParams.get('idx') ?? url.searchParams.get('itemidx') ?? '';
    if (!biz || (expectedBiz && biz !== expectedBiz) || !isPositiveInteger(mid) || !isPositiveInteger(idx)) {
      return null;
    }
    return { biz, mid, idx, key: `${biz}:${mid}:${idx}` };
  } catch {
    return null;
  }
}

function trustedWechatArticleUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'mp.weixin.qq.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      (url.pathname === '/s' || /^\/s\/[^/]+$/.test(url.pathname))
    );
  } catch {
    return false;
  }
}

function articleEvidenceKey(title, date) {
  return `${normalizeTitle(title)}\u0000${normalizeDate(date)}`;
}

export function planCanonicalUrlRepairs(matched, officialArticles, expectedBiz) {
  if (!expectedBiz) throw new Error('Expected biz is required for canonical URL repair');
  const entries = Array.isArray(officialArticles) ? officialArticles : officialArticles?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Official article evidence must contain a non-empty entries array');
  }

  const matchedByKey = new Map();
  for (const item of matched) {
    const key = articleEvidenceKey(item.official.title, item.official.publishDate);
    const values = matchedByKey.get(key) ?? [];
    values.push(item);
    matchedByKey.set(key, values);
  }

  const seenEvidence = new Set();
  const verified = [];
  const repairs = [];
  const identityMismatches = [];
  const evidenceErrors = [];

  for (const entry of entries) {
    const title = String(entry.title ?? '');
    const date = normalizeDate(entry.date ?? entry.publishDate);
    const url = String(entry.url ?? '');
    const key = articleEvidenceKey(title, date);
    if (!normalizeTitle(title) || !date) {
      evidenceErrors.push({ title, date, url, error: 'invalid-title-or-date' });
      continue;
    }
    if (seenEvidence.has(key)) {
      evidenceErrors.push({ title, date, url, error: 'duplicate-title-and-date' });
      continue;
    }
    seenEvidence.add(key);

    const officialIdentity = stableWechatIdentity(url, expectedBiz);
    if (!officialIdentity) {
      evidenceErrors.push({ title, date, url, error: 'invalid-official-canonical-url' });
      continue;
    }
    const localMatches = matchedByKey.get(key) ?? [];
    if (localMatches.length !== 1) {
      evidenceErrors.push({
        title,
        date,
        url,
        error: localMatches.length ? 'ambiguous-local-match' : 'missing-local-match',
      });
      continue;
    }

    const local = localMatches[0].local;
    const localIdentity = stableWechatIdentity(local.url, expectedBiz);
    if (localIdentity) {
      if (localIdentity.key !== officialIdentity.key) {
        identityMismatches.push({
          file: local.file,
          title,
          date,
          actualUrl: local.url,
          expectedUrl: url,
          actualIdentity: localIdentity.key,
          expectedIdentity: officialIdentity.key,
        });
      } else {
        verified.push({ file: local.file, title, date, identity: officialIdentity.key });
      }
      continue;
    }

    if (!trustedWechatArticleUrl(local.url)) {
      evidenceErrors.push({ file: local.file, title, date, url: local.url, error: 'untrusted-local-url' });
      continue;
    }
    try {
      const localUrl = new URL(local.url);
      const explicitBiz = localUrl.searchParams.get('__biz') ?? '';
      const explicitMid = localUrl.searchParams.get('mid') ?? localUrl.searchParams.get('appmsgid') ?? '';
      const explicitIdx = localUrl.searchParams.get('idx') ?? localUrl.searchParams.get('itemidx') ?? '';
      const partialIdentityConflict =
        (explicitBiz && explicitBiz !== officialIdentity.biz) ||
        (explicitMid && (!isPositiveInteger(explicitMid) || Number(explicitMid) !== Number(officialIdentity.mid))) ||
        (explicitIdx && (!isPositiveInteger(explicitIdx) || Number(explicitIdx) !== Number(officialIdentity.idx)));
      if (partialIdentityConflict) {
        identityMismatches.push({
          file: local.file,
          title,
          date,
          actualUrl: local.url,
          expectedUrl: url,
          actualIdentity: { biz: explicitBiz, mid: explicitMid, idx: explicitIdx },
          expectedIdentity: officialIdentity.key,
        });
        continue;
      }
    } catch {
      // trustedWechatArticleUrl already rejects malformed URLs.
    }
    repairs.push({
      file: local.file,
      title,
      date,
      actualUrl: local.url,
      expectedUrl: url,
      expectedIdentity: officialIdentity.key,
    });
  }

  return {
    expectedBiz,
    officialEntries: entries.length,
    matchedEntries: verified.length + repairs.length + identityMismatches.length,
    verified,
    repairs,
    identityMismatches,
    evidenceErrors,
  };
}

async function findIndexFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name === 'index.md') files.push(entryPath);
    }
  }
  await visit(root);
  return files.sort();
}

function addToMap(map, key, value) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function pathContainsDate(filePath, isoDate) {
  return filePath.includes(isoDate.replaceAll('-', ''));
}

function chooseCandidate(entry, candidates, uniqueOfficialTitle) {
  const sameDate = candidates.filter(candidate => candidate.date === entry.publishDate);
  if (sameDate.length === 1) return { local: sameDate[0], confidence: 'title-and-date' };

  const pathDate = candidates.filter(candidate => pathContainsDate(candidate.file, entry.publishDate));
  if (pathDate.length === 1) return { local: pathDate[0], confidence: 'title-and-path-date' };

  if (uniqueOfficialTitle && candidates.length === 1) {
    return { local: candidates[0], confidence: 'unique-title' };
  }

  return null;
}

function validateCatalogCoverage(catalog, boundary) {
  const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDatePattern.test(boundary)) throw new Error(`Invalid catalog boundary: ${boundary}`);
  if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) {
    throw new Error('Catalog entries must be a non-empty array');
  }
  if (catalog.directoryEntriesLoaded !== catalog.entries.length) {
    throw new Error('Catalog loaded count does not match captured entries');
  }
  if (!Number.isInteger(catalog.initialDirectoryEntries) || catalog.initialDirectoryEntries < 1) {
    throw new Error('Catalog is missing the initial directory entry count');
  }
  if (catalog.initialDirectoryEntries > catalog.entries.length) {
    throw new Error('Initial directory entry count exceeds captured entries');
  }
  if (catalog.entries.some(entry => entry.parseError || !isoDatePattern.test(entry.publishDate))) {
    throw new Error('Catalog contains an unparsed or invalid publication date');
  }
  for (let index = 1; index < catalog.entries.length; index += 1) {
    if (catalog.entries[index].publishDate > catalog.entries[index - 1].publishDate) {
      throw new Error(`Catalog publication dates are not newest-first at index ${index}`);
    }
  }
  const initialLastEntry = catalog.entries[catalog.initialDirectoryEntries - 1];
  if (catalog.initialOldestDate !== initialLastEntry.publishDate) {
    throw new Error('Catalog initial oldest date does not match its initial batch');
  }
  const lastEntry = catalog.entries.at(-1);
  if (!lastEntry?.publishDate || catalog.oldestLoadedDate !== lastEntry.publishDate) {
    throw new Error('Catalog oldest date does not match the final captured entry');
  }

  const initialAlreadyCrossed = catalog.initialOldestDate < boundary;
  if (!initialAlreadyCrossed) {
    if (!Number.isInteger(catalog.scrollSteps) || catalog.scrollSteps < 1) {
      throw new Error('Catalog did not record a physical directory scroll');
    }
    if (catalog.directoryEntriesLoaded <= catalog.initialDirectoryEntries) {
      throw new Error('Catalog did not grow beyond its initial lazy-loaded batch');
    }
  }

  if (!catalog.boundaryReached || !catalog.entries.some(entry => entry.publishDate < boundary)) {
    throw new Error(`Catalog does not prove that it crossed boundary ${boundary}`);
  }
}

export function auditCatalog(catalog, localArticles) {
  const boundary = catalog.boundary ?? '2025-01-01';
  validateCatalogCoverage(catalog, boundary);
  const eligible = catalog.entries.filter(entry => !entry.parseError && entry.publishDate >= boundary);

  const exactLocals = new Map();
  const relaxedLocals = new Map();
  const exactOfficialCounts = new Map();
  const relaxedOfficialCounts = new Map();

  for (const article of localArticles) {
    addToMap(exactLocals, normalizeTitle(article.title), article);
    addToMap(relaxedLocals, relaxedTitle(article.title), article);
  }
  for (const entry of eligible) {
    const exactKey = normalizeTitle(entry.title);
    const relaxedKey = relaxedTitle(entry.title);
    exactOfficialCounts.set(exactKey, (exactOfficialCounts.get(exactKey) ?? 0) + 1);
    relaxedOfficialCounts.set(relaxedKey, (relaxedOfficialCounts.get(relaxedKey) ?? 0) + 1);
  }

  const matched = [];
  const missing = [];
  const ambiguous = [];
  const usedFiles = new Set();

  for (const entry of eligible) {
    const exactKey = normalizeTitle(entry.title);
    const exactCandidates = (exactLocals.get(exactKey) ?? []).filter(candidate => !usedFiles.has(candidate.file));
    let selected = chooseCandidate(entry, exactCandidates, exactOfficialCounts.get(exactKey) === 1);

    if (!selected && exactCandidates.length === 0) {
      const key = relaxedTitle(entry.title);
      const relaxedCandidates = (relaxedLocals.get(key) ?? []).filter(candidate => !usedFiles.has(candidate.file));
      if (relaxedOfficialCounts.get(key) === 1 && relaxedCandidates.length === 1) {
        selected = { local: relaxedCandidates[0], confidence: 'unique-relaxed-title' };
      }
    }

    if (selected) {
      usedFiles.add(selected.local.file);
      matched.push({ official: entry, local: selected.local, confidence: selected.confidence });
      continue;
    }

    if (exactCandidates.length > 0) {
      ambiguous.push({ official: entry, candidates: exactCandidates });
    } else {
      missing.push(entry);
    }
  }

  const dateMismatches = matched
    .filter(item => item.local.date !== item.official.publishDate)
    .map(item => ({
      file: item.local.file,
      title: item.official.title,
      actualDate: item.local.date,
      expectedDate: item.official.publishDate,
      confidence: item.confidence,
    }));

  return {
    summary: {
      directoryEntriesLoaded: catalog.directoryEntriesLoaded,
      initialDirectoryEntries: catalog.initialDirectoryEntries,
      scrollSteps: catalog.scrollSteps,
      eligibleEntries: eligible.length,
      localArticles: localArticles.length,
      matched: matched.length,
      missing: missing.length,
      ambiguous: ambiguous.length,
      dateMismatches: dateMismatches.length,
      boundaryReached: true,
      oldestLoadedDate: catalog.oldestLoadedDate,
    },
    missing,
    ambiguous,
    dateMismatches,
    matched,
  };
}

export async function readLocalArticles(accountDir) {
  const files = await findIndexFiles(accountDir);
  const articles = [];
  const errors = [];
  for (const file of files) {
    try {
      const frontmatter = parseFrontmatter(await readFile(file, 'utf8'), file);
      articles.push({
        file,
        title: String(frontmatter.title ?? ''),
        date: normalizeDate(frontmatter.date),
        url: String(frontmatter.url ?? ''),
        sourceEvidence: String(frontmatter.source_evidence ?? ''),
      });
    } catch (error) {
      errors.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { articles, errors };
}

async function applyDateRepairs(dateMismatches, accountDir, backupDir) {
  const applied = [];
  for (const repair of dateMismatches) {
    const original = await readFile(repair.file, 'utf8');
    const parsed = parseFrontmatter(original, repair.file);
    if (normalizeDate(parsed.date) !== repair.actualDate) {
      throw new Error(`Date changed after audit; refusing repair: ${repair.file}`);
    }

    const relative = path.relative(accountDir, repair.file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Repair file escaped account directory: ${repair.file}`);
    }
    const backupFile = path.join(backupDir, relative);
    await mkdir(path.dirname(backupFile), { recursive: true });
    await writeFile(backupFile, original);
    await writeFile(repair.file, replaceFrontmatterDate(original, repair.expectedDate, repair.file));
    applied.push({ ...repair, backupFile });
  }
  return applied;
}

export async function applyUrlRepairs(repairs, accountDir, backupDir) {
  const applied = [];
  for (const repair of repairs) {
    const original = await readFile(repair.file, 'utf8');
    const relative = path.relative(accountDir, repair.file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Repair file escaped account directory: ${repair.file}`);
    }
    const backupFile = path.join(backupDir, relative);
    await mkdir(path.dirname(backupFile), { recursive: true });
    await writeFile(backupFile, original);
    await writeFile(repair.file, replaceFrontmatterUrl(original, repair.actualUrl, repair.expectedUrl, repair.file));
    applied.push({ ...repair, backupFile });
  }
  return applied;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) throw new Error(`Unexpected argument: ${current}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${current}`);
    args[current.slice(2)] = value;
    index += 1;
  }
  for (const required of ['catalog', 'account-dir', 'output']) {
    if (!args[required]) throw new Error(`Missing required --${required}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = JSON.parse(await readFile(path.resolve(args.catalog), 'utf8'));
  const local = await readLocalArticles(path.resolve(args['account-dir']));
  const report = auditCatalog(catalog, local.articles);
  report.localReadErrors = local.errors;

  if (args['apply-date-repairs'] === 'true' && args['apply-url-repairs'] === 'true') {
    throw new Error('Apply date and URL repairs in separate invocations so each backup preserves its exact input');
  }

  if (args['apply-date-repairs'] === 'true') {
    if (!args['backup-dir']) throw new Error('--backup-dir is required when applying repairs');
    if (local.errors.length || report.missing.length || report.ambiguous.length) {
      throw new Error('Refusing date repairs until read errors, missing entries, and ambiguity are zero');
    }
    report.appliedDateRepairs = await applyDateRepairs(
      report.dateMismatches,
      path.resolve(args['account-dir']),
      path.resolve(args['backup-dir'])
    );
  } else {
    report.appliedDateRepairs = [];
  }

  if (args['official-articles']) {
    if (!args['expected-biz']) throw new Error('--expected-biz is required with --official-articles');
    const officialArticles = JSON.parse(await readFile(path.resolve(args['official-articles']), 'utf8'));
    report.canonicalUrlAudit = planCanonicalUrlRepairs(report.matched, officialArticles, args['expected-biz']);
  } else {
    report.canonicalUrlAudit = null;
  }

  if (args['apply-url-repairs'] === 'true') {
    if (!args['official-articles']) throw new Error('--official-articles is required when applying URL repairs');
    if (!args['backup-dir']) throw new Error('--backup-dir is required when applying repairs');
    if (local.errors.length || report.missing.length || report.ambiguous.length || report.dateMismatches.length) {
      throw new Error(
        'Refusing URL repairs until read errors, missing entries, ambiguity, and date mismatches are zero'
      );
    }
    if (report.canonicalUrlAudit.evidenceErrors.length || report.canonicalUrlAudit.identityMismatches.length) {
      throw new Error('Refusing URL repairs while official evidence errors or stable identity conflicts remain');
    }
    report.appliedUrlRepairs = await applyUrlRepairs(
      report.canonicalUrlAudit.repairs,
      path.resolve(args['account-dir']),
      path.resolve(args['backup-dir'])
    );
  } else {
    report.appliedUrlRepairs = [];
  }

  const output = path.resolve(args.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      output,
      ...report.summary,
      localReadErrors: local.errors.length,
      appliedDateRepairs: report.appliedDateRepairs.length,
      officialUrlEntries: report.canonicalUrlAudit?.officialEntries ?? 0,
      canonicalUrlsVerified: report.canonicalUrlAudit?.verified.length ?? 0,
      urlRepairsNeeded: report.canonicalUrlAudit?.repairs.length ?? 0,
      urlIdentityMismatches: report.canonicalUrlAudit?.identityMismatches.length ?? 0,
      officialUrlEvidenceErrors: report.canonicalUrlAudit?.evidenceErrors.length ?? 0,
      appliedUrlRepairs: report.appliedUrlRepairs.length,
    })}\n`
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

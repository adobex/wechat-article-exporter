#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '../..');
export const DEFAULT_OUTPUT_ROOT = '/Users/adobe/Project/output/WechatArticles';

function normalizeAccountName(value) {
  const name = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  const hasControlCharacter = Array.from(name).some(character => character.charCodeAt(0) < 32);
  if (!name || name.length > 80 || name === '.' || name === '..' || /[\\/]/.test(name) || hasControlCharacter) {
    throw new Error('account name must be a safe non-empty directory name');
  }
  return name;
}

function normalizeStableBiz(value) {
  const biz = String(value || '').trim();
  if (!biz || biz.length > 128 || biz.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(biz)) {
    throw new Error('stable biz must be canonical base64');
  }
  const decoded = Buffer.from(biz, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== biz) {
    throw new Error('stable biz must be canonical base64');
  }
  return biz;
}

function assertInside(root, target) {
  const path = relative(root, target);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error('account output directory must be below the output root');
  }
}

export function buildAccountResource({ accountName, outputRoot = DEFAULT_OUTPUT_ROOT, stableBiz }) {
  const name = normalizeAccountName(accountName);
  const biz = normalizeStableBiz(stableBiz);
  const resolvedOutputRoot = resolve(outputRoot);
  const outputDir = resolve(resolvedOutputRoot, name);
  assertInside(resolvedOutputRoot, outputDir);

  const resourceKey = `wechat-account-${createHash('sha256').update(biz).digest('hex').slice(0, 20)}`;
  const stateRoot = resolve(PROJECT_ROOT, '.local/wechat2md-state');
  return {
    accountName: name,
    stableBiz: biz,
    resourceKey,
    outputRoot: resolvedOutputRoot,
    outputDir,
    leaseFile: resolve(stateRoot, 'leases/accounts', `${resourceKey}.json`),
    stateFile: resolve(stateRoot, 'accounts', `${resourceKey}.json`),
    runCatalogTemplate: resolve(PROJECT_ROOT, '.local/wechat2md-runs/<run_id>', `${resourceKey}-weread-catalog.json`),
    runEvidenceTemplate: resolve(
      PROJECT_ROOT,
      '.local/wechat2md-runs/<run_id>',
      `${resourceKey}-official-articles.json`
    ),
  };
}

function parseArguments(argv) {
  const input = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !['--account-name', '--stable-biz', '--output-root'].includes(flag)) {
      throw new Error(
        'Usage: node account_resource.mjs --account-name <name> --stable-biz <biz> [--output-root <path>]'
      );
    }
    if (flag === '--account-name') input.accountName = value;
    if (flag === '--stable-biz') input.stableBiz = value;
    if (flag === '--output-root') input.outputRoot = value;
  }
  return input;
}

async function main() {
  process.stdout.write(`${JSON.stringify(buildAccountResource(parseArguments(process.argv.slice(2))), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

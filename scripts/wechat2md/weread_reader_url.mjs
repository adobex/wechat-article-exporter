#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WEREAD_ORIGIN = 'https://weread.qq.com';

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}

export function stableBizToBookId(stableBiz) {
  const value = String(stableBiz || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid stable biz');
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!/^\d+$/.test(decoded)) throw new Error('Stable biz does not decode to a numeric WeRead id');
  return `MP_WXS_${decoded}`;
}

export function bookIdToReaderKey(bookId) {
  const value = String(bookId || '').trim();
  if (!/^MP_WXS_\d+$/.test(value)) throw new Error('Invalid WeRead book id');
  const digest = md5(value);
  const digestTail = digest.slice(-2);
  const utf8Hex = Buffer.from(value, 'utf8').toString('hex');
  const body = `${digest.slice(0, 3)}4${digestTail.length}${digestTail}${utf8Hex.length.toString(16)}${utf8Hex}`;
  return `${body}${md5(body).slice(0, 3)}`;
}

export function buildReaderRoute({ bookId, stableBiz }) {
  const resolvedBookId = bookId ? String(bookId).trim() : stableBizToBookId(stableBiz);
  const readerKey = bookIdToReaderKey(resolvedBookId);
  return {
    bookId: resolvedBookId,
    readerKey,
    readerUrl: `${WEREAD_ORIGIN}/web/mp/reader/${readerKey}`,
  };
}

function usage() {
  return 'Usage: node weread_reader_url.mjs (--stable-biz <base64> | --book-id <MP_WXS_id>)';
}

function parseArguments(argv) {
  const input = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !['--book-id', '--stable-biz'].includes(flag)) throw new Error(usage());
    if (flag === '--book-id') input.bookId = value;
    if (flag === '--stable-biz') input.stableBiz = value;
  }
  if (Boolean(input.bookId) === Boolean(input.stableBiz)) throw new Error(usage());
  return input;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(buildReaderRoute(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

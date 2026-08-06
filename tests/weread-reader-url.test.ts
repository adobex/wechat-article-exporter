import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve('scripts/wechat2md/weread_reader_url.mjs');

function run(args: string[]) {
  return JSON.parse(execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' }));
}

describe('WeRead reader URL helper', () => {
  it('derives the exact reader route from the stable WeChat biz', () => {
    expect(run(['--stable-biz', 'Mzg5MTcwMTI5Nw=='])).toEqual({
      bookId: 'MP_WXS_3891701297',
      readerKey: '46842cc224d505f5758535f33383931373031323937013',
      readerUrl: 'https://weread.qq.com/web/mp/reader/46842cc224d505f5758535f33383931373031323937013',
    });
  });

  it('accepts a validated WeRead book id directly', () => {
    expect(run(['--book-id', 'MP_WXS_3920725124'])).toMatchObject({
      bookId: 'MP_WXS_3920725124',
      readerKey: '88c428d224d505f5758535f33393230373235313234bb3',
    });
  });

  it('rejects malformed or ambiguous identity input', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--stable-biz', 'bm90LWEtbnVtYmVy'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('numeric WeRead id');
  });
});

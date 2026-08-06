import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const script = resolve('scripts/wechat2md/account_resource.mjs');
const biz = 'MzkyMzY2OTc5Mw==';

function run(accountName: string) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [script, '--account-name', accountName, '--stable-biz', biz, '--output-root', '/tmp/wechat-output'],
      {
        encoding: 'utf8',
      }
    )
  );
}

describe('generic WeChat account resources', () => {
  test('derives stable lease and state ownership from biz rather than display name', () => {
    const first = run('任意公众号');
    const renamed = run('任意公众号新名称');

    expect(first.resourceKey).toMatch(/^wechat-account-[a-f0-9]{20}$/);
    expect(renamed.resourceKey).toBe(first.resourceKey);
    expect(renamed.leaseFile).toBe(first.leaseFile);
    expect(renamed.stateFile).toBe(first.stateFile);
    expect(first.outputDir).toBe('/tmp/wechat-output/任意公众号');
  });

  test('rejects unsafe names and malformed stable identities', () => {
    const unsafeName = spawnSync(process.execPath, [script, '--account-name', '../escape', '--stable-biz', biz], {
      encoding: 'utf8',
    });
    const badBiz = spawnSync(process.execPath, [script, '--account-name', '任意公众号', '--stable-biz', 'not-base64'], {
      encoding: 'utf8',
    });

    expect(unsafeName.status).not.toBe(0);
    expect(badBiz.status).not.toBe(0);
  });
});

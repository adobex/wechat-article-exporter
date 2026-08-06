import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { redactSensitiveData } from '../server/utils/logger';

type GuardUtils = typeof import('../server/middleware/local-api-guard');
type WriteUtils = typeof import('../server/api/local/write-file.post');

let guardUtils: GuardUtils;
let writeUtils: WriteUtils;

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
  guardUtils = await import('../server/middleware/local-api-guard');
  writeUtils = await import('../server/api/local/write-file.post');
});

describe('local API boundaries', () => {
  it('accepts only exact loopback Host and socket forms', () => {
    expect(guardUtils.isLoopbackHost('localhost:3000')).toBe(true);
    expect(guardUtils.isLoopbackHost('[::1]:3000')).toBe(true);
    expect(guardUtils.isLoopbackHost('localhost.evil.test:3000')).toBe(false);
    expect(guardUtils.isLoopbackHost('127.0.0.1.evil.test')).toBe(false);
    expect(guardUtils.isLoopbackHost('127.0.0.2:3000')).toBe(false);
    expect(guardUtils.isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(guardUtils.isLoopbackAddress('192.168.1.10')).toBe(false);
  });

  it('requires an exact unguessable proof when the dev proxy hides the socket address', () => {
    const secret = 'a'.repeat(64);
    expect(guardUtils.isValidLocalApiProxyProof(secret, secret)).toBe(true);
    expect(guardUtils.isValidLocalApiProxyProof('b'.repeat(64), secret)).toBe(false);
    expect(guardUtils.isValidLocalApiProxyProof('a'.repeat(63), secret)).toBe(false);
    expect(guardUtils.isValidLocalApiProxyProof(undefined, secret)).toBe(false);
  });

  it('requires an exact same origin when Origin is present', () => {
    expect(guardUtils.isSameLoopbackOrigin('http://localhost:3000', 'http', 'localhost:3000')).toBe(true);
    expect(guardUtils.isSameLoopbackOrigin('http://127.0.0.1:3000', 'http', 'localhost:3000')).toBe(false);
    expect(guardUtils.isSameLoopbackOrigin('https://localhost:3000', 'http', 'localhost:3000')).toBe(false);
    expect(guardUtils.isSameLoopbackOrigin('null', 'http', 'localhost:3000')).toBe(false);
  });
});

describe('safe local file writes', () => {
  it('uses an atomic temporary file and leaves no residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wae-security-root-'));
    try {
      const target = join(root, 'account', 'article', 'index.md');
      const written = await writeUtils.writeFileSafely(root, target, Buffer.from('safe content'));
      expect(await readFile(written, 'utf8')).toBe('safe content');
      expect((await readdir(join(root, 'account', 'article'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked parent without writing outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wae-security-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'wae-security-outside-'));
    try {
      await mkdir(join(root, 'account'));
      await symlink(outside, join(root, 'account', 'escape'), 'dir');
      const escapedTarget = join(outside, 'escaped.txt');
      await expect(
        writeUtils.writeFileSafely(root, join(root, 'account', 'escape', 'escaped.txt'), Buffer.from('blocked'))
      ).rejects.toThrow(/symbolic link/);
      expect(existsSync(escapedTarget)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects path traversal and oversized decoded payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wae-security-root-'));
    try {
      await expect(
        writeUtils.writeFileSafely(root, join(root, '..', 'escaped.txt'), Buffer.from('blocked'))
      ).rejects.toThrow(/outside/);
      expect(() => writeUtils.decodeBase64Payload(Buffer.from('abc').toString('base64'), 2)).toThrow(/too large/);
      expect(() => writeUtils.decodeBase64Payload('not-base64')).toThrow(/invalid/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('request log redaction', () => {
  it('redacts nested URL, JSON, cookie and authorization secrets', () => {
    const secret = 'do-not-log-this';
    const input = JSON.stringify({
      redirect_url: `/cgi-bin/home?t=home/index&token=${secret}&key=${secret}`,
      headers: { Cookie: `pass_ticket=${secret}; wap_sid2=${secret}`, Authorization: `Bearer ${secret}` },
      appmsg_token: secret,
    });
    const output = redactSensitiveData(input);
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
  });
});

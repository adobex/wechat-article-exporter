import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { H3Event } from 'h3';

const ALLOWED_ROOT = resolve(process.env.WECHAT2MD_OUTPUT_DIR || '/Users/adobe/Project/output/WechatArticles');
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 64 * 1024;

class SafeWriteError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
  );
}

async function ensureDirectoryChain(root: string, targetDirectory: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SafeWriteError('Allowed output root must be a real directory', 500);
  }

  let current = root;
  const segments = relative(root, targetDirectory).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SafeWriteError('Output path contains a symbolic link or non-directory component', 400);
    }
  }
}

async function assertSafeTarget(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SafeWriteError('Output target must be a regular file', 400);
    }
  } catch (error) {
    if (error instanceof SafeWriteError) throw error;
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export function decodeBase64Payload(base64: string, maxBytes = MAX_FILE_BYTES): Buffer {
  if (base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new SafeWriteError('base64 payload is invalid', 400);
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedSize = (base64.length / 4) * 3 - padding;
  if (decodedSize > maxBytes) throw new SafeWriteError('File payload is too large', 413);

  const data = Buffer.from(base64, 'base64');
  if (data.length !== decodedSize || data.toString('base64') !== base64) {
    throw new SafeWriteError('base64 payload is not canonical', 400);
  }
  return data;
}

export async function writeFileSafely(root: string, requestedPath: string, data: Uint8Array): Promise<string> {
  if (!isAbsolute(requestedPath) || requestedPath.includes('\0')) {
    throw new SafeWriteError('Output path must be an absolute path', 400);
  }

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(requestedPath);
  if (!isPathInside(resolvedRoot, resolvedPath)) {
    throw new SafeWriteError('Output path is outside the allowed root', 403);
  }

  const parentDirectory = dirname(resolvedPath);
  await ensureDirectoryChain(resolvedRoot, parentDirectory);
  const canonicalRoot = await realpath(resolvedRoot);
  const canonicalParent = await realpath(parentDirectory);
  if (!isPathInside(canonicalRoot, canonicalParent) && canonicalParent !== canonicalRoot) {
    throw new SafeWriteError('Output directory resolves outside the allowed root', 403);
  }

  const canonicalTarget = join(canonicalParent, basename(resolvedPath));
  await assertSafeTarget(canonicalTarget);
  const temporaryPath = join(canonicalParent, `.${basename(resolvedPath)}.${randomUUID()}.tmp`);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

  try {
    const file = await open(temporaryPath, flags, 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }

    if ((await realpath(parentDirectory)) !== canonicalParent) {
      throw new SafeWriteError('Output directory changed during write', 409);
    }
    await assertSafeTarget(canonicalTarget);
    await rename(temporaryPath, canonicalTarget);
    return canonicalTarget;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function readLimitedJsonBody(event: H3Event): Promise<unknown> {
  const contentType = getRequestHeader(event, 'content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new SafeWriteError('Content-Type must be application/json', 415);
  }

  const contentLengthHeader = getRequestHeader(event, 'content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new SafeWriteError('Content-Length is invalid', 400);
    }
    if (contentLength > MAX_REQUEST_BYTES) throw new SafeWriteError('Request payload is too large', 413);
  }

  const stream = getRequestWebStream(event);
  if (!stream) throw new SafeWriteError('Request body is required', 400);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new SafeWriteError('Request payload is too large', 413);
    }
    chunks.push(value);
  }

  try {
    return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'));
  } catch {
    throw new SafeWriteError('Request body must be valid JSON', 400);
  }
}

export default defineEventHandler(async event => {
  try {
    const body = await readLimitedJsonBody(event);
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as Record<string, unknown>).path !== 'string' ||
      typeof (body as Record<string, unknown>).base64 !== 'string'
    ) {
      throw new SafeWriteError('path and base64 are required', 400);
    }

    const requestedPath = (body as { path: string }).path;
    const data = decodeBase64Payload((body as { base64: string }).base64);
    const writtenPath = await writeFileSafely(ALLOWED_ROOT, requestedPath, data);
    return { success: true, path: writtenPath };
  } catch (error) {
    if (error instanceof SafeWriteError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw createError({ statusCode: 500, statusMessage: 'Failed to write output file' });
  }
});

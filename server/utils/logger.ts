import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFilePath = path.resolve(__dirname, '.data/request.log');
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PARTS = new Set([
  'auth',
  'authorization',
  'cookie',
  'key',
  'passwd',
  'password',
  'secret',
  'session',
  'sessionid',
  'sid',
  'token',
  'uin',
  'uuid',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const parts = normalized.split('_').filter(Boolean);
  return (
    parts.some(part => SENSITIVE_KEY_PARTS.has(part)) ||
    normalized.includes('pass_ticket') ||
    normalized.includes('wap_sid')
  );
}

function redactStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, isSensitiveKey(key) ? REDACTED : redactStructuredValue(entry)])
    );
  }
  return typeof value === 'string' ? redactSensitiveData(value) : value;
}

function redactInlinePairs(value: string): string {
  let output = value.replace(
    /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)(["'])(.*?)\4/g,
    (match, quote, key, separator, valueQuote) =>
      isSensitiveKey(key) ? `${quote}${key}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}` : match
  );
  output = output.replace(/(^|[?&;,\s])([A-Za-z0-9_.-]+)(\s*=\s*)([^&;,\s]*)/g, (match, prefix, key, separator) =>
    isSensitiveKey(key) ? `${prefix}${key}${separator}${encodeURIComponent(REDACTED)}` : match
  );
  output = output.replace(/(^|[,{;\s])([A-Za-z0-9_.-]+)(\s*:\s*)([^,}\s]+)/g, (match, prefix, key, separator) =>
    isSensitiveKey(key) ? `${prefix}${key}${separator}${REDACTED}` : match
  );
  return output.replace(/^([^:\r\n]+):[ \t]*(.*)$/gm, (match, key) =>
    isSensitiveKey(key) ? `${key}: ${REDACTED}` : match
  );
}

export function redactSensitiveData(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactStructuredValue(JSON.parse(value)), null, 2);
    } catch {
      // Fall through to conservative key/value redaction for malformed JSON.
    }
  }
  return redactInlinePairs(value);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const [key, entry] of [...url.searchParams.entries()]) {
      url.searchParams.set(key, isSensitiveKey(key) ? REDACTED : redactSensitiveData(entry));
    }
    return url.toString();
  } catch {
    return redactSensitiveData(value);
  }
}

function formatHeaders(headers: Headers): string {
  return [...headers.entries()]
    .map(([key, value]) => `${key}: ${isSensitiveKey(key) ? REDACTED : redactSensitiveData(value)}`)
    .join('\n');
}

// 写入日志文件
function logToFile(prefix: string, message: string) {
  // 确保日志目录存在
  const logDir = path.dirname(logFilePath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const logEntry = `[${prefix} ${timestamp}]\n${message}\n\n\n`;
  fs.appendFileSync(logFilePath, logEntry, 'utf8');
}

// 记录 HTTP 请求报文
export async function logRequest(requestId: string, request: Request) {
  // 读取请求体
  let requestBody = '<nil>';
  if (request.body) {
    requestBody = await request.text();
  }

  const requestLog = `Request-ID: ${requestId}
${request.method} ${redactUrl(request.url)} HTTP/1.1
Host: ${new URL(request.url).host}
${formatHeaders(request.headers)}

${redactSensitiveData(requestBody)}`;
  logToFile('请求', requestLog);
}

// 记录 HTTP 响应报文
export async function logResponse(requestId: string, response: Response) {
  let responseBody = redactSensitiveData(await response.text());
  // 日志里面只需要记录一部分即可，因为主要目的是查看整个通信过程
  responseBody = responseBody.length > 200 ? `${responseBody.slice(0, 200)}...` : responseBody;

  const responseLog = `Request-ID: ${requestId}
HTTP/1.1 ${response.status} ${response.statusText}
${formatHeaders(response.headers)}
${responseBody ? `\n${responseBody}` : '\n<nil>'}`;
  logToFile('响应', responseLog);
}

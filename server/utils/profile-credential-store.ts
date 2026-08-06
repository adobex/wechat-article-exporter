import { CREDENTIAL_LIVE_MINUTES } from '~/config';

export interface ProfileCredential {
  biz: string;
  uin: string;
  key: string;
  pass_ticket: string;
  wap_sid2: string;
  appmsg_token: string;
  cookie: string;
  timestamp: number;
  nickname?: string;
  expiresAt: number;
}

export interface ProfileCredentialStatus {
  biz: string;
  nickname?: string;
  capturedAt: string;
  expiresAt: string;
}

const LIVE_MILLISECONDS = CREDENTIAL_LIVE_MINUTES * 60 * 1000;
const MAX_CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1000;
const credentials = new Map<string, ProfileCredential>();

function boundedString(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result.length <= maximumLength ? result : '';
}

function cleanCookie(value: unknown): string {
  return boundedString(value, 16 * 1024).replace(/[\r\n]/g, '');
}

export function parseFreshProfileCredential(value: unknown, now = Date.now()): ProfileCredential | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + MAX_CLOCK_SKEW_MILLISECONDS) return null;

  const credential: ProfileCredential = {
    biz: boundedString(input.biz, 256),
    uin: boundedString(input.uin, 256),
    key: boundedString(input.key, 4096),
    pass_ticket: boundedString(input.pass_ticket, 4096),
    wap_sid2: boundedString(input.wap_sid2, 4096),
    appmsg_token: boundedString(input.appmsg_token, 4096),
    cookie: cleanCookie(input.cookie),
    timestamp,
    nickname: boundedString(input.nickname, 256) || undefined,
    expiresAt: timestamp + LIVE_MILLISECONDS,
  };
  if (!credential.biz || !credential.uin || !credential.key || !credential.pass_ticket) return null;
  if (!credential.cookie && !credential.wap_sid2) return null;
  if (credential.expiresAt <= now) return null;
  return credential;
}

function removeExpired(now = Date.now()): void {
  for (const [biz, credential] of credentials) {
    if (credential.expiresAt <= now) credentials.delete(biz);
  }
}

export function storeProfileCredentialSnapshot(values: unknown, now = Date.now()) {
  removeExpired(now);
  if (!Array.isArray(values) || values.length > 100) {
    return {
      accepted: 0,
      rejected: Array.isArray(values) ? values.length : 0,
      active: credentials.size,
      applied: false,
    };
  }

  const nextCredentials = new Map<string, ProfileCredential>();
  const items = values;
  let accepted = 0;
  for (const value of items) {
    const credential = parseFreshProfileCredential(value, now);
    if (!credential) continue;
    const current = credentials.get(credential.biz);
    const next = nextCredentials.get(credential.biz);
    let newest = credential;
    if (current && current.timestamp > newest.timestamp) newest = current;
    if (next && next.timestamp > newest.timestamp) newest = next;
    nextCredentials.set(credential.biz, newest);
    accepted += 1;
  }

  credentials.clear();
  for (const [biz, credential] of nextCredentials) credentials.set(biz, credential);
  return { accepted, rejected: items.length - accepted, active: credentials.size, applied: true };
}

export function getProfileCredential(biz: string, now = Date.now()): ProfileCredential | null {
  removeExpired(now);
  return credentials.get(biz) || null;
}

export function listProfileCredentialStatus(now = Date.now()): ProfileCredentialStatus[] {
  removeExpired(now);
  return Array.from(credentials.values(), credential => ({
    biz: credential.biz,
    nickname: credential.nickname,
    capturedAt: new Date(credential.timestamp).toISOString(),
    expiresAt: new Date(credential.expiresAt).toISOString(),
  })).sort((left, right) => left.biz.localeCompare(right.biz));
}

export function clearProfileCredentials(): void {
  credentials.clear();
}

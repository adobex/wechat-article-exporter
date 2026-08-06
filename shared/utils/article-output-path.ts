const UNKNOWN_ACCOUNT_DIRECTORY = '未知公众号';
const UNTITLED_ARTICLE_DIRECTORY = '未命名文章';
const MAX_ACCOUNT_DIRECTORY_LENGTH = 80;
const MAX_TITLE_DIRECTORY_LENGTH = 120;
const HASH_LENGTHS = [8, 12, 16, 40] as const;
const WECHAT_ARTICLE_IDENTITY_PARAMS = new Set(['__biz', 'mid', 'idx', 'sn']);

export interface ArticleOutputIdentity {
  url: string;
  accountName?: string | null;
  title?: string | null;
  publishDate?: string | null;
}

export interface ExistingArticleOutput {
  relativeDirectory: string;
  url?: string | null;
}

export interface ArticleOutputPlan {
  relativeDirectory: string;
  accountDirectory: string;
  titleDirectory: string;
  normalizedUrl: string;
  collision: boolean;
}

export interface ArticleOutputPlanningOptions {
  existing?: ExistingArticleOutput[];
  readExisting?: (relativeDirectory: string) => Promise<{ url?: string | null } | undefined>;
}

export function normalizeArticleUrl(value: string): string {
  const trimmed = String(value ?? '').trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.username = '';
    url.password = '';

    if (url.hostname.toLowerCase() === 'mp.weixin.qq.com') {
      url.protocol = 'https:';
      url.hostname = 'mp.weixin.qq.com';
      if (url.pathname === '/s' && [...WECHAT_ARTICLE_IDENTITY_PARAMS].some(key => url.searchParams.has(key))) {
        for (const key of [...url.searchParams.keys()]) {
          if (!WECHAT_ARTICLE_IDENTITY_PARAMS.has(key)) url.searchParams.delete(key);
        }
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function sanitizeArticlePathSegment(value: string | null | undefined, fallback: string): string {
  const withoutControlCharacters = Array.from(String(value ?? ''), character =>
    character.charCodeAt(0) <= 0x1f ? '-' : character
  ).join('');
  const sanitized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || fallback;
}

export function getArticleOutputBase(identity: ArticleOutputIdentity): {
  accountDirectory: string;
  titleDirectory: string;
  relativeDirectory: string;
} {
  const accountDirectory = Array.from(sanitizeArticlePathSegment(identity.accountName, UNKNOWN_ACCOUNT_DIRECTORY))
    .slice(0, MAX_ACCOUNT_DIRECTORY_LENGTH)
    .join('');
  const titleDirectory = Array.from(sanitizeArticlePathSegment(identity.title, UNTITLED_ARTICLE_DIRECTORY))
    .slice(0, MAX_TITLE_DIRECTORY_LENGTH)
    .join('');
  return {
    accountDirectory,
    titleDirectory,
    relativeDirectory: `${accountDirectory}/${titleDirectory}`,
  };
}

export function articlePublishDateSlug(value: string | null | undefined): string {
  const match = String(value ?? '').match(/^(\d{4})[-/.\u5e74]?(\d{1,2})[-/.\u6708]?(\d{1,2})/);
  if (!match) return '';
  const [, year, month, day] = match;
  return `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}`;
}

export async function articleUrlHash(value: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeArticleUrl(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function readArticleUrlFromMarkdown(content: string): string | undefined {
  const match = content.match(/^url:\s*(.+)$/m);
  if (!match) return undefined;

  const raw = match[1].trim();
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return raw.replace(/^['"]|['"]$/g, '');
  }
}

function normalizeRelativeDirectory(value: string): string | undefined {
  const normalized = String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    return undefined;
  }
  return normalized;
}

function normalizeExistingUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeArticleUrl(value);
  return normalized || null;
}

function createPlan(
  relativeDirectory: string,
  accountDirectory: string,
  titleDirectory: string,
  normalizedUrl: string,
  baseDirectory: string
): ArticleOutputPlan {
  return {
    relativeDirectory,
    accountDirectory,
    titleDirectory,
    normalizedUrl,
    collision: relativeDirectory !== baseDirectory,
  };
}

export function assertUniqueArticleOutputTargets(plans: ArticleOutputPlan[]): void {
  const owners = new Map<string, string>();
  for (const plan of plans) {
    const owner = owners.get(plan.relativeDirectory);
    if (owner && owner !== plan.normalizedUrl) {
      throw new Error(`文章输出路径冲突: ${plan.relativeDirectory} 同时分配给 ${owner} 和 ${plan.normalizedUrl}`);
    }
    owners.set(plan.relativeDirectory, plan.normalizedUrl);
  }
}

export async function planArticleOutputPaths(
  identities: ArticleOutputIdentity[],
  options: ArticleOutputPlanningOptions = {}
): Promise<ArticleOutputPlan[]> {
  const occupied = new Map<string, string | null>();
  for (const item of options.existing || []) {
    const relativeDirectory = normalizeRelativeDirectory(item.relativeDirectory);
    if (!relativeDirectory) continue;
    occupied.set(relativeDirectory, normalizeExistingUrl(item.url));
  }

  const inspect = async (relativeDirectory: string): Promise<string | null | undefined> => {
    if (occupied.has(relativeDirectory)) {
      return occupied.get(relativeDirectory);
    }
    const existing = await options.readExisting?.(relativeDirectory);
    if (!existing) return undefined;
    const normalizedUrl = normalizeExistingUrl(existing.url);
    occupied.set(relativeDirectory, normalizedUrl);
    return normalizedUrl;
  };

  const plans: ArticleOutputPlan[] = [];
  for (const identity of identities) {
    const normalizedUrl = normalizeArticleUrl(identity.url);
    if (!normalizedUrl) {
      throw new Error('文章 URL 不能为空');
    }

    const base = getArticleOutputBase(identity);

    // Reuse an already known path for the same URL before considering title/date changes.
    const knownPath = Array.from(occupied.entries()).find(([, owner]) => owner === normalizedUrl)?.[0];
    if (knownPath) {
      plans.push(
        createPlan(knownPath, base.accountDirectory, base.titleDirectory, normalizedUrl, base.relativeDirectory)
      );
      continue;
    }

    const baseOwner = await inspect(base.relativeDirectory);
    if (baseOwner === undefined || baseOwner === normalizedUrl) {
      occupied.set(base.relativeDirectory, normalizedUrl);
      plans.push(
        createPlan(
          base.relativeDirectory,
          base.accountDirectory,
          base.titleDirectory,
          normalizedUrl,
          base.relativeDirectory
        )
      );
      continue;
    }

    const dateSlug = articlePublishDateSlug(identity.publishDate);
    const hash = await articleUrlHash(normalizedUrl);
    let selectedDirectory = '';

    for (const hashLength of HASH_LENGTHS) {
      const suffix = [dateSlug, hash.slice(0, hashLength)].filter(Boolean).join('-');
      const candidate = `${base.relativeDirectory}--${suffix}`;
      const candidateOwner = await inspect(candidate);
      if (candidateOwner === undefined || candidateOwner === normalizedUrl) {
        selectedDirectory = candidate;
        break;
      }
    }

    if (!selectedDirectory) {
      const suffix = [dateSlug, hash].filter(Boolean).join('-');
      for (let index = 2; !selectedDirectory; index++) {
        const candidate = `${base.relativeDirectory}--${suffix}-${index}`;
        const candidateOwner = await inspect(candidate);
        if (candidateOwner === undefined || candidateOwner === normalizedUrl) {
          selectedDirectory = candidate;
        }
      }
    }

    occupied.set(selectedDirectory, normalizedUrl);
    plans.push(
      createPlan(selectedDirectory, base.accountDirectory, base.titleDirectory, normalizedUrl, base.relativeDirectory)
    );
  }

  assertUniqueArticleOutputTargets(plans);
  return plans;
}

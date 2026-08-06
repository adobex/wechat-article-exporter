import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { resolveWechat2MdOutputRoot } from '~/server/utils/wechat2md';

const MAX_MARKDOWN_FILES = 10_000;

interface Wechat2mdManifestEntry {
  title: string;
  accountName: string;
  publishDate: string;
  url: string;
  filepath: string;
  articleDir: string;
  relativePath: string;
  mtimeMs: number;
}

export default defineEventHandler(async event => {
  const query = getQuery<{ outputDir?: string }>(event);
  let outputDir: string;
  try {
    outputDir = resolveWechat2MdOutputRoot(query.outputDir ? String(query.outputDir) : undefined);
  } catch (e: any) {
    return {
      success: false,
      error: e?.message || '输出目录不合法',
      outputDir: query.outputDir || '',
      records: [],
    };
  }

  try {
    const files = await findMarkdownIndexes(outputDir);
    const records: Wechat2mdManifestEntry[] = [];
    let skipped = 0;

    for (const file of files) {
      const content = await readFile(file, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const url = frontmatter.url || '';
      if (!url) {
        skipped++;
        continue;
      }

      const fileStat = await stat(file);
      records.push({
        title: frontmatter.title || basenameFallback(file),
        accountName: frontmatter.author || frontmatter.accountName || parentFallback(file),
        publishDate: frontmatter.date || '',
        url,
        filepath: file,
        articleDir: dirname(file),
        relativePath: relative(outputDir, file),
        mtimeMs: fileStat.mtimeMs,
      });
    }

    records.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return {
      success: true,
      outputDir,
      total: files.length,
      skipped,
      records,
    };
  } catch (e: any) {
    return {
      success: false,
      error: e?.message || '扫描 wechat2md 导出记录失败',
      outputDir,
      records: [],
    };
  }
});

async function findMarkdownIndexes(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string) {
    if (files.length >= MAX_MARKDOWN_FILES) return;

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_MARKDOWN_FILES) return;
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'images') continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name === 'index.md') {
        files.push(fullPath);
      }
    }
  }

  await walk(root);
  return files;
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {};

  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};

  const frontmatter = content.slice(3, end).trim();
  const data: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = parseScalar(match[2]);
  }
  return data;
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {}
    return value.slice(1, -1);
  }
  return value;
}

function basenameFallback(file: string): string {
  return dirname(file).split('/').at(-1) || '未命名文章';
}

function parentFallback(file: string): string {
  return dirname(dirname(file)).split('/').at(-1) || '未知公众号';
}

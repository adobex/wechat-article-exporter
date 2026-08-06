#!/usr/bin/env python3
"""
Extract product entries from wechat2md articles.

Products follow this pattern in articles:
  Line: "{Product Name}     {Publisher}"  (3+ spaces separator)
  Followed by: images, store URLs, commentary

Also handles structured format:
  游戏名字：{name}
  游戏公司：{company}
  游戏类型：{type}
"""

import os
import re
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
WECHAT_DIR = Path("/Users/adobe/Project/output/WechatArticles")
ANALYSIS_DIR = PROJECT_ROOT / ".local" / "wechat2md-analysis"
PRODUCTS_DIR = ANALYSIS_DIR / "products"
OUTPUT_FILE = PRODUCTS_DIR / "wechat2md-products.json"

GP_PATTERN = re.compile(r'https://play\.google\.com/store/apps/details[^\s\)\"\']+')
AS_PATTERN = re.compile(r'https://apps\.apple\.com/[^\s\)\"\']+')

# Product header: name (with possible Chinese or English), 3+ spaces, publisher
# Must not start with common non-product patterns
PRODUCT_LINE_RE = re.compile(
    r'^(?:\d+\.)?'                  # optional "1." prefix
    r'([A-Za-z\u4e00-\u9fff][^\t\n]{1,70}?)'  # name (starts with letter/chinese)
    r'[ \t\xa0]{3,}'               # 3+ spaces/tabs/NBSP separator (WeChat uses \xa0)
    r'([A-Za-z\u4e00-\u9fff][^\n\t]{1,100})'  # publisher
    r'\s*$'
)

STRUCTURED_FIELDS = {
    '游戏名字': re.compile(r'^游戏名字[：:]\s*(.+)$'),
    '游戏公司': re.compile(r'^游戏公司[：:]\s*(.+)$'),
    '游戏类型': re.compile(r'^游戏类型[：:]\s*(.+)$'),
    '上线地区': re.compile(r'^上线国家和地区[：:]\s*(.+)$'),
    '平台': re.compile(r'^平台[：:]\s*(.+)$'),
}

# Lines that can never be product headers
SKIP_STARTS = ('![', 'http', '#', '---', '  ', '\t', '>', '-', '*', '|')


def is_product_header(line):
    """Check if a line looks like a product header."""
    stripped = line.strip()
    if not stripped:
        return False
    for s in SKIP_STARTS:
        if stripped.startswith(s):
            return False
    return bool(PRODUCT_LINE_RE.match(stripped))


def extract_store_urls(text):
    """Extract store URLs from text."""
    result = {}
    gp = GP_PATTERN.findall(text)
    if gp:
        result['google_play'] = gp[0]
        pkg = re.search(r'[?&]id=([^&\s\)\"\']+)', gp[0])
        if pkg:
            result['package_id'] = pkg.group(1)
    ap = AS_PATTERN.findall(text)
    if ap:
        result['app_store'] = ap[0]
    return result


def extract_chinese_hint(text):
    """Extract Chinese company hints from commentary (e.g., 'fp的吗？' -> 'FunPlus')."""
    hints = []
    # Patterns like "XXX的吗？" / "就是XXX呗" / "就是XXX吧"
    patterns = [
        re.compile(r'([\u4e00-\u9fff A-Za-z]{2,20})的[吗吧？?]+'),
        re.compile(r'也就是([\u4e00-\u9fff A-Za-z]{2,20})[呗吧了]'),
        re.compile(r'就是([\u4e00-\u9fff A-Za-z]{2,20})[呗吧了]'),
        re.compile(r'([\u4e00-\u9fff A-Za-z]{2,20})的[吧吗呗]'),
    ]
    for p in patterns:
        for m in p.findall(text):
            hint = m.strip()
            if len(hint) >= 2 and not hint.startswith(('这', '那', '他', '她', '它', '我', '你', '都', '还', '也', '就', '很')):
                hints.append(hint)
    return hints[:3]  # max 3 hints


def parse_article(article_dir):
    """Parse a single article directory, return list of product dicts."""
    index_file = article_dir / "index.md"
    if not index_file.exists():
        return []

    content = index_file.read_text(encoding='utf-8')
    lines = content.split('\n')

    # Skip frontmatter
    fm_end = 0
    if lines and lines[0].strip() == '---':
        for i in range(1, min(20, len(lines))):
            if lines[i].strip() == '---':
                fm_end = i + 1
                break

    # Parse article metadata
    meta = {}
    fm_text = '\n'.join(lines[:fm_end])
    for field in ('author', 'date', 'url', 'title'):
        m = re.search(rf'^{field}:\s*"?(.+?)"?\s*$', fm_text, re.MULTILINE)
        if m:
            meta[field] = m.group(1).strip()

    body_lines = lines[fm_end:]
    products = []

    # === Method 1: Structured blocks ===
    structured = []
    current = {}
    for line in body_lines:
        stripped = line.strip()
        matched = False
        for field_key, pattern in STRUCTURED_FIELDS.items():
            m = pattern.match(stripped)
            if m:
                if field_key == '游戏名字':
                    if current.get('name'):
                        structured.append(current)
                    current = {'name': m.group(1).strip(), 'source': 'structured'}
                elif current.get('name'):
                    key_map = {'游戏公司': 'publisher', '游戏类型': 'type', '上线地区': 'regions', '平台': 'platform'}
                    current[key_map[field_key]] = m.group(1).strip()
                matched = True
                break
    if current.get('name'):
        structured.append(current)

    structured_names = {s['name'] for s in structured}

    # === Method 2: Inline "Product Name     Publisher" ===
    # Split body into "blocks": each block is from one product header to the next
    # A block contains: header line + images + store URLs + commentary

    blocks = []  # list of (header_line, block_text)
    current_header = None
    current_block_lines = []

    for line in body_lines:
        if is_product_header(line):
            if current_header is not None:
                blocks.append((current_header, '\n'.join(current_block_lines)))
            current_header = line.strip()
            current_block_lines = []
        else:
            if current_header is not None:
                current_block_lines.append(line)

    if current_header is not None:
        blocks.append((current_header, '\n'.join(current_block_lines)))

    inline = []
    for header, block_text in blocks:
        m = PRODUCT_LINE_RE.match(header)
        if not m:
            continue
        name = m.group(1).strip()
        publisher = m.group(2).strip()

        if name in structured_names:
            # Will be handled by structured method, just add URLs
            for s in structured:
                if s['name'] == name:
                    urls = extract_store_urls(block_text)
                    s.update(urls)
            continue

        entry = {
            'name': name,
            'publisher': publisher,
            'source': 'inline',
        }
        urls = extract_store_urls(block_text)
        entry.update(urls)
        hints = extract_chinese_hint(block_text)
        if hints:
            entry['chinese_hints'] = hints
        inline.append(entry)

    # Merge all
    for p in structured + inline:
        entry = {
            'article_author': meta.get('author', ''),
            'article_date': meta.get('date', ''),
            'article_url': meta.get('url', ''),
            'article_title': meta.get('title', article_dir.name),
            **p
        }
        products.append(entry)

    return products


def main():
    PRODUCTS_DIR.mkdir(parents=True, exist_ok=True)
    all_products = []
    article_dirs = sorted(WECHAT_DIR.iterdir())

    processed = 0
    skipped_empty = 0

    for article_dir in article_dirs:
        if not article_dir.is_dir():
            continue
        if article_dir.name.startswith('未知公众号'):
            skipped_empty += 1
            continue

        products = parse_article(article_dir)
        all_products.extend(products)
        processed += 1

    print(f"Processed {processed} articles, skipped {skipped_empty} empty articles")
    print(f"Total raw product entries: {len(all_products)}")

    # Deduplicate by product name (case-insensitive)
    # Keep most information-rich entry
    seen = {}
    for p in all_products:
        key = p.get('name', '').lower().strip()
        if not key or len(key) < 2:
            continue
        if key not in seen:
            seen[key] = p
        else:
            existing = seen[key]
            # Prefer entry with store URL
            if p.get('package_id') and not existing.get('package_id'):
                seen[key] = p
            elif not existing.get('package_id') and not p.get('package_id'):
                # Keep the one with more fields
                if len(p) > len(existing):
                    seen[key] = p

    unique_products = list(seen.values())
    unique_products.sort(key=lambda x: x.get('name', '').lower())

    print(f"Unique products after dedup: {len(unique_products)}")

    OUTPUT_FILE.write_text(json.dumps(unique_products, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Saved to {OUTPUT_FILE}")

    # Stats
    with_gp = sum(1 for p in unique_products if p.get('google_play'))
    with_as = sum(1 for p in unique_products if p.get('app_store'))
    with_pkg = sum(1 for p in unique_products if p.get('package_id'))
    with_hints = sum(1 for p in unique_products if p.get('chinese_hints'))

    print(f"\nStats:")
    print(f"  With Google Play URL: {with_gp}")
    print(f"  With App Store URL: {with_as}")
    print(f"  With package ID: {with_pkg}")
    print(f"  With Chinese entity hints: {with_hints}")

    # Sample
    print("\nSample (first 15 with most info):")
    rich = sorted(unique_products, key=lambda x: len(x), reverse=True)[:15]
    for p in rich:
        print(f"  {p.get('name', 'N/A')[:40]:40} | {p.get('publisher','?')[:30]:30} | pkg={p.get('package_id','')[:40]}")


if __name__ == '__main__':
    main()

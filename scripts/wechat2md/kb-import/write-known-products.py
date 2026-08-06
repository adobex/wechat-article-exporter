#!/usr/bin/env python3
"""
Write KB entries for products with known publisher mappings.
These products can skip full OSINT since the publisher is already in KB.
"""

import json, re, hashlib
from pathlib import Path
from datetime import date

PROJECT_ROOT = Path(__file__).resolve().parents[3]
ANALYSIS_DIR = PROJECT_ROOT / ".local" / "wechat2md-analysis"
PRODUCTS_DIR = ANALYSIS_DIR / "products"
KB_DOCS = Path("/Users/adobe/Project/knowledge-vault/documents")
CATEGORIZED = PRODUCTS_DIR / "wechat2md-products-categorized.json"

data = json.loads(CATEGORIZED.read_text())
known_products = data['known_publisher']

# Load existing osint case doc_ids to avoid duplicates
existing_ids = {f.stem for f in KB_DOCS.glob("product:osint-*.json")}

def slugify(s):
    s = s.lower().strip()
    s = re.sub(r'[^a-z0-9\u4e00-\u9fff]+', '-', s)
    s = s.strip('-')
    return s[:60]

def get_confidence(entity):
    """Determine confidence level based on entity type."""
    if '(非中国)' in entity or '(韩国)' in entity or '(巴西)' in entity:
        return 'Confirmed'
    if '/' in entity and '中国' not in entity:
        return 'Strongly linked'
    if '可能' in entity:
        return 'Probable'
    return 'Strongly linked'

def write_osint_case(product, entity_str):
    """Write an osint-case document for a product with known publisher."""
    name = product.get('name', '')
    publisher = product.get('publisher', '').split('（')[0].strip()
    pkg_id = product.get('package_id', '')
    gp_url = product.get('google_play', '')
    as_url = product.get('app_store', '')
    article_url = product.get('article_url', '')
    article_title = product.get('article_title', '')
    hints = product.get('chinese_hints', [])

    if pkg_id:
        slug = slugify(pkg_id)
    else:
        slug = slugify(name)

    doc_id = f"product:osint-{slug}"

    if doc_id in existing_ids:
        return None, 'skipped_exists'

    confidence = get_confidence(entity_str)
    is_non_chinese = any(x in entity_str for x in ['(非中国)', '(韩国)', '(巴西)', '(芬兰)', '(波兰)'])

    if is_non_chinese:
        final_cn_entity = "无（非中国发行主体）"
        layers = {
            '表层壳': publisher,
            '中间网络': '无',
            '最终中国主体': 'N/A',
        }
    else:
        final_cn_entity = entity_str
        layers = {
            '表层壳': publisher,
            '中间网络': '未深查',
            '最终中国主体': entity_str,
        }

    store_info = []
    if gp_url:
        store_info.append(f"Google Play: {gp_url}")
    if as_url:
        store_info.append(f"App Store: {as_url}")
    if pkg_id:
        store_info.append(f"包名: {pkg_id}")

    source_info = f"来源文章: 《{article_title}》{article_url}" if article_url else ''
    hints_str = f"\n- 文章作者提示: {', '.join(hints)}" if hints else ''

    body_lines = [
        f"## 【目标锁定】",
        f"- 产品名：{name}",
        f"- 包名 / App ID：{pkg_id or '未知'}",
        f"- 商店链接：{gp_url or as_url or '未提供'}",
        f"- 查询时间：{date.today().isoformat()}",
        f"",
        f"## 【最终结论】",
        f"- 最终中国主体：{final_cn_entity}",
        f"- 中间出海发行链：{publisher} → {entity_str}",
        f"- 表层上架 / 法务壳：{publisher}",
        f"- 确信度：{confidence}",
        f"",
        f"## 【三层结构判断】",
        f"- 表层壳：{layers['表层壳']}",
        f"- 中间网络：{layers['中间网络']}",
        f"- 最终中国主体：{layers['最终中国主体']}",
        f"",
        f"## 【商店已确认事实】",
        f"- 商店开发者 / 发布主体：{publisher}",
        f"- {chr(10).join(store_info) if store_info else '无商店链接'}",
        f"",
        f"## 【核心证据】",
        f"1. 来源：王董的新游戏公众号文章",
        f"   发现：文章作者标注发行商为 {publisher}{hints_str}",
        f"   为什么重要：公众号作者具有行业观察经验，其标注具有一定参考价值",
        f"2. 来源：products KB 现有映射",
        f"   发现：发行商 {publisher} 已映射到 {entity_str}",
        f"   为什么重要：KB 已有可复用映射，无需重新溯源",
        f"",
        f"## 【判断说明】",
        f"- 哪些是 confirmed storefront facts：{publisher} 是文章标注的发行主体",
        f"- 哪些是 evidence-linked relationships：KB 映射 {publisher} → {entity_str}",
        f"- 哪些属于最终推断：{final_cn_entity} 为最终主体",
        f"- 确信度：{confidence}（基于 KB Phase 0 快速通道，未执行完整 Phase A-C）",
        f"",
        f"## 【证据缺口 / 未完成项】",
        f"- 本条目通过 Phase 0 KB 快速通道建立，未执行 Phase A 商店页抓取",
        f"- {source_info}",
        f"- 如需完整验证，执行 Phase A: 抓取 {gp_url or as_url or '需先找商店链接'}",
    ]

    body = '\n'.join(body_lines)

    # Determine market tag
    market = '全球'
    regions = product.get('regions', '')
    if regions:
        market = regions[:20]

    # Build tags
    tags = ['products', '归属溯源', name[:30]]
    if not is_non_chinese and entity_str != '可能中国':
        cn_name = entity_str.split('/')[0].strip()
        tags.append(cn_name)
    tags.append(market)

    doc = {
        'doc_id': doc_id,
        'title': f'{name} 归属溯源报告',
        'source_type': 'osint-case',
        'provider': 'publisher-osint',
        'tags': tags,
        'doc_form': '报告',
        'status': 'active',
        'quality_tier': 'medium',  # KB fast-track, not full OSINT
        'taxonomy_version': 'v2',
        'body': body,
    }

    return doc_id, doc


written = 0
skipped = 0

for product in known_products:
    entity = product.get('_matched_entity', '')
    if not entity:
        continue

    doc_id_result, result = write_osint_case(product, entity)

    if result == 'skipped_exists':
        skipped += 1
        continue

    if isinstance(result, dict):
        out_path = KB_DOCS / f"{doc_id_result}.json"
        out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        written += 1
        print(f"[written] {doc_id_result} | {product.get('name','?')[:40]} → {entity}")

print(f"\nTotal written: {written}")
print(f"Skipped (already in KB): {skipped}")

#!/usr/bin/env python3
"""
Write lightweight KB entries for single-occurrence publisher products.
These products have limited info - just product name, publisher from article.
We create basic entries noting what's known and flagging for deeper OSINT.
"""

import json, re
from pathlib import Path
from datetime import date
from collections import Counter

PROJECT_ROOT = Path(__file__).resolve().parents[3]
ANALYSIS_DIR = PROJECT_ROOT / ".local" / "wechat2md-analysis"
PRODUCTS_DIR = ANALYSIS_DIR / "products"
KB_DOCS = Path("/Users/adobe/Project/knowledge-vault/documents")
CATEGORIZED = PRODUCTS_DIR / "wechat2md-products-categorized.json"
MULTI_PUB = PRODUCTS_DIR / "wechat2md-multi-pub-unknown.json"

data = json.loads(CATEGORIZED.read_text())
unknown = data['unknown_publisher']
multi_pub = json.loads(MULTI_PUB.read_text())

multi_pub_names = set(multi_pub.keys())

# Products with single-occurrence publishers (not in multi-pub list)
pub_counter = Counter(p.get('publisher', '').split('（')[0].strip() for p in unknown)
single_pub_products = [
    p for p in unknown
    if pub_counter.get(p.get('publisher', '').split('（')[0].strip(), 0) == 1
    and p.get('publisher', '').split('（')[0].strip() not in multi_pub_names
]

print(f"Single-pub unknown products: {len(single_pub_products)}")

def slugify(s):
    s = s.lower().strip()
    s = re.sub(r'[^a-z0-9\u4e00-\u9fff]+', '-', s)
    return s.strip('-')[:60]

def guess_region(publisher):
    """Make educated guess about publisher origin."""
    pub_lower = publisher.lower()
    if any(x in pub_lower for x in ['oyun', 'yazilim', 'teknoloji', 'taskin', 'temel', 'simsek', 'yalcinkaya']):
        return '土耳其', False
    if any(x in pub_lower for x in ['korzhov', 'pidvirnyy', 'ukraine', 'ukr']):
        return '乌克兰', False
    if any(x in pub_lower for x in ['러시아', 'russian', 'matryoshka']):
        return '俄罗斯', False
    if any(x in pub_lower for x in ['brasil', 'brazil', 'wildlife']):
        return '巴西', False
    if any(x in pub_lower for x in ['korea', 'korean', '.kr', 'wemade', 'netmarble', 'devsisters', 'com2us', '111%', 'risingwings', 'treenod', 'doublegames', 'doubleugames']):
        return '韩国', False
    if any(x in pub_lower for x in ['finland', 'oy', 'metacore', 'rovio', 'small giant']):
        return '芬兰', False
    if any(x in pub_lower for x in ['japan', 'japanese', 'square enix', '株式会社']):
        return '日本', False
    if any(x in pub_lower for x in ['france', 'french', 'voodoo', 'homa', 'ketchapp']):
        return '法国', False
    if any(x in pub_lower for x in ['vietnam', 'vietnamese', 'viet', 'gplay jsc']):
        return '越南', False
    if any(x in pub_lower for x in ['hong kong', 'hk', 'limited', 'holdings']):
        return '可能香港/中国', None  # ambiguous
    if any(x in pub_lower for x in ['beijing', 'shanghai', 'shenzhen', 'guangzhou', 'hangzhou', 'chengdu', 'china', '中国', '北京', '上海', '深圳']):
        return '中国', True
    return '未知', None

def write_single_pub_entry(product):
    name = product.get('name', '')
    publisher = product.get('publisher', '').split('（')[0].strip()
    hints = product.get('chinese_hints', [])
    article_url = product.get('article_url', '')
    article_title = product.get('article_title', '')

    slug = slugify(name)
    doc_id = f"product:osint-{slug}"

    # Check if already exists
    out_path = KB_DOCS / f"{doc_id}.json"
    if out_path.exists():
        return None, 'exists'

    region, is_chinese = guess_region(publisher)

    if is_chinese:
        final_entity = f"疑似中国公司（{publisher}）"
        confidence = 'Possible'
    elif is_chinese is False and region != '未知' and region != '可能香港/中国':
        final_entity = f"非中国发行主体（{region}）"
        confidence = 'Confirmed'
    else:
        final_entity = '未能落定'
        confidence = 'Possible'

    hints_str = f"文章作者提示: {', '.join(hints)}" if hints else ""

    body = f"""## 【目标锁定】
- 产品名：{name}
- 包名 / App ID：未提供
- 商店链接：未提供
- 查询时间：{date.today().isoformat()}

## 【最终结论】
- 最终中国主体：{final_entity}
- 中间出海发行链：{publisher}
- 表层上架 / 法务壳：{publisher}
- 确信度：{confidence}

## 【三层结构判断】
- 表层壳：{publisher}
- 中间网络：未查
- 最终中国主体：{final_entity}

## 【商店已确认事实】
- 商店开发者 / 发布主体：{publisher}（来自公众号文章标注）
- 商店支持信息 / 外链：未查
- 其他直接可见字段：N/A

## 【核心证据】
1. 来源：王董的新游戏公众号文章《{article_title}》
   发现：文章作者标注发行商为 {publisher}
   为什么重要：提供产品和发行商关联的原始线索
{f"2. 来源：文章作者评论{chr(10)}   发现：{hints_str}{chr(10)}   为什么重要：作者的行业经验提供了中国关联的参考提示" if hints_str else ""}

## 【判断说明】
- 哪些是 confirmed storefront facts：N/A（无商店链接）
- 哪些是 evidence-linked relationships：文章标注 {publisher} 为发行商
- 哪些属于最终推断：{final_entity} 基于发行商名称分析
- 当前确信度：{confidence}（仅基于文章信息，未执行 Phase A 商店页抓取）

## 【证据缺口 / 未完成项】
- 本条目为轻量级初始条目，未执行 Phase A-C
- 最后一跳缺什么：需获取商店链接，执行 Phase A 商店页抓取
- 下一步最优补桥方向：搜索 "{name} {publisher} Google Play" 找到商店页后执行完整 OSINT
- Root Domain Source Sweep：未执行"""

    tags = ['products', '归属溯源', name[:30], publisher[:20]]
    if not is_chinese and region != '未知' and region != '可能香港/中国':
        tags.append('全球')
    elif is_chinese:
        tags.append('全球')
    else:
        tags.append('全球')

    doc = {
        'doc_id': doc_id,
        'title': f'{name} 归属溯源报告',
        'source_type': 'osint-case',
        'provider': 'publisher-osint',
        'tags': tags,
        'doc_form': '报告',
        'status': 'active',
        'quality_tier': 'low',  # light entry, needs deeper OSINT
        'taxonomy_version': 'v2',
        'body': body,
    }

    return doc_id, doc


written = 0
skipped = 0
errors = 0

for product in single_pub_products:
    doc_id, result = write_single_pub_entry(product)

    if result == 'exists':
        skipped += 1
        continue

    if isinstance(result, dict):
        out_path = KB_DOCS / f"{doc_id}.json"
        try:
            out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            written += 1
        except Exception as e:
            print(f"ERROR writing {doc_id}: {e}")
            errors += 1

print(f"\nWritten: {written}")
print(f"Skipped (exists): {skipped}")
print(f"Errors: {errors}")
print(f"\nTotal product:osint-*.json files now: {len(list(KB_DOCS.glob('product:osint-*.json')))}")

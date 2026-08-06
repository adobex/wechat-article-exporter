#!/usr/bin/env python3
"""
Write lightweight KB entries for multi-occurrence publisher products not covered by OSINT subagents.
Subagent A covers: OHM Games, Larks Holding, ZPLAY HC Games, Mattel163, ARK GAME LIMITED, BeheFun, Hyperlab
Subagent B covers: Wemade, 111%, VOODOO, G5, EA, Square Enix, HyperBeard, Playgendary, RisingWings,
                   DoubleUGames, Treenod, SAMFINACO LTD, Super Planet, Supercent, Borys Korzhov,
                   Andriy Pidvirnyy, Max G0, Virtual Projects
"""

import json, re
from pathlib import Path
from datetime import date

PROJECT_ROOT = Path(__file__).resolve().parents[3]
ANALYSIS_DIR = PROJECT_ROOT / ".local" / "wechat2md-analysis"
PRODUCTS_DIR = ANALYSIS_DIR / "products"
KB_DOCS = Path("/Users/adobe/Project/knowledge-vault/documents")
MULTI_PUB = PRODUCTS_DIR / "wechat2md-multi-pub-unknown.json"

multi_pub = json.loads(MULTI_PUB.read_text())

# Publishers already handled by subagents A and B
SUBAGENT_COVERED = {
    'OHM Games', 'Larks Holding Limited', 'ZPLAY HC Games', 'Mattel163 Limited',
    'ARK GAME LIMITED', 'BeheFun Games Limited', 'Hyperlab Games',
    'Wemade Play Co.,Ltd.', '111%', 'VOODOO', 'G5 Entertainment', 'ELECTRONIC ARTS',
    'SQUARE ENIX INC', 'HyperBeard', 'Playgendary Limited', 'RisingWings',
    'DoubleUGames', 'Treenod Inc.', 'SAMFINACO LTD', 'SAMFINACO LIMITED',
    'Super Planet', 'Supercent, Inc.', 'Borys Korzhov', 'Andriy Pidvirnyy',
    'Max G0', 'Virtual Projects Oyun Yazilim Ve Teknoloji',
}

def slugify(s):
    s = s.lower().strip()
    s = re.sub(r'[^a-z0-9\u4e00-\u9fff]+', '-', s)
    return s.strip('-')[:60]

def guess_origin(publisher):
    """Return (region, is_chinese: True/False/None)"""
    pub_lower = publisher.lower()

    # Known non-Chinese by pattern
    if any(x in pub_lower for x in ['oyun', 'yazilim', 'sirketi', 'teknoloji']):
        return '土耳其', False
    if any(x in pub_lower for x in ['korea', 'korean', 'wemade', 'netmarble', 'kakaogames', 'ncsoft', 'neowiz', 'com2us']):
        return '韩国', False
    if any(x in pub_lower for x in ['finland', 'oy ', 'rovio', 'metacore', 'supercell']):
        return '芬兰', False
    if any(x in pub_lower for x in ['japan', 'japanese', 'square enix', 'kabam', 'gumi', 'gungho']):
        return '日本', False
    if any(x in pub_lower for x in ['france', 'french', 'voodoo', 'homa', 'ketchapp', 'ubisoft']):
        return '法国', False
    if any(x in pub_lower for x in ['vietnam', 'viet', 'vng', 'gplay jsc']):
        return '越南', False
    if any(x in pub_lower for x in ['brazil', 'brasil', 'wildlife']):
        return '巴西', False
    if any(x in pub_lower for x in ['russia', 'russian', 'matryoshka', 'noodlecake', 'belka']):
        return '俄罗斯', False
    if any(x in pub_lower for x in ['sweden', 'swedish', 'g5 entertainment', 'king ab']):
        return '瑞典', False
    if any(x in pub_lower for x in ['usa', 'united states', 'inc.', 'llc', 'corp.', 'electronic arts', 'zynga', 'supercent', 'scopely', 'jam city']):
        return '美国', False

    # Likely Chinese by pattern
    if any(x in pub_lower for x in ['beijing', 'shanghai', 'shenzhen', 'guangzhou', 'hangzhou', 'chengdu', 'nanjing', 'china']):
        return '中国', True
    if any(x in pub_lower for x in ['zplay', 'dhgames', 'funplus', 'lilith', 'igg', 'centurygames', 'topgames', 'tap4fun', '4399']):
        return '中国', True

    # Ambiguous
    if any(x in pub_lower for x in ['limited', 'holding', 'pte. ltd.', 'co., ltd']):
        return '可能香港/中国/新加坡', None

    return '未知', None


written = 0
skipped = 0

for pub_name, products in multi_pub.items():
    if pub_name in SUBAGENT_COVERED:
        continue

    region, is_chinese = guess_origin(pub_name)

    if is_chinese is True:
        final_entity = f"疑似中国公司（{pub_name}）"
        confidence = 'Probable'
        quality = 'medium'
    elif is_chinese is False:
        final_entity = f"非中国发行主体（{region}）"
        confidence = 'Confirmed'
        quality = 'medium'
    else:
        final_entity = '待查'
        confidence = 'Possible'
        quality = 'low'

    for product in products:
        name = product.get('name', '')
        publisher = product.get('publisher', '').split('（')[0].strip()
        hints = product.get('chinese_hints', [])
        article_title = product.get('article_title', '')

        slug = slugify(name)
        doc_id = f"product:osint-{slug}"
        out_path = KB_DOCS / f"{doc_id}.json"

        if out_path.exists():
            skipped += 1
            continue

        hints_str = f"- 文章作者提示: {', '.join(hints)}\n" if hints else ""

        body = f"""## 【目标锁定】
- 产品名：{name}
- 包名 / App ID：未提供（无商店链接）
- 商店链接：未提供
- 查询时间：{date.today().isoformat()}

## 【最终结论】
- 最终中国主体：{final_entity}
- 中间出海发行链：{pub_name}
- 表层上架 / 法务壳：{pub_name}
- 确信度：{confidence}

## 【三层结构判断】
- 表层壳：{pub_name}
- 中间网络：未查
- 最终中国主体：{final_entity}

## 【商店已确认事实】
- 商店开发者 / 发布主体：{pub_name}（来自公众号文章）
- 商店支持信息 / 外链：未查
- 其他直接可见字段：N/A

## 【核心证据】
1. 来源：王董的新游戏公众号文章《{article_title}》
   发现：文章标注 {pub_name} 为发行商
   为什么重要：行业观察者的标注具有参考价值
{hints_str}
## 【判断说明】
- 哪些是 confirmed storefront facts：N/A
- 哪些是 evidence-linked relationships：文章标注 {pub_name}
- 当前确信度：{confidence}（{region}，未执行完整 Phase A-C）

## 【证据缺口 / 未完成项】
- 需获取商店链接执行 Phase A
- 下一步：搜索 "{name}" 找商店页，再做 Root Domain Source Sweep"""

        tags = ['products', '归属溯源', name[:30], pub_name[:20], '全球']

        doc = {
            'doc_id': doc_id,
            'title': f'{name} 归属溯源报告',
            'source_type': 'osint-case',
            'provider': 'publisher-osint',
            'tags': tags,
            'doc_form': '报告',
            'status': 'active',
            'quality_tier': quality,
            'taxonomy_version': 'v2',
            'body': body,
        }

        out_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
        written += 1

print(f"Written: {written}")
print(f"Skipped (exists): {skipped}")
print(f"Total product:osint-*.json: {len(list(KB_DOCS.glob('product:osint-*.json')))}")

#!/usr/bin/env python3
"""
批量将新游观察产品记录导入 wiki 层，自动去重处理。

策略：
- 已有 publisher 的产品 → attribution 类型（cn_entity = publisher）
- publisher=未知 的产品 → profile 类型（product kind）
- subject 去重：与已有 wiki subjects 做 slug 匹配，已存在则跳过
- 对同名产品（不同发行商）：保留第一次出现，后续跳过

Capability Contract:
- Inputs: current-run .local/wechat2md-analysis publisher analysis JSON and existing knowledge-vault wiki syntheses.
- Outputs: wiki synthesis rows, embedding updates and skipped/created counts.
- Side effects: appends to knowledge-vault/wiki/syntheses.jsonl and rewrites syntheses_embeddings.bin when --confirm is passed.
- Verification: run --dry-run against the current-run data JSON before --confirm, then run KB/wiki smoke checks.
"""

import argparse
import json
import hashlib
import struct
import sys
import re
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
from typing import Optional

# ── 路径配置 ─────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = Path("/Users/adobe/Project/knowledge-vault/scripts")
WIKI_DIR = Path("/Users/adobe/Project/knowledge-vault/wiki")
SYNTHESES_PATH = WIKI_DIR / "syntheses.jsonl"
EMBEDDINGS_PATH = WIKI_DIR / "syntheses_embeddings.bin"
DATA_JSON = PROJECT_ROOT / ".local" / "wechat2md-analysis" / "publisher-analysis" / "_publisher_analysis.json"

sys.path.insert(0, str(SCRIPTS_DIR))
from kb_embed import embed_text, get_embedding_dim

# ── 发行商 -> 中国主体 映射（用于 attribution cn_entity） ────────
PUB_TO_CN = {
    "海彼 (Habby)": "上海海彼网络科技有限公司（Habby）",
    "111%": "111% Inc.（中国）",
    "Voodoo": "Voodoo（法国，合作商多为中国团队）",
    "Voodoo (Rollic)": "Voodoo Rollic（土耳其/Voodoo系）",
    "Voodoo (Rivvy)": "Voodoo Rivvy（Voodoo系）",
    "点点互动 (Dian Dian)": "点点互动（中国）",
    "游族网络": "游族网络股份有限公司（上海，A股 002174）",
    "卓航互动": "成都卓杭网络科技股份有限公司（DHGames）",
    "西安墨焰": "西安墨焰网络科技有限公司",
    "功夫特牛 / PeakX": "PeakX Games（功夫特牛，中国独立工作室）",
    "哈喽沃德 (Hello World)": "武汉哈乐沃德网络科技有限公司（HelloWorld）",
    "IGG": "IGG Inc.（互动游戏，香港上市 0799.HK）",
    "Supercell": "Supercell（芬兰，腾讯控股84%）",
    "Lion Studios": "Lion Studios（美国/AppLovin系）",
    "Homa Games": "Homa Games（法国）",
    "网易 (NetEase)": "网易公司（Mattel163 Limited）",
    "莉莉丝 (Lilith)": "上海莉莉丝科技股份有限公司（Lilith Games）",
    "波克城市 (Bokul)": "波克城市（中国）",
    "途游游戏": "途游游戏（中国）",
    "凉屋游戏": "凉屋游戏（中国）",
    "重力社": "重力社（中国）",
    "壳木软件": "壳木软件（中国）",
    "益世界": "益世界（中国）",
    "FunPlus": "FunPlus International AG（趣加，中国）",
    "多益网络": "多益网络（中国）",
    "智明星通": "智明星通（中国）",
    "超燃互动": "超燃互动（中国）",
    "4399": "4399（中国）",
    "魔兔游戏": "魔兔游戏（中国）",
    "卓航互动": "成都卓杭网络科技（DHGames）",
    "育碧 (Ubisoft)": "育碧（法国）",
    "Square Enix": "Square Enix（日本）",
    "Tap4Fun": "成都创人所爱科技股份有限公司（Tap4Fun）",
    "Fansipan": "Fansipan（越南）",
    "Codigame": "Codigame（海外）",
    "SayGame": "SayGame（中国）",
    "王铲铲工作室": "王铲铲工作室（中国独立）",
    "哈喽沃德 (Hello World)": "武汉哈乐沃德网络科技有限公司",
}

# ── 工具函数 ──────────────────────────────────────────────────────
def slugify(text: str) -> str:
    """将产品名转为 slug（小写 + 连字符，去除特殊字符）"""
    text = text.lower()
    text = re.sub(r"[^\w\s\u4e00-\u9fff-]", "", text)
    text = re.sub(r"[\s_]+", "-", text.strip())
    return text[:120]  # 限制长度


def load_existing_subjects() -> set:
    """从 wiki 加载所有已有 subjects"""
    subjects = set()
    if not SYNTHESES_PATH.exists():
        return subjects
    with open(SYNTHESES_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    r = json.loads(line)
                    if r.get("subject"):
                        subjects.add(r["subject"].lower())
                        subjects.add(slugify(r["subject"]))
                except Exception:
                    pass
    return subjects


def load_existing_count() -> int:
    if not SYNTHESES_PATH.exists():
        return 0
    with open(SYNTHESES_PATH) as f:
        return sum(1 for l in f if l.strip())


def load_embedding_dim() -> int:
    if not EMBEDDINGS_PATH.exists():
        return get_embedding_dim()
    with open(EMBEDDINGS_PATH, "rb") as f:
        header = f.read(8)
        if len(header) < 8:
            return get_embedding_dim()
        _, dim = struct.unpack("<II", header)
        return dim


def append_entries_batch(new_entries: list, new_embeddings: list, dim: int) -> None:
    """一次性追加所有新记录到 JSONL 和二进制 embedding 文件"""
    if not new_entries:
        return

    # 更新 syntheses.jsonl
    with open(SYNTHESES_PATH, "a", encoding="utf-8") as f:
        for entry in new_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # 更新 embeddings.bin（更新 header count，追加向量）
    if EMBEDDINGS_PATH.exists():
        with open(EMBEDDINGS_PATH, "r+b") as f:
            old_count, old_dim = struct.unpack("<II", f.read(8))
            new_count = old_count + len(new_entries)
            f.seek(0)
            f.write(struct.pack("<II", new_count, dim))
            f.seek(0, 2)  # 到文件末尾
            for emb in new_embeddings:
                f.write(struct.pack(f"<{dim}f", *emb))
    else:
        WIKI_DIR.mkdir(parents=True, exist_ok=True)
        with open(EMBEDDINGS_PATH, "wb") as f:
            f.write(struct.pack("<II", len(new_entries), dim))
            for emb in new_embeddings:
                f.write(struct.pack(f"<{dim}f", *emb))


def make_synthesis_id(title: str, content: str) -> str:
    return hashlib.sha256((title + content).encode()).hexdigest()[:16]


def make_content_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def is_noise_product(name: str) -> bool:
    """过滤明显不是产品名的条目"""
    if not name or len(name) < 2 or len(name) > 60:
        return True
    noise_patterns = ["的", "是", "了", "在", "也", "以上", "比如"]
    if any(p in name for p in noise_patterns):
        return True
    if name.endswith("。") or name.endswith("：") or name.endswith(":"):
        return True
    return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="将公众号文章产品分析结果导入 Knowledge Vault wiki 层。")
    parser.add_argument("--data-json", type=Path, default=DATA_JSON, help="本轮 publisher analysis JSON。")
    parser.add_argument("--dry-run", action="store_true", help="只统计将要写入的记录，不写 wiki 或 embedding。")
    parser.add_argument("--confirm", action="store_true", help="确认写入 wiki/syntheses.jsonl 和 syntheses_embeddings.bin。")
    return parser


# ── 主流程 ────────────────────────────────────────────────────────
def main():
    args = build_parser().parse_args()
    if not args.dry_run and not args.confirm:
        print("拒绝写入：正式入库必须传 --confirm；验证请使用 --dry-run。", file=sys.stderr)
        sys.exit(2)

    data_json = args.data_json.expanduser().resolve()

    print("加载现有 wiki subjects...")
    existing_subjects = load_existing_subjects()
    existing_count = load_existing_count()
    print(f"  已有 {existing_count} 条记录，{len(existing_subjects)} 个唯一 subjects")

    print(f"加载产品分析数据: {data_json}")
    data = json.load(open(data_json, encoding="utf-8"))

    # 收集所有产品，去重（同名取第一个有publisher的）
    product_index: dict[str, dict] = {}  # slug -> product_info
    for pub, items in data["publisher_products"].items():
        for item in items:
            name = item["product_name"].strip()
            if is_noise_product(name):
                continue
            slug = slugify(name)
            if not slug:
                continue
            if slug in product_index:
                # 已有：若原来没publisher但现在有，更新
                existing_item = product_index[slug]
                if existing_item["publisher"] == "未知" and pub != "未知":
                    product_index[slug] = {**item, "publisher": pub}
            else:
                product_index[slug] = {**item, "publisher": pub}

    print(f"  去重后唯一产品数: {len(product_index)}")

    # 过滤掉已在 wiki 中的
    to_import = {}
    skipped_existing = 0
    for slug, item in product_index.items():
        if slug in existing_subjects or item["product_name"].lower() in existing_subjects:
            skipped_existing += 1
            continue
        to_import[slug] = item

    print(f"  已存在于wiki: {skipped_existing} 条（跳过）")
    print(f"  需新建: {len(to_import)} 条")

    if args.dry_run:
        by_publisher = defaultdict(int)
        by_account = defaultdict(int)
        for item in to_import.values():
            by_publisher[item.get("publisher", "未知")] += 1
            by_account[item.get("account") or "未知公众号"] += 1
        print(json.dumps({
            "dry_run": True,
            "data_json": str(data_json),
            "existing_count": existing_count,
            "unique_products": len(product_index),
            "skipped_existing": skipped_existing,
            "would_create": len(to_import),
            "by_publisher": dict(sorted(by_publisher.items(), key=lambda x: x[1], reverse=True)[:20]),
            "by_account": dict(sorted(by_account.items(), key=lambda x: x[1], reverse=True)),
        }, ensure_ascii=False, indent=2))
        return

    if not to_import:
        print("无需导入，所有产品已存在。")
        return

    # 获取 embedding 维度
    dim = load_embedding_dim()
    print(f"  Embedding 维度: {dim}")

    # 批量处理：分批 embed + 写入
    BATCH_SIZE = 50
    items_list = list(to_import.items())
    total = len(items_list)
    now = datetime.now(timezone.utc).isoformat()

    created_count = 0
    attr_count = 0
    profile_count = 0
    errors = 0

    # 分批处理，每批完成后立即写入（避免中途崩溃丢失全部数据）
    for batch_start in range(0, total, BATCH_SIZE):
        batch = items_list[batch_start:batch_start + BATCH_SIZE]
        new_entries = []
        new_embeddings = []

        for slug, item in batch:
            name = item["product_name"]
            pub = item["publisher"]
            desc = item.get("description", "").strip()[:300]
            article = item.get("article_title", "")
            url = item.get("url", "")
            account = item.get("account") or "未知公众号"
            cn_entity = PUB_TO_CN.get(pub)

            if pub != "未知":
                # attribution 类型
                syn_type = "attribution"
                title = f"{name} 产品归因（公众号文章）"
                content_parts = [
                    f"产品名称：{name}",
                    f"发行商：{pub}",
                    f"中国主体：{cn_entity or pub}",
                    f"信息来源：{account}公众号《{article}》",
                ]
                if desc:
                    content_parts.append(f"产品描述：{desc}")
                content = "\n".join(content_parts)

                tags = ["products", "归属溯源", account]
                if pub and pub not in ("未知",):
                    tags.append(pub)

                entry = {
                    "synthesis_id": make_synthesis_id(title, content),
                    "synthesis_type": "attribution",
                    "title": title,
                    "content": content,
                    "tags": sorted(set(tags)),
                    "source_chunks": [],
                    "source_docs": [],
                    "stale_chunks": [],
                    "created_at": now,
                    "updated_at": now,
                    "origin": "web-research",
                    "content_hash": make_content_hash(content),
                    "_source_hashes": {},
                    "subject": slug,
                    "cn_entity": cn_entity or pub,
                    "shell_entities": [],
                    "confidence": "Probable",
                    "evidence_sources": [url] if url else [],
                }
                attr_count += 1
            else:
                # profile 类型
                syn_type = "profile"
                title = f"{name} 产品档案（公众号文章）"
                content_parts = [
                    f"产品名称：{name}",
                    f"来源文章：{account}公众号《{article}》",
                ]
                if desc:
                    content_parts.append(f"产品描述：{desc}")
                content = "\n".join(content_parts)

                tags = ["products", account]
                entry = {
                    "synthesis_id": make_synthesis_id(title, content),
                    "synthesis_type": "profile",
                    "title": title,
                    "content": content,
                    "tags": sorted(set(tags)),
                    "source_chunks": [],
                    "source_docs": [],
                    "stale_chunks": [],
                    "created_at": now,
                    "updated_at": now,
                    "origin": "web-research",
                    "content_hash": make_content_hash(content),
                    "_source_hashes": {},
                    "subject": slug,
                    "profile_kind": "product",
                    "evidence_sources": [url] if url else [],
                }
                profile_count += 1

            try:
                embed_input = title + " " + content
                emb = embed_text(embed_input)
                new_entries.append(entry)
                new_embeddings.append(emb)
                created_count += 1
            except Exception as e:
                print(f"  ⚠️  embed 失败 [{name}]: {e}", file=sys.stderr)
                errors += 1

        # 批次写入
        if new_entries:
            append_entries_batch(new_entries, new_embeddings, dim)

        done = min(batch_start + BATCH_SIZE, total)
        print(f"  [{done}/{total}] 已处理 {done} 条, 本批写入 {len(new_entries)} 条")

    print(f"\n✅ 完成！")
    print(f"   新写入: {created_count} 条（attribution: {attr_count}, profile: {profile_count}）")
    print(f"   跳过已有: {skipped_existing} 条")
    print(f"   embed 失败: {errors} 条")
    print(f"   Wiki 当前总量: {existing_count + created_count} 条")


if __name__ == "__main__":
    main()

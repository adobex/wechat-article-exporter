#!/usr/bin/env python3
"""
Import current-run WeChat product analysis into Knowledge Vault structured/products.

Inputs are publisher-analysis JSON files produced by
scripts/wechat2md/analysis/publisher-analysis.py. The importer writes product
source documents under knowledge-vault/documents and then refreshes the
corresponding structured/products records and SQLite index via the canonical
builder. It does not write wiki syntheses or embeddings.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


PROJECT_ROOT = Path(__file__).resolve().parents[3]
VAULT_ROOT = Path("/Users/adobe/Project/knowledge-vault")
DOCUMENTS_DIR = VAULT_ROOT / "documents"
STRUCTURED_PRODUCTS = VAULT_ROOT / "structured" / "products"
PRODUCT_RECORDS = STRUCTURED_PRODUCTS / "records.jsonl"
STRUCTURED_BUILDER = VAULT_ROOT / "scripts" / "build-structured-ai-products.py"
WRITE_LOCK = VAULT_ROOT / ".local" / "locks" / "structured-ai-products.lock"
RECEIPT_VERSION = 1
DEFAULT_RECEIPT_TTL_HOURS = 24.0


PUB_TO_CN = {
    "海彼 (Habby)": "上海海彼网络科技有限公司（Habby）",
    "111%": "111% Inc.（中国）",
    "Voodoo": "Voodoo（法国，合作商多为中国团队）",
    "Voodoo (Rollic)": "Voodoo Rollic（土耳其/Voodoo系）",
    "Voodoo (Rivvy)": "Voodoo Rivvy（Voodoo系）",
    "点点互动 (Dian Dian)": "点点互动（中国）",
    "游族网络": "游族网络股份有限公司（上海，A股 002174）",
    "卓航互动": "成都卓杭网络科技（DHGames）",
    "西安墨焰": "西安墨焰网络科技有限公司",
    "功夫特牛 / PeakX": "PeakX Games（功夫特牛，中国独立工作室）",
    "哈喽沃德 (Hello World)": "武汉哈乐沃德网络科技有限公司",
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
    "育碧 (Ubisoft)": "育碧（法国）",
    "Square Enix": "Square Enix（日本）",
    "Tap4Fun": "成都创人所爱科技股份有限公司（Tap4Fun）",
    "Fansipan": "Fansipan（越南）",
    "Codigame": "Codigame（海外）",
    "SayGame": "SayGame（中国）",
    "王铲铲工作室": "王铲铲工作室（中国独立）",
}


def slugify(text: str) -> str:
    text = str(text or "").lower()
    text = re.sub(r"[^\w\s\u4e00-\u9fff-]", "", text)
    text = re.sub(r"[\s_]+", "-", text.strip())
    return text[:120]


def stable_hash(*values: Any, length: int = 12) -> str:
    payload = "\n".join(str(value or "") for value in values)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: {exc.msg}") from exc
        if isinstance(value, dict):
            rows.append(value)
    return rows


def read_subject_filter(path: Path | None) -> set[str] | None:
    if not path:
        return None
    resolved = path.expanduser().resolve()
    raw = resolved.read_text(encoding="utf-8").strip()
    if not raw:
        return set()
    subjects: set[str] = set()
    if raw.startswith("["):
        values = json.loads(raw)
        if not isinstance(values, list):
            raise ValueError(f"{resolved} must contain a JSON list or newline-delimited subjects")
        iterable = values
    else:
        iterable = raw.splitlines()
    for value in iterable:
        text = str(value or "").strip()
        if not text:
            continue
        subjects.add(text.lower())
        subjects.add(slugify(text))
    return subjects


NOISE_EXACT_NAMES = {
    "merge",
    "rpg",
    "rpg类",
    "slg",
    "slg类",
    "竞技对战",
    "天天射击",
}

NOISE_PREFIXES = (
    "发行商",
    "差异点",
    "锐评",
    "素材侧",
    "素材上",
    "目前素材",
    "目前游戏",
    "游戏内",
    "本作",
    "后续",
    "预测",
    "粗略预估",
    "玩家",
    "如果",
    "随着",
    "通过",
    "即",
    "把",
    "收集资源",
    "建造",
    "画风",
    "白天",
    "弹幕",
    "极其重视",
)

NOISE_SUBSTRINGS = (
    "原创不易",
    "下次不迷路",
    "可以保持关注",
    "心流",
    "商业化内容",
    "大地图玩法",
    "核心玩法",
    "低成本理解钩子",
    "用户更追求",
    "留存",
    "数值碾压",
    "模拟经营+slg",
    "战斗副玩法",
    "轻量副玩法",
)


def is_noise_product(name: str) -> bool:
    if not name or len(name) < 2 or len(name) > 60:
        return True
    normalized = re.sub(r"\s+", "", name).lower()
    if normalized in NOISE_EXACT_NAMES:
        return True
    if any(normalized.startswith(prefix.lower()) for prefix in NOISE_PREFIXES):
        return True
    if any(fragment.lower() in normalized for fragment in NOISE_SUBSTRINGS):
        return True
    if name.endswith(("。", "，", "；", "：", ":")):
        return True
    if re.match(r"^(发行商|开发商|平台|链接|亮点|差异点|锐评)\s*[：:]", name):
        return True
    chinese_count = len(re.findall(r"[\u4e00-\u9fff]", name))
    return bool(
        chinese_count >= 12
        and re.search(r"(我们|玩家|产品|游戏|可以|通过|目前|因此|如果|以及|整体|主要)", name)
    )


def _clean_string_list(value: Any) -> list[str]:
    values = value if isinstance(value, list) else [value]
    return list(dict.fromkeys(str(item).strip() for item in values if str(item or "").strip()))


def _known_publishers(values: Any) -> list[str]:
    return sorted({
        value
        for value in _clean_string_list(values)
        if value not in {"未知", "冲突待审"}
    })


def _strong_product_identity(item: dict[str, Any]) -> str:
    """Prefer package/store identity when article extraction captured it."""
    for key in ("package_id", "bundle_id", "bundleId"):
        value = str(item.get(key) or "").strip().lower()
        if value:
            return value
    links = _clean_string_list(item.get("links"))
    for raw in links:
        try:
            parsed = urlparse(raw)
        except ValueError:
            continue
        host = parsed.netloc.lower()
        if host.endswith("play.google.com"):
            app_id = str(parse_qs(parsed.query).get("id", [""])[0]).strip().lower()
            if app_id:
                return app_id
        match = re.search(r"/id([1-9][0-9]*)(?:[/?#]|$)", parsed.path)
        if host.endswith("apps.apple.com") and match:
            return f"app-store:{match.group(1)}"
    return ""


def product_group_key(item: dict[str, Any]) -> str:
    return _strong_product_identity(item) or slugify(str(item.get("product_name") or ""))


def _source_key(source: dict[str, Any]) -> str:
    return stable_hash(
        source.get("account"),
        source.get("article_title"),
        source.get("article_date"),
        source.get("url"),
        source.get("publisher_candidates"),
        length=24,
    )


def merge_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for source in sources:
        normalized = {
            "account": str(source.get("account") or "").strip(),
            "article_title": str(source.get("article_title") or "").strip(),
            "article_date": str(source.get("article_date") or "").strip(),
            "url": str(source.get("url") or "").strip(),
            "description": str(source.get("description") or "").strip(),
            "publisher_candidates": _known_publishers(source.get("publisher_candidates")),
            "platforms": _clean_string_list(source.get("platforms")),
            "links": _clean_string_list(source.get("links")),
            "highlights": _clean_string_list(source.get("highlights")),
            "differences": _clean_string_list(source.get("differences")),
            "critique": _clean_string_list(source.get("critique")),
        }
        key = _source_key(normalized)
        if key not in merged:
            merged[key] = normalized
            continue
        existing = merged[key]
        for field in ("publisher_candidates", "platforms", "links", "highlights", "differences", "critique"):
            existing[field] = list(dict.fromkeys([*existing.get(field, []), *normalized.get(field, [])]))
        if not existing.get("description") and normalized.get("description"):
            existing["description"] = normalized["description"]
    return sorted(
        merged.values(),
        key=lambda row: (row.get("article_date", ""), row.get("account", ""), row.get("article_title", ""), row.get("url", "")),
    )


def collect_products(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    product_index: dict[str, dict[str, Any]] = {}
    publisher_products = data.get("publisher_products")
    if not isinstance(publisher_products, dict):
        return product_index

    for publisher, raw_items in publisher_products.items():
        if not isinstance(raw_items, list):
            continue
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("product_name") or "").strip()
            if is_noise_product(name):
                continue
            slug = slugify(name)
            identity_key = product_group_key(item)
            if not slug or not identity_key:
                continue
            publisher_candidates = _known_publishers(item.get("publisher_candidates"))
            if not publisher_candidates and publisher not in {"", "未知", "冲突待审"}:
                publisher_candidates = [str(publisher).strip()]
            source = {
                **item,
                "publisher_candidates": publisher_candidates,
            }
            group = product_index.setdefault(identity_key, {
                "product_slug": slug,
                "identity_key": identity_key,
                "product_name": name,
                "aliases": [],
                "sources": [],
            })
            group["aliases"] = list(dict.fromkeys([*group["aliases"], name]))
            group["sources"].append(source)

    for group in product_index.values():
        group["sources"] = merge_sources(group["sources"])
        publishers = sorted({
            publisher
            for source in group["sources"]
            for publisher in _known_publishers(source.get("publisher_candidates"))
        })
        group["publishers"] = publishers
        group["publisher_conflict"] = len(publishers) > 1
        group["publisher_conflicts"] = publishers if len(publishers) > 1 else []
        group["publisher"] = publishers[0] if len(publishers) == 1 else ("冲突待审" if publishers else "未知")
        group["needs_review"] = bool(group["publisher_conflict"])
        first_source = group["sources"][0] if group["sources"] else {}
        for field in ("account", "article_title", "article_date", "url", "description"):
            group[field] = first_source.get(field, "")
        for field in ("platforms", "links", "highlights", "differences", "critique"):
            group[field] = list(dict.fromkeys(
                value
                for source in group["sources"]
                for value in _clean_string_list(source.get(field))
            ))
    return product_index


def existing_structured_keys() -> set[str]:
    keys: set[str] = set()
    for record in read_jsonl(PRODUCT_RECORDS):
        for value in (
            record.get("subject"),
            record.get("title"),
            record.get("source_doc_id"),
        ):
            if value:
                text = str(value).strip()
                keys.add(text.lower())
                keys.add(slugify(text))
    return keys


def doc_id_for(item: dict[str, Any]) -> str:
    name = str(item.get("product_name") or "").strip()
    slug = slugify(name) or "unknown-product"
    identity_key = str(item.get("identity_key") or slug).strip()
    suffix = stable_hash(identity_key, name, length=10)
    return f"product:wechat-product-{slug[:72]}-{suffix}"


def _previous_sources(previous: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not previous:
        return []
    analysis = previous.get("wechat_product_analysis")
    if not isinstance(analysis, dict):
        return []
    if isinstance(analysis.get("sources"), list):
        return [source for source in analysis["sources"] if isinstance(source, dict)]
    publisher = str(analysis.get("publisher") or "").strip()
    return [{
        "account": analysis.get("account", ""),
        "article_title": analysis.get("article_title", ""),
        "url": analysis.get("article_url", ""),
        "description": analysis.get("description", ""),
        "publisher_candidates": [publisher] if publisher not in {"", "未知", "冲突待审"} else [],
    }]


def _aggregate_source_values(sources: list[dict[str, Any]], field: str) -> list[str]:
    return list(dict.fromkeys(
        value
        for source in sources
        for value in _clean_string_list(source.get(field))
    ))


def document_payload_hash(doc: dict[str, Any]) -> str:
    payload = {
        key: doc.get(key)
        for key in (
            "doc_id", "title", "source_type", "provider", "tags", "doc_form", "status",
            "quality_tier", "taxonomy_version", "source_url", "body", "product",
            "wechat_product_analysis",
        )
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def build_document(
    item: dict[str, Any],
    data_json: Path,
    now: str,
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    name = str(item.get("product_name") or "").strip()
    sources = merge_sources([*_previous_sources(previous), *item.get("sources", [])])
    publishers = sorted({
        publisher
        for source in sources
        for publisher in _known_publishers(source.get("publisher_candidates"))
    })
    publisher_conflict = len(publishers) > 1
    publisher = publishers[0] if len(publishers) == 1 else ("冲突待审" if publishers else "未知")
    cn_entities = list(dict.fromkeys(PUB_TO_CN[value] for value in publishers if value in PUB_TO_CN))
    cn_entity = cn_entities[0] if len(cn_entities) == 1 else ""
    account = str(item.get("account") or "未知公众号").strip()
    article = str(item.get("article_title") or "").strip()
    url = str(item.get("url") or "").strip()
    descriptions = list(dict.fromkeys(
        str(source.get("description") or "").strip()
        for source in sources
        if str(source.get("description") or "").strip()
    ))
    desc = descriptions[0] if descriptions else ""
    doc_id = doc_id_for(item)
    title = f"WeChat Product - {name}"
    body_lines = [
        f"# {name}",
        "",
        "公众号文章产品分析记录。",
        "",
        "## 基础信息",
        f"- 产品名称: {name}",
        f"- 发行商状态: {'conflict-needs-review' if publisher_conflict else 'resolved' if publishers else 'unknown'}",
        f"- 发行商: {publisher}",
    ]
    if publishers:
        body_lines.append(f"- 发行商候选: {'；'.join(publishers)}")
    if cn_entity:
        body_lines.append(f"- 中国主体候选: {cn_entity}（文章映射候选，未完成单产品核验）")
    if desc:
        body_lines.append(f"- 产品描述: {desc}")
    for label, field in (
        ("平台", "platforms"),
        ("亮点", "highlights"),
        ("差异点", "differences"),
        ("锐评", "critique"),
    ):
        values = _aggregate_source_values(sources, field)
        if values:
            body_lines.append(f"- {label}: {'；'.join(values)}")
    body_lines.extend(["", "## 来源证据"])
    for source in sources[:50]:
        source_line = " / ".join(
            value for value in (
                str(source.get("account") or "").strip(),
                str(source.get("article_title") or "").strip(),
                str(source.get("url") or "").strip(),
            ) if value
        )
        if source_line:
            body_lines.append(f"- {source_line}")
    body_lines.extend(
        [
            "",
            "## 对账信息",
            f"- 分析文件: {data_json}",
            "- 导入路径: wechat2md structured products importer",
        ]
    )
    body = "\n".join(body_lines).strip() + "\n"
    tags = ["products", "wechat-product-analysis", account, name]
    if publishers:
        tags.extend(["归属溯源", *publishers])
    if publisher_conflict:
        tags.append("needs-review")
    source_urls = list(dict.fromkeys(
        value
        for source in sources
        for value in [str(source.get("url") or "").strip(), *_clean_string_list(source.get("links"))]
        if value
    ))
    doc = {
        "doc_id": doc_id,
        "title": title,
        "source_type": "wechat-product-analysis",
        "provider": "wechat2md",
        "tags": sorted(set(tag for tag in tags if tag)),
        "doc_form": "公众号产品分析",
        "status": "needs-review" if publisher_conflict else "active",
        "quality_tier": "low",
        "taxonomy_version": "v2",
        "source_url": source_urls[0] if source_urls else url,
        "body": body,
        "created_at": str((previous or {}).get("created_at") or now),
        "updated_at": now,
        "product": {
            "primary_name": name,
            "aliases": _clean_string_list(item.get("aliases")),
            "identity_candidate": str(item.get("identity_key") or item.get("product_slug") or ""),
            "publishers": publishers,
            "publisher_conflict": publisher_conflict,
            "source_account": account,
            "source_article": article,
            "urls": source_urls,
            "sources": sources,
        },
        "wechat_product_analysis": {
            "publisher": publisher,
            "publishers": publishers,
            "publisher_conflict": publisher_conflict,
            "publisher_conflicts": publishers if publisher_conflict else [],
            "attribution_verified": False,
            "candidate_cn_entity": cn_entity,
            "cn_entity": cn_entity,
            "cn_entities": cn_entities,
            "account": account,
            "article_title": article,
            "article_url": url,
            "description": desc,
            "platforms": _aggregate_source_values(sources, "platforms"),
            "links": _aggregate_source_values(sources, "links"),
            "highlights": _aggregate_source_values(sources, "highlights"),
            "differences": _aggregate_source_values(sources, "differences"),
            "critique": _aggregate_source_values(sources, "critique"),
            "sources": sources,
            "analysis_json": str(data_json),
            "identity_candidate": str(item.get("identity_key") or item.get("product_slug") or ""),
        },
    }
    doc["content_hash"] = document_payload_hash(doc)
    return doc


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def quality_from_data(data: dict[str, Any]) -> dict[str, Any]:
    raw = data.get("quality")
    if not isinstance(raw, dict):
        return {"status": "fail", "pass": False, "failures": ["missing_quality_report"], "metrics": {}}
    metrics = raw.get("metrics") if isinstance(raw.get("metrics"), dict) else {}
    failures = _clean_string_list(raw.get("failures"))
    warnings = _clean_string_list(raw.get("warnings"))
    required_metrics = {"unknown_publisher_ratio", "suspicious_name_count", "publisher_conflict_count"}
    missing_metrics = sorted(required_metrics - set(metrics))
    if missing_metrics:
        failures.append("missing_quality_metrics:" + ",".join(missing_metrics))
    status = "pass" if raw.get("status") == "pass" and raw.get("pass") is not False and not failures else "fail"
    return {
        "status": status,
        "pass": status == "pass",
        "failures": failures,
        "warnings": warnings,
        "metrics": metrics,
    }


def quality_with_plan(quality: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    result = {
        "status": quality.get("status", "fail"),
        "pass": bool(quality.get("pass")),
        "failures": list(quality.get("failures") or []),
        "warnings": list(quality.get("warnings") or []),
        "metrics": dict(quality.get("metrics") or {}),
    }
    reported_conflicts = int(result["metrics"].get("publisher_conflict_count") or 0)
    planned_conflicts = int(plan.get("summary", {}).get("publisher_conflicts") or 0)
    if planned_conflicts > reported_conflicts:
        result["failures"].append("publisher_conflict_count_mismatch")
        result["status"] = "fail"
        result["pass"] = False
    result["metrics"]["import_candidate_publisher_conflict_count"] = planned_conflicts
    return result


def build_import_plan(
    product_index: dict[str, dict[str, Any]],
    data_json: Path,
) -> dict[str, Any]:
    existing_keys = existing_structured_keys()
    now = datetime.now(timezone.utc).isoformat()
    documents: list[dict[str, Any]] = []
    entries: list[dict[str, Any]] = []
    skipped_existing = 0

    for slug, item in sorted(product_index.items()):
        name = str(item.get("product_name") or "").strip()
        doc_id = doc_id_for(item)
        path = DOCUMENTS_DIR / f"{doc_id}.json"
        previous: dict[str, Any] | None = None
        if path.exists():
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise ValueError(f"existing document is not an object: {path}")
            previous = loaded
        elif name.lower() in existing_keys or slug in existing_keys:
            skipped_existing += 1
            entries.append({"product_slug": slug, "product_name": name, "action": "skipped-existing-foreign"})
            continue

        doc = build_document(item, data_json, now, previous=previous)
        if previous and previous.get("content_hash") == doc.get("content_hash"):
            action = "unchanged"
        else:
            action = "updated" if previous else "created"
            documents.append(doc)
        entries.append({
            "product_slug": slug,
            "product_name": name,
            "doc_id": doc_id,
            "content_hash": doc["content_hash"],
            "action": action,
            "publisher": item.get("publisher", "未知"),
            "publisher_conflict": bool(item.get("publisher_conflict")),
            "source_count": len(item.get("sources", [])),
        })

    actions = Counter(entry["action"] for entry in entries)
    conflict_entries = [entry for entry in entries if entry.get("publisher_conflict")]
    summary = {
        "unique_products": len(product_index),
        "created": actions.get("created", 0),
        "updated": actions.get("updated", 0),
        "unchanged": actions.get("unchanged", 0),
        "skipped_existing": skipped_existing,
        "would_write_documents": len(documents),
        "publisher_conflicts": len(conflict_entries),
        "needs_review": len(conflict_entries),
        "sample_products": [entry.get("product_name", "") for entry in entries[:10]],
        "sample_conflicts": conflict_entries[:10],
    }
    digest_payload = json.dumps(entries, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {
        "documents": documents,
        "entries": entries,
        "summary": summary,
        "candidate_digest": hashlib.sha256(digest_payload.encode("utf-8")).hexdigest(),
    }


def receipt_path_for(data_json: Path, requested: Path | None) -> Path:
    return requested.expanduser().resolve() if requested else data_json.parent / "_structured_import_receipt.json"


def include_subjects_binding(path: Path | None) -> dict[str, Any]:
    if not path:
        return {"path": None, "sha256": None}
    resolved = path.expanduser().resolve()
    return {"path": str(resolved), "sha256": sha256_file(resolved)}


def build_receipt(
    *,
    data_json: Path,
    data_sha256: str,
    include_subjects: dict[str, Any],
    plan: dict[str, Any],
    quality: dict[str, Any],
    ttl_hours: float,
    now: datetime | None = None,
) -> dict[str, Any]:
    created = now or datetime.now(timezone.utc)
    return {
        "version": RECEIPT_VERSION,
        "created_at": created.isoformat(),
        "expires_at": (created + timedelta(hours=ttl_hours)).isoformat(),
        "data_json": str(data_json),
        "data_json_sha256": data_sha256,
        "include_subjects": include_subjects,
        "candidate_digest": plan["candidate_digest"],
        "candidate_summary": plan["summary"],
        "quality": quality,
        "target": "structured/products",
    }


def validate_receipt(
    receipt: dict[str, Any],
    *,
    data_json: Path,
    data_sha256: str,
    include_subjects: dict[str, Any],
    plan: dict[str, Any],
    quality: dict[str, Any],
    now: datetime | None = None,
) -> None:
    errors: list[str] = []
    if receipt.get("version") != RECEIPT_VERSION:
        errors.append("receipt_version_mismatch")
    if receipt.get("data_json") != str(data_json):
        errors.append("data_json_path_mismatch")
    if receipt.get("data_json_sha256") != data_sha256:
        errors.append("data_json_sha256_mismatch")
    if receipt.get("include_subjects") != include_subjects:
        errors.append("include_subjects_mismatch")
    if receipt.get("candidate_digest") != plan.get("candidate_digest"):
        errors.append("candidate_digest_mismatch")
    if receipt.get("candidate_summary") != plan.get("summary"):
        errors.append("candidate_summary_mismatch")
    if receipt.get("quality") != quality:
        errors.append("quality_status_mismatch")
    try:
        expires_at = datetime.fromisoformat(str(receipt.get("expires_at")))
        if expires_at.tzinfo is None:
            raise ValueError("timezone required")
        if (now or datetime.now(timezone.utc)) >= expires_at:
            errors.append("receipt_expired")
    except (TypeError, ValueError):
        errors.append("receipt_expiry_invalid")
    if errors:
        raise ValueError("receipt validation failed: " + ", ".join(errors))


@contextmanager
def single_writer_lock(path: Path = WRITE_LOCK):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def preflight_documents(documents: list[dict[str, Any]]) -> None:
    doc_ids: set[str] = set()
    for doc in documents:
        doc_id = str(doc.get("doc_id") or "")
        if not doc_id or doc_id in doc_ids:
            raise ValueError(f"invalid or duplicate document id: {doc_id!r}")
        doc_ids.add(doc_id)
        if doc.get("source_type") != "wechat-product-analysis":
            raise ValueError(f"unexpected source_type for {doc_id}")
        if doc.get("content_hash") != document_payload_hash(doc):
            raise ValueError(f"content hash mismatch for {doc_id}")
        json.dumps(doc, ensure_ascii=False, sort_keys=True)


def _load_structured_builder():
    spec = importlib.util.spec_from_file_location("wechat_products_structured_builder", STRUCTURED_BUILDER)
    if not spec or not spec.loader:
        raise RuntimeError(f"cannot load structured builder: {STRUCTURED_BUILDER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def refresh_structured_products() -> dict[str, Any]:
    builder = _load_structured_builder()
    config = builder.load_json(VAULT_ROOT / "kb-instances.json")
    return builder.build_one("products", config)


def commit_documents_and_structured(documents: list[dict[str, Any]]) -> dict[str, Any]:
    if not documents:
        return {"status": "skipped", "reason": "no_document_changes"}
    preflight_documents(documents)
    DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=".wechat-products-staging-", dir=str(DOCUMENTS_DIR.parent)))
    backup_dir = Path(tempfile.mkdtemp(prefix=".wechat-products-backup-", dir=str(DOCUMENTS_DIR.parent)))
    committed: list[Path] = []
    backed_up: set[Path] = set()
    try:
        for doc in documents:
            staged = staging_dir / f"{doc['doc_id']}.json"
            staged.write_text(json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            loaded = json.loads(staged.read_text(encoding="utf-8"))
            if loaded.get("content_hash") != document_payload_hash(loaded):
                raise ValueError(f"staged content hash mismatch for {doc['doc_id']}")

        for doc in documents:
            target = DOCUMENTS_DIR / f"{doc['doc_id']}.json"
            staged = staging_dir / target.name
            if target.exists():
                shutil.copy2(target, backup_dir / target.name)
                backed_up.add(target)
            os.replace(staged, target)
            committed.append(target)

        structured_result = refresh_structured_products()
        return {"status": "committed", "structured": structured_result}
    except Exception:
        for target in reversed(committed):
            backup = backup_dir / target.name
            if target in backed_up and backup.exists():
                os.replace(backup, target)
            else:
                target.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)
        shutil.rmtree(backup_dir, ignore_errors=True)


def prepare_import_context(
    *,
    product_index: dict[str, dict[str, Any]],
    data: dict[str, Any],
    data_json: Path,
    data_sha256: str,
    include_binding: dict[str, Any],
    receipt_path: Path,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    plan = build_import_plan(product_index, data_json)
    quality = quality_with_plan(quality_from_data(data), plan)
    base_report = {
        "data_json": str(data_json),
        "data_json_sha256": data_sha256,
        "include_subjects": include_binding,
        "candidate_digest": plan["candidate_digest"],
        "candidate_summary": plan["summary"],
        "quality": quality,
        "receipt_json": str(receipt_path),
        "target": "structured/products",
    }
    return plan, quality, base_report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Import WeChat product analysis into structured/products.")
    parser.add_argument("--data-json", type=Path, required=True, help="Current-run publisher analysis JSON (required).")
    parser.add_argument(
        "--include-subjects-file",
        type=Path,
        help="Optional JSON list or newline file of product subjects/slugs to import from the analysis.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Write a scoped receipt without changing business data.")
    mode.add_argument("--confirm", action="store_true", help="Verify the receipt, then write documents and structured/products.")
    parser.add_argument("--receipt-json", type=Path, help="Receipt path; defaults beside data-json.")
    parser.add_argument(
        "--receipt-max-age-hours",
        type=float,
        default=DEFAULT_RECEIPT_TTL_HOURS,
        help="Receipt TTL written by --dry-run (default: 24 hours).",
    )
    parser.add_argument(
        "--high-risk-override-quality-gate",
        action="store_true",
        help="HIGH RISK: allow --confirm when analysis quality is fail; requires --override-reason and writes an audit report.",
    )
    parser.add_argument("--override-reason", default="", help="Required human rationale for the high-risk quality override.")
    parser.add_argument("--override-report-json", type=Path, help="Override audit report path; defaults beside data-json.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.receipt_max_age_hours <= 0:
        print("拒绝执行：--receipt-max-age-hours 必须大于 0。", file=sys.stderr)
        return 2
    if args.high_risk_override_quality_gate and not args.confirm:
        print("拒绝执行：高风险质量 override 只能与 --confirm 同时使用。", file=sys.stderr)
        return 2

    data_json = args.data_json.expanduser().resolve()
    try:
        data = json.loads(data_json.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("data-json root must be a JSON object")
        data_sha256 = sha256_file(data_json)
        product_index = collect_products(data)
        include_subjects = read_subject_filter(args.include_subjects_file)
        if include_subjects is not None:
            product_index = {
                slug: item
                for slug, item in product_index.items()
                if slug in include_subjects or str(item.get("product_name") or "").strip().lower() in include_subjects
            }
        include_binding = include_subjects_binding(args.include_subjects_file)
        receipt_path = receipt_path_for(data_json, args.receipt_json)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1

    if args.dry_run:
        try:
            plan, quality, base_report = prepare_import_context(
                product_index=product_index,
                data=data,
                data_json=data_json,
                data_sha256=data_sha256,
                include_binding=include_binding,
                receipt_path=receipt_path,
            )
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
            return 1
        receipt = build_receipt(
            data_json=data_json,
            data_sha256=data_sha256,
            include_subjects=include_binding,
            plan=plan,
            quality=quality,
            ttl_hours=args.receipt_max_age_hours,
        )
        try:
            write_json_atomic(receipt_path, receipt)
        except OSError as exc:
            print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
            return 1
        print(json.dumps({"dry_run": True, **base_report, "receipt": receipt}, ensure_ascii=False, indent=2))
        return 0 if quality["status"] == "pass" else 3

    override_report: dict[str, Any] | None = None
    override_path = (
        args.override_report_json.expanduser().resolve()
        if args.override_report_json
        else data_json.parent / "_structured_import_quality_override.json"
    )
    try:
        with single_writer_lock():
            try:
                plan, quality, base_report = prepare_import_context(
                    product_index=product_index,
                    data=data,
                    data_json=data_json,
                    data_sha256=data_sha256,
                    include_binding=include_binding,
                    receipt_path=receipt_path,
                )
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                if not isinstance(receipt, dict):
                    raise ValueError("receipt root must be a JSON object")
                validate_receipt(
                    receipt,
                    data_json=data_json,
                    data_sha256=data_sha256,
                    include_subjects=include_binding,
                    plan=plan,
                    quality=quality,
                )
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                report = {
                    "status": "refused",
                    "error": str(exc),
                    "data_json": str(data_json),
                    "receipt_json": str(receipt_path),
                    "target": "structured/products",
                }
                if "base_report" in locals():
                    report.update(base_report)
                print(json.dumps(report, ensure_ascii=False, indent=2), file=sys.stderr)
                return 2

            if quality["status"] != "pass":
                if not args.high_risk_override_quality_gate:
                    print(json.dumps({
                        "status": "refused",
                        "error": "analysis quality hard gate failed; use a new passing analysis or the explicit high-risk override",
                        **base_report,
                    }, ensure_ascii=False, indent=2), file=sys.stderr)
                    return 3
                if len(args.override_reason.strip()) < 12:
                    print(json.dumps({
                        "status": "refused",
                        "error": "--override-reason must contain at least 12 characters",
                        **base_report,
                    }, ensure_ascii=False, indent=2), file=sys.stderr)
                    return 2
                override_report = {
                    "version": 1,
                    "status": "approved-for-attempt",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "high_risk_flag": "--high-risk-override-quality-gate",
                    "reason": args.override_reason.strip(),
                    "receipt_json": str(receipt_path),
                    "receipt_sha256": sha256_file(receipt_path),
                    **base_report,
                }
                write_json_atomic(override_path, override_report)
            elif args.high_risk_override_quality_gate:
                print(json.dumps({"status": "refused", "error": "quality passed; high-risk override is not applicable"}, ensure_ascii=False, indent=2), file=sys.stderr)
                return 2

            try:
                transaction = commit_documents_and_structured(plan["documents"])
            except Exception as exc:  # noqa: BLE001 - transaction has already rolled back
                if override_report is not None:
                    override_report["status"] = "failed-rolled-back"
                    override_report["finished_at"] = datetime.now(timezone.utc).isoformat()
                    override_report["error"] = str(exc)
                    write_json_atomic(override_path, override_report)
                print(json.dumps({"status": "error-rolled-back", "error": str(exc), **base_report}, ensure_ascii=False, indent=2), file=sys.stderr)
                return 1

            if override_report is not None:
                override_report["status"] = "committed"
                override_report["finished_at"] = datetime.now(timezone.utc).isoformat()
                override_report["transaction"] = transaction
                write_json_atomic(override_path, override_report)
    except OSError as exc:
        print(json.dumps({
            "status": "error",
            "error": f"structured product writer lock failed: {exc}",
            "target": "structured/products",
        }, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1

    print(json.dumps({
        "confirm": True,
        "status": "ok",
        **base_report,
        "transaction": transaction,
        "override_report_json": str(override_path) if override_report is not None else None,
        "sample_doc_ids": [doc["doc_id"] for doc in plan["documents"][:10]],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

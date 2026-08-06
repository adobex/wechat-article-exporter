#!/usr/bin/env python3
"""Remove noisy WeChat product-analysis documents from structured/products."""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
IMPORTER_PATH = SCRIPT_DIR / "batch-products-structured-import.py"
VAULT_ROOT = Path("/Users/adobe/Project/knowledge-vault")
DOCUMENTS_DIR = VAULT_ROOT / "documents"
STRUCTURED_BUILDER = VAULT_ROOT / "scripts" / "build-structured-ai-products.py"


def load_importer():
    spec = importlib.util.spec_from_file_location("batch_products_structured_import", IMPORTER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {IMPORTER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def iter_wechat_product_docs(active_only: bool = True) -> list[tuple[Path, dict[str, Any]]]:
    rows: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(DOCUMENTS_DIR.glob("product:wechat-product-*.json")):
        try:
            doc = load_json(path)
        except Exception:
            continue
        tags = [str(tag) for tag in doc.get("tags", [])]
        if doc.get("source_type") != "wechat-product-analysis":
            continue
        if active_only and (doc.get("status") == "rejected" or "products" not in tags):
            continue
        else:
            rows.append((path, doc))
    return rows


def product_name(doc: dict[str, Any]) -> str:
    product = doc.get("product") if isinstance(doc.get("product"), dict) else {}
    analysis = doc.get("wechat_product_analysis") if isinstance(doc.get("wechat_product_analysis"), dict) else {}
    return str(product.get("primary_name") or analysis.get("product_name") or doc.get("title") or "").strip()


def reject_doc(path: Path, doc: dict[str, Any], reason: str) -> str:
    doc_id = str(doc.get("doc_id") or path.stem)
    tags = [str(tag) for tag in doc.get("tags", []) if str(tag) != "products"]
    tags.append("rejected-products-noise")
    tags.append("wechat-product-analysis-noise")
    doc["tags"] = sorted(set(tags))
    doc["status"] = "rejected"
    doc["rejected_reason"] = reason
    doc["updated_at"] = datetime.now(timezone.utc).isoformat()
    write_json(path, doc)
    subprocess.run(
        [
            sys.executable,
            str(STRUCTURED_BUILDER),
            "--kb",
            "products",
            "--source-doc-id",
            doc_id,
            "--confirm-build",
        ],
        cwd=str(VAULT_ROOT),
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return doc_id


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Remove noisy WeChat product docs from structured/products.")
    parser.add_argument("--dry-run", action="store_true", help="Report noisy docs without modifying files.")
    parser.add_argument("--confirm", action="store_true", help="Mark noisy docs rejected and remove structured records.")
    parser.add_argument("--report-json", type=Path, help="Write a JSON report.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not args.dry_run and not args.confirm:
        print("拒绝执行：清理前请传 --dry-run；正式清理必须传 --confirm。", file=sys.stderr)
        return 2

    importer = load_importer()
    noisy = []
    active_docs = iter_wechat_product_docs(active_only=True)
    for path, doc in active_docs:
        name = product_name(doc)
        if importer.is_noise_product(name):
            noisy.append((path, doc, name))

    rejected_doc_ids: list[str] = []
    if args.confirm:
        for path, doc, name in noisy:
            rejected_doc_ids.append(reject_doc(path, doc, f"Rejected by wechat product importer noise filter: {name}"))

    payload = {
        "dry_run": bool(args.dry_run),
        "confirm": bool(args.confirm),
        "scanned_docs": len(active_docs),
        "noisy_docs": len(noisy),
        "by_name": dict(Counter(name for _, _, name in noisy)),
        "doc_ids": [str(doc.get("doc_id") or path.stem) for path, doc, _ in noisy],
        "rejected_doc_ids": rejected_doc_ids,
    }
    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

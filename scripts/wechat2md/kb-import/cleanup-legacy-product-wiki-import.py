#!/usr/bin/env python3
"""Remove legacy WeChat product-account rows from the wiki runtime.

This targets rows created by the old batch-wiki-import.py product-account path.
It rewrites JSONL files and their paired embedding binaries in lockstep so row
order and vector order stay aligned.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import struct
import sys
import tempfile
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


VAULT_ROOT = Path("/Users/adobe/Project/knowledge-vault")
WIKI_DIR = VAULT_ROOT / "wiki"
WRITE_LOCK = VAULT_ROOT / ".local" / "locks" / "legacy-product-wiki-cleanup.lock"
DEFAULT_TARGETS = [
    (WIKI_DIR / "syntheses.jsonl", WIKI_DIR / "syntheses_embeddings.bin"),
    (WIKI_DIR / "shards" / "products" / "attribution.jsonl", WIKI_DIR / "shards" / "products" / "attribution_embeddings.bin"),
    (WIKI_DIR / "shards" / "products" / "profile.jsonl", WIKI_DIR / "shards" / "products" / "profile_embeddings.bin"),
]


def is_legacy_wechat_product_row(row: dict[str, Any]) -> bool:
    title = str(row.get("title") or "")
    content = str(row.get("content") or "")
    return (
        row.get("origin") == "web-research"
        and row.get("synthesis_type") in {"attribution", "profile"}
        and (
            title.endswith("产品归因（公众号文章）")
            or title.endswith("产品档案（公众号文章）")
        )
        and "公众号" in content
    )


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
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


def jsonl_bytes(rows: list[dict[str, Any]]) -> bytes:
    return "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows
    ).encode("utf-8")


def filtered_embedding_bytes(path: Path, keep_indexes: list[int], original_count: int) -> tuple[bytes, int]:
    if not path.exists():
        raise ValueError(f"paired embedding file is missing: {path}")
    raw = path.read_bytes()
    if len(raw) < 8:
        raise ValueError(f"{path} is too small to contain an embedding header")
    count, dim = struct.unpack("<II", raw[:8])
    expected_size = 8 + count * dim * 4
    if len(raw) != expected_size:
        raise ValueError(f"{path} size mismatch: expected {expected_size}, got {len(raw)}")
    if count != original_count:
        raise ValueError(f"{path} count {count} does not match JSONL row count {original_count}")
    vector_size = dim * 4
    output = bytearray(struct.pack("<II", len(keep_indexes), dim))
    for index in keep_indexes:
        start = 8 + index * vector_size
        output.extend(raw[start:start + vector_size])
    return bytes(output), dim


def validate_pair(jsonl_path: Path, embedding_path: Path) -> dict[str, int]:
    rows = read_jsonl(jsonl_path)
    _, dim = filtered_embedding_bytes(embedding_path, list(range(len(rows))), len(rows))
    return {"count": len(rows), "dim": dim}


def build_target_plan(jsonl_path: Path, embedding_path: Path) -> dict[str, Any]:
    if not jsonl_path.exists() and not embedding_path.exists():
        return {
            "jsonl_path": jsonl_path,
            "embedding_path": embedding_path,
            "jsonl": str(jsonl_path),
            "embedding": str(embedding_path),
            "before": 0,
            "remove": 0,
            "after": 0,
            "status": "missing-pair",
            "subjects": [],
            "synthesis_ids": [],
            "by_type": {},
            "jsonl_bytes": b"",
            "embedding_bytes": b"",
            "dim": 0,
        }
    if not jsonl_path.exists() or not embedding_path.exists():
        raise ValueError(f"incomplete JSONL/embedding pair: {jsonl_path} / {embedding_path}")

    rows = read_jsonl(jsonl_path)
    remove_indexes = [idx for idx, row in enumerate(rows) if is_legacy_wechat_product_row(row)]
    remove_set = set(remove_indexes)
    keep_indexes = [idx for idx in range(len(rows)) if idx not in remove_set]
    keep_rows = [rows[idx] for idx in keep_indexes]
    removed_rows = [rows[idx] for idx in remove_indexes]
    embedding, dim = filtered_embedding_bytes(embedding_path, keep_indexes, len(rows))
    return {
        "jsonl_path": jsonl_path,
        "embedding_path": embedding_path,
        "jsonl": str(jsonl_path),
        "embedding": str(embedding_path),
        "before": len(rows),
        "remove": len(remove_indexes),
        "after": len(keep_rows),
        "status": "ready" if remove_indexes else "no-matches",
        "by_type": dict(Counter(str(row.get("synthesis_type") or "") for row in removed_rows)),
        "subjects": [str(row.get("subject") or "") for row in removed_rows],
        "synthesis_ids": [str(row.get("synthesis_id") or "") for row in removed_rows],
        "jsonl_bytes": jsonl_bytes(keep_rows),
        "embedding_bytes": embedding,
        "dim": dim,
    }


def public_plan(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in plan.items()
        if key not in {"jsonl_path", "embedding_path", "jsonl_bytes", "embedding_bytes"}
    }


@contextmanager
def single_writer_lock(path: Path = WRITE_LOCK):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def write_bytes_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def default_backup_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return WIKI_DIR / ".backups" / f"legacy-product-cleanup-{stamp}"


def restore_backup(backup: Path, target: Path) -> None:
    fd, tmp_name = tempfile.mkstemp(prefix=f".{target.name}.restore-", suffix=".tmp", dir=str(target.parent))
    os.close(fd)
    try:
        shutil.copy2(backup, tmp_name)
        os.replace(tmp_name, target)
    finally:
        Path(tmp_name).unlink(missing_ok=True)


def apply_cleanup_plans(plans: list[dict[str, Any]], backup_dir: Path) -> dict[str, Any]:
    changed = [plan for plan in plans if plan["remove"] > 0]
    if not changed:
        return {"status": "skipped", "reason": "no_matches", "backup_dir": None}

    WIKI_DIR.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=".legacy-product-cleanup-staging-", dir=str(WIKI_DIR)))
    staged_files: dict[Path, Path] = {}
    backups: dict[Path, Path] = {}
    replaced: list[Path] = []
    try:
        backup_dir.mkdir(parents=True, exist_ok=False)
        for index, plan in enumerate(changed):
            staged_jsonl = staging_dir / f"{index:02d}.jsonl"
            staged_embedding = staging_dir / f"{index:02d}.bin"
            staged_jsonl.write_bytes(plan["jsonl_bytes"])
            staged_embedding.write_bytes(plan["embedding_bytes"])
            validate_pair(staged_jsonl, staged_embedding)
            staged_files[plan["jsonl_path"]] = staged_jsonl
            staged_files[plan["embedding_path"]] = staged_embedding

            for suffix, target in (("jsonl", plan["jsonl_path"]), ("bin", plan["embedding_path"])):
                backup = backup_dir / f"{index:02d}-{suffix}-{target.name}"
                shutil.copy2(target, backup)
                backups[target] = backup

        manifest = {
            "version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "files": [{"target": str(target), "backup": str(backup)} for target, backup in backups.items()],
        }
        (backup_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        for plan in changed:
            for target in (plan["jsonl_path"], plan["embedding_path"]):
                os.replace(staged_files[target], target)
                replaced.append(target)
            validate_pair(plan["jsonl_path"], plan["embedding_path"])
        return {"status": "committed", "backup_dir": str(backup_dir), "files_replaced": len(replaced)}
    except Exception:
        for target in reversed(replaced):
            backup = backups.get(target)
            if backup and backup.exists():
                restore_backup(backup, target)
        raise
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Clean legacy WeChat product rows from wiki runtime.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Validate every pair and report matches without modifying runtime files.")
    mode.add_argument("--confirm", action="store_true", help="Stage, back up, and atomically replace validated JSONL/embedding pairs.")
    parser.add_argument("--write-subjects-file", type=Path, help="Write matched subjects from syntheses.jsonl for structured backfill.")
    parser.add_argument("--report-json", type=Path, help="Write a JSON cleanup report.")
    parser.add_argument("--backup-dir", type=Path, help="Persistent backup directory for --confirm.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        plans = [build_target_plan(jsonl_path, embedding_path) for jsonl_path, embedding_path in DEFAULT_TARGETS]
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "validation-failed", "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    results = [public_plan(plan) for plan in plans]
    syntheses_subjects = plans[0]["subjects"] if plans else []

    if args.write_subjects_file:
        write_bytes_atomic(
            args.write_subjects_file.expanduser().resolve(),
            (json.dumps(sorted(set(s for s in syntheses_subjects if s)), ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        )

    transaction: dict[str, Any] | None = None
    if args.confirm:
        backup_dir = args.backup_dir.expanduser().resolve() if args.backup_dir else default_backup_dir()
        try:
            with single_writer_lock():
                transaction = apply_cleanup_plans(plans, backup_dir)
        except Exception as exc:  # noqa: BLE001 - replacements were restored from backup
            print(json.dumps({
                "status": "error-rolled-back",
                "error": str(exc),
                "backup_dir": str(backup_dir),
                "targets": results,
            }, ensure_ascii=False, indent=2), file=sys.stderr)
            return 1

    payload = {
        "dry_run": bool(args.dry_run),
        "confirm": bool(args.confirm),
        "targets": results,
        "total_remove": sum(result["remove"] for result in results),
        "preflight": "pass",
        "transaction": transaction,
    }
    if args.report_json:
        write_bytes_atomic(
            args.report_json.expanduser().resolve(),
            (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

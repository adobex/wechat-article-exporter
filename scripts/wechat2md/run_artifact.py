#!/usr/bin/env python3
"""Atomically reserve a unique artifact directory for one automation run."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


RUN_METADATA = "run.json"
SAFE_WORKFLOW_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    finally:
        tmp_path.unlink(missing_ok=True)


def canonical_owner_token(value: str) -> str:
    try:
        return str(uuid.UUID(value.strip()))
    except ValueError as exc:
        raise ValueError("owner_token must be a full UUID") from exc


def read_matching_reservation(path: Path, *, workflow_id: str, owner_token: str) -> dict[str, Any] | None:
    metadata_path = path / RUN_METADATA
    if not metadata_path.is_file():
        return None
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    if payload.get("workflow_id") == workflow_id and payload.get("owner_token") == owner_token:
        return payload
    return None


def reserve_run_directory(
    root: Path,
    *,
    workflow_id: str,
    owner_token: str,
    now: datetime | None = None,
    max_attempts: int = 8,
    collision_uuid_factory: Callable[[], uuid.UUID] = uuid.uuid4,
) -> dict[str, Any]:
    if not SAFE_WORKFLOW_ID.fullmatch(workflow_id):
        raise ValueError("workflow_id must contain only lowercase letters, digits, and hyphens")
    if max_attempts <= 0:
        raise ValueError("max_attempts must be greater than zero")

    owner_token = canonical_owner_token(owner_token)
    created_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    timestamp = created_at.strftime("%Y%m%dT%H%M%SZ")
    workflow_root = root.expanduser().resolve() / workflow_id
    workflow_root.mkdir(parents=True, exist_ok=True)

    for attempt in range(max_attempts):
        suffix = owner_token if attempt == 0 else f"{owner_token}-{collision_uuid_factory()}"
        run_id = f"{timestamp}-{suffix}"
        run_dir = workflow_root / run_id
        try:
            run_dir.mkdir(mode=0o700)
        except FileExistsError:
            existing = read_matching_reservation(
                run_dir,
                workflow_id=workflow_id,
                owner_token=owner_token,
            )
            if existing is not None:
                return {
                    "reserved": True,
                    "result": "already-reserved",
                    "run_id": run_id,
                    "run_dir": str(run_dir),
                    "manifest_path": str(run_dir / "files.json"),
                    "metadata": existing,
                }
            continue

        metadata = {
            "version": 1,
            "workflow_id": workflow_id,
            "owner_token": owner_token,
            "run_id": run_id,
            "created_at": created_at.isoformat(),
        }
        try:
            atomic_write_json(run_dir / RUN_METADATA, metadata)
        except Exception:
            run_dir.rmdir()
            raise
        return {
            "reserved": True,
            "result": "reserved",
            "run_id": run_id,
            "run_dir": str(run_dir),
            "manifest_path": str(run_dir / "files.json"),
            "metadata": metadata,
        }

    raise FileExistsError(f"could not reserve a unique run directory after {max_attempts} attempts")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reserve a unique wechat2md run artifact directory.")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--workflow-id", required=True)
    parser.add_argument("--owner-token", required=True)
    parser.add_argument("--max-attempts", type=int, default=8)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = reserve_run_directory(
            args.root,
            workflow_id=args.workflow_id,
            owner_token=args.owner_token,
            max_attempts=args.max_attempts,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

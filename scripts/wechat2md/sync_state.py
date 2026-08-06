#!/usr/bin/env python3
"""Snapshot, verify, and gate atomic wechat2md sync-state publication."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SNAPSHOT_VERSION = 1
REQUIRED_GATE_FIELDS = (
    "complete_source_probe_succeeded",
    "required_integrity_audit_completed",
    "manifest_and_downstream_succeeded",
    "lease_heartbeat_active",
    "post_write_verification_succeeded",
    "state_migration_safe",
)
REQUIRED_STATE_FIELDS = (
    "high_watermark_publish_timestamp",
    "high_watermark_article_ids",
    "last_successful_run_at",
    "last_integrity_audit_at",
    "last_integrity_audit_date_floor",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
        fsync_directory(path.parent)
    finally:
        tmp_path.unlink(missing_ok=True)


def load_json_object(path: Path, *, label: str) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def state_identity(path: Path) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.exists() and not resolved.is_file():
        raise ValueError("state_file must be a regular file when it exists")
    exists = resolved.is_file()
    return {
        "state_file": str(resolved),
        "exists": exists,
        "sha256": sha256_file(resolved) if exists else None,
    }


def capture_snapshot(state_file: Path, snapshot_file: Path) -> dict[str, Any]:
    if state_file.expanduser().resolve() == snapshot_file.expanduser().resolve():
        raise ValueError("snapshot_file must differ from state_file")
    state = state_identity(state_file)
    snapshot = {
        "version": SNAPSHOT_VERSION,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        **state,
    }
    atomic_write_json(snapshot_file.expanduser().resolve(), snapshot)
    return {"snapshotted": True, "snapshot_file": str(snapshot_file.expanduser().resolve()), **snapshot}


def load_snapshot(snapshot_file: Path, state_file: Path) -> dict[str, Any]:
    snapshot = load_json_object(snapshot_file.expanduser().resolve(), label="snapshot")
    if snapshot.get("version") != SNAPSHOT_VERSION:
        raise ValueError("unsupported snapshot version")
    expected_path = str(state_file.expanduser().resolve())
    if snapshot.get("state_file") != expected_path:
        raise ValueError("snapshot state_file does not match requested state_file")
    if not isinstance(snapshot.get("exists"), bool):
        raise ValueError("snapshot exists must be boolean")
    expected_hash = snapshot.get("sha256")
    if snapshot["exists"] and (not isinstance(expected_hash, str) or len(expected_hash) != 64):
        raise ValueError("snapshot sha256 is invalid")
    if not snapshot["exists"] and expected_hash is not None:
        raise ValueError("absent snapshot must have null sha256")
    return snapshot


def verify_unchanged(state_file: Path, snapshot_file: Path) -> dict[str, Any]:
    snapshot = load_snapshot(snapshot_file, state_file)
    current = state_identity(state_file)
    unchanged = current["exists"] == snapshot["exists"] and current["sha256"] == snapshot["sha256"]
    return {
        "unchanged": unchanged,
        "result": "unchanged" if unchanged else "state-changed",
        "state_file": current["state_file"],
        "expected_exists": snapshot["exists"],
        "actual_exists": current["exists"],
        "expected_sha256": snapshot["sha256"],
        "actual_sha256": current["sha256"],
    }


def validate_gate(gate_file: Path) -> tuple[dict[str, Any], list[str]]:
    gate = load_json_object(gate_file.expanduser().resolve(), label="gate")
    invalid = [field for field in REQUIRED_GATE_FIELDS if gate.get(field) is not True]
    return gate, invalid


def validate_active_leases(lease_files: list[Path], owner_token: str) -> dict[str, Any]:
    owner_token = owner_token.strip()
    if not owner_token:
        raise ValueError("owner_token is required")
    normalized = [path.expanduser().resolve() for path in lease_files]
    if not normalized:
        raise ValueError("at least one lease_file is required")
    if len(normalized) != len(set(normalized)):
        raise ValueError("lease_file entries must be unique")
    now = datetime.now(timezone.utc)
    failures: list[dict[str, Any]] = []
    for path in normalized:
        try:
            lease = load_json_object(path, label="lease")
            expires_at = datetime.fromisoformat(str(lease.get("expires_at")))
            if expires_at.tzinfo is None:
                raise ValueError("expires_at must include a timezone")
            if lease.get("owner_token") != owner_token:
                failures.append({"lease_file": str(path), "reason": "owner-token-mismatch"})
            elif now >= expires_at.astimezone(timezone.utc):
                failures.append({"lease_file": str(path), "reason": "lease-expired"})
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            failures.append({"lease_file": str(path), "reason": "invalid-lease", "error": str(exc)})
    return {
        "active": not failures,
        "lease_files": [str(path) for path in normalized],
        "failures": failures,
    }


def validate_candidate(candidate: dict[str, Any]) -> None:
    missing = [field for field in REQUIRED_STATE_FIELDS if field not in candidate]
    if missing:
        raise ValueError(f"candidate state is missing required fields: {', '.join(missing)}")
    if not isinstance(candidate["high_watermark_article_ids"], list):
        raise ValueError("candidate high_watermark_article_ids must be an array")
    for field in ("last_successful_run_at", "last_integrity_audit_date_floor"):
        if not isinstance(candidate[field], str) or not candidate[field].strip():
            raise ValueError(f"candidate {field} must be a non-empty string")
    if candidate["last_integrity_audit_at"] is not None and not isinstance(
        candidate["last_integrity_audit_at"], str
    ):
        raise ValueError("candidate last_integrity_audit_at must be a string or null")


def publish_state(
    state_file: Path,
    snapshot_file: Path,
    candidate_file: Path,
    gate_file: Path,
    lease_files: list[Path],
    owner_token: str,
) -> dict[str, Any]:
    distinct_paths = [
        state_file.expanduser().resolve(),
        snapshot_file.expanduser().resolve(),
        candidate_file.expanduser().resolve(),
        gate_file.expanduser().resolve(),
    ]
    if len(distinct_paths) != len(set(distinct_paths)):
        raise ValueError("state, snapshot, candidate, and gate files must be distinct")
    unchanged = verify_unchanged(state_file, snapshot_file)
    if not unchanged["unchanged"]:
        return {"published": False, **unchanged}

    _, failed_gates = validate_gate(gate_file)
    if failed_gates:
        return {
            "published": False,
            "result": "gate-failed",
            "state_file": unchanged["state_file"],
            "failed_gates": failed_gates,
            "state_unchanged": True,
        }

    leases = validate_active_leases(lease_files, owner_token)
    if not leases["active"]:
        return {
            "published": False,
            "result": "lease-check-failed",
            "state_file": unchanged["state_file"],
            "state_unchanged": True,
            "lease_check": leases,
        }

    candidate = load_json_object(candidate_file.expanduser().resolve(), label="candidate state")
    validate_candidate(candidate)
    resolved_state = state_file.expanduser().resolve()
    atomic_write_json(resolved_state, candidate)
    return {
        "published": True,
        "result": "published",
        "state_file": str(resolved_state),
        "sha256": sha256_file(resolved_state),
        "lease_check": leases,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Gate atomic publication of wechat2md sync state.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("--state-file", type=Path, required=True)
    snapshot.add_argument("--snapshot-file", type=Path, required=True)

    verify = subparsers.add_parser("verify-unchanged")
    verify.add_argument("--state-file", type=Path, required=True)
    verify.add_argument("--snapshot-file", type=Path, required=True)

    publish = subparsers.add_parser("publish")
    publish.add_argument("--state-file", type=Path, required=True)
    publish.add_argument("--snapshot-file", type=Path, required=True)
    publish.add_argument("--candidate-file", type=Path, required=True)
    publish.add_argument("--gate-file", type=Path, required=True)
    publish.add_argument("--lease-file", action="append", type=Path, required=True)
    publish.add_argument("--owner-token", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "snapshot":
            result = capture_snapshot(args.state_file, args.snapshot_file)
            exit_code = 0
        elif args.command == "verify-unchanged":
            result = verify_unchanged(args.state_file, args.snapshot_file)
            exit_code = 0 if result["unchanged"] else 4
        else:
            result = publish_state(
                args.state_file,
                args.snapshot_file,
                args.candidate_file,
                args.gate_file,
                args.lease_file,
                args.owner_token,
            )
            exit_code = 0 if result["published"] else 5
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"status": "error", "error": str(exc)}
        exit_code = 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

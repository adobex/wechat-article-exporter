#!/usr/bin/env python3
"""Owner-token lease used to serialize long-running wechat2md automations."""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import socket
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


LEASE_VERSION = 1


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_timestamp(value: Any) -> datetime:
    timestamp = datetime.fromisoformat(str(value))
    if timestamp.tzinfo is None:
        raise ValueError("lease timestamp must include a timezone")
    return timestamp.astimezone(timezone.utc)


def guard_path_for(path: Path) -> Path:
    return path.with_name(f"{path.name}.guard")


@contextmanager
def lease_guard(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    guard_path = guard_path_for(path)
    with guard_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_create_json(path: Path, payload: dict[str, Any]) -> None:
    """Publish a fully written lease with an atomic create-if-absent link."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(tmp_path, path)
        except OSError as exc:
            if exc.errno == errno.EEXIST:
                raise FileExistsError(path) from exc
            raise
        fsync_directory(path.parent)
    finally:
        tmp_path.unlink(missing_ok=True)


def atomic_replace_json(path: Path, payload: dict[str, Any]) -> None:
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


def read_lease(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("lease root must be a JSON object")
    return raw


def lease_status(path: Path, *, now: datetime | None = None) -> dict[str, Any]:
    path = path.expanduser().resolve()
    current = (now or utc_now()).astimezone(timezone.utc)
    if not path.exists():
        return {
            "status": "available",
            "exists": False,
            "stale": False,
            "lease_file": str(path),
        }
    try:
        lease = read_lease(path)
        expires_at = parse_timestamp(lease.get("expires_at"))
        stale = current >= expires_at
        return {
            "status": "stale" if stale else "active",
            "exists": True,
            "stale": stale,
            "lease_file": str(path),
            "remaining_seconds": max(0.0, (expires_at - current).total_seconds()),
            "lease": lease,
        }
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "status": "invalid-stale",
            "exists": True,
            "stale": True,
            "lease_file": str(path),
            "error": str(exc),
        }


def acquire_lease(
    path: Path,
    *,
    owner_token: str,
    ttl_seconds: float,
    workflow_id: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    path = path.expanduser().resolve()
    owner_token = owner_token.strip()
    if not owner_token:
        raise ValueError("owner_token is required")
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be greater than zero")
    current = (now or utc_now()).astimezone(timezone.utc)

    with lease_guard(path):
        previous = lease_status(path, now=current)
        if previous["status"] == "active":
            lease = previous.get("lease") or {}
            if lease.get("owner_token") == owner_token:
                return {
                    "acquired": True,
                    "result": "already-owned",
                    "lease_file": str(path),
                    "lease": lease,
                }
            return {
                "acquired": False,
                "result": "busy",
                "lease_file": str(path),
                "lease": lease,
            }

        reclaimed = bool(previous.get("exists"))
        if reclaimed:
            path.unlink(missing_ok=True)
            fsync_directory(path.parent)
        payload = {
            "version": LEASE_VERSION,
            "workflow_id": workflow_id,
            "owner_token": owner_token,
            "acquired_at": current.isoformat(),
            "expires_at": (current + timedelta(seconds=ttl_seconds)).isoformat(),
            "ttl_seconds": ttl_seconds,
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
        }
        atomic_create_json(path, payload)
        return {
            "acquired": True,
            "result": "reclaimed-stale" if reclaimed else "acquired",
            "lease_file": str(path),
            "lease": payload,
            "previous": previous if reclaimed else None,
        }


def release_lease(path: Path, *, owner_token: str) -> dict[str, Any]:
    path = path.expanduser().resolve()
    owner_token = owner_token.strip()
    if not owner_token:
        raise ValueError("owner_token is required")
    with lease_guard(path):
        status = lease_status(path)
        if not status.get("exists"):
            return {"released": False, "result": "already-absent", "lease_file": str(path)}
        lease = status.get("lease") or {}
        if lease.get("owner_token") != owner_token:
            return {
                "released": False,
                "result": "owner-token-mismatch",
                "lease_file": str(path),
                "status": status["status"],
            }
        path.unlink()
        fsync_directory(path.parent)
        return {"released": True, "result": "released", "lease_file": str(path)}


def renew_lease(
    path: Path,
    *,
    owner_token: str,
    ttl_seconds: float | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    path = path.expanduser().resolve()
    owner_token = owner_token.strip()
    if not owner_token:
        raise ValueError("owner_token is required")
    current = (now or utc_now()).astimezone(timezone.utc)

    with lease_guard(path):
        status = lease_status(path, now=current)
        if not status.get("exists"):
            return {"renewed": False, "result": "already-absent", "lease_file": str(path)}
        lease = status.get("lease") or {}
        if lease.get("owner_token") != owner_token:
            return {
                "renewed": False,
                "result": "owner-token-mismatch",
                "lease_file": str(path),
                "status": status["status"],
            }
        if status["status"] != "active":
            return {
                "renewed": False,
                "result": "lease-expired",
                "lease_file": str(path),
                "status": status["status"],
            }

        renewed_ttl = float(ttl_seconds if ttl_seconds is not None else lease.get("ttl_seconds", 0))
        if renewed_ttl <= 0:
            raise ValueError("ttl_seconds must be greater than zero")
        payload = {
            **lease,
            "renewed_at": current.isoformat(),
            "expires_at": (current + timedelta(seconds=renewed_ttl)).isoformat(),
            "ttl_seconds": renewed_ttl,
        }
        atomic_replace_json(path, payload)
        return {
            "renewed": True,
            "result": "renewed",
            "lease_file": str(path),
            "lease": payload,
        }


def heartbeat_lease(
    path: Path,
    *,
    owner_token: str,
    ttl_seconds: float,
    interval_seconds: float,
    max_lifetime_seconds: float,
    quiet: bool = False,
    sleep: Any = time.sleep,
    monotonic: Any = time.monotonic,
) -> int:
    if interval_seconds <= 0 or interval_seconds >= ttl_seconds:
        raise ValueError("interval_seconds must be greater than zero and less than ttl_seconds")
    if max_lifetime_seconds <= 0:
        raise ValueError("max_lifetime_seconds must be greater than zero")
    started_at = monotonic()
    while True:
        if monotonic() - started_at >= max_lifetime_seconds:
            return 6
        result = renew_lease(path, owner_token=owner_token, ttl_seconds=ttl_seconds)
        if not quiet or not result["renewed"]:
            print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
        if not result["renewed"]:
            return 5
        sleep(interval_seconds)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Acquire, inspect, or release a wechat2md automation lease.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    acquire = subparsers.add_parser("acquire")
    acquire.add_argument("--lease-file", type=Path, required=True)
    acquire.add_argument("--workflow-id", required=True)
    acquire.add_argument("--owner-token", default="", help="Defaults to a generated UUID; retain it for release.")
    acquire.add_argument("--ttl-seconds", type=float, required=True)

    status = subparsers.add_parser("status")
    status.add_argument("--lease-file", type=Path, required=True)

    renew = subparsers.add_parser("renew")
    renew.add_argument("--lease-file", type=Path, required=True)
    renew.add_argument("--owner-token", required=True)
    renew.add_argument("--ttl-seconds", type=float)

    heartbeat = subparsers.add_parser("heartbeat")
    heartbeat.add_argument("--lease-file", type=Path, required=True)
    heartbeat.add_argument("--owner-token", required=True)
    heartbeat.add_argument("--ttl-seconds", type=float, required=True)
    heartbeat.add_argument("--interval-seconds", type=float, required=True)
    heartbeat.add_argument("--max-lifetime-seconds", type=float, default=43200)
    heartbeat.add_argument("--quiet", action="store_true")

    release = subparsers.add_parser("release")
    release.add_argument("--lease-file", type=Path, required=True)
    release.add_argument("--owner-token", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "acquire":
            result = acquire_lease(
                args.lease_file,
                owner_token=args.owner_token or str(uuid.uuid4()),
                ttl_seconds=args.ttl_seconds,
                workflow_id=args.workflow_id,
            )
            exit_code = 0 if result["acquired"] else 3
        elif args.command == "status":
            result = lease_status(args.lease_file)
            exit_code = 0
        elif args.command == "renew":
            result = renew_lease(
                args.lease_file,
                owner_token=args.owner_token,
                ttl_seconds=args.ttl_seconds,
            )
            exit_code = 0 if result["renewed"] else 4
        elif args.command == "heartbeat":
            try:
                return heartbeat_lease(
                    args.lease_file,
                    owner_token=args.owner_token,
                    ttl_seconds=args.ttl_seconds,
                    interval_seconds=args.interval_seconds,
                    max_lifetime_seconds=args.max_lifetime_seconds,
                    quiet=args.quiet,
                )
            except KeyboardInterrupt:
                return 130
        else:
            result = release_lease(args.lease_file, owner_token=args.owner_token)
            exit_code = 0 if result["result"] in {"released", "already-absent"} else 4
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"status": "error", "error": str(exc)}
        exit_code = 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

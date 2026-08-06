#!/usr/bin/env python3
"""Run one authenticated MP request under a shared, renewing rate-limit lease."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Sequence

from automation_lease import acquire_lease, release_lease, renew_lease


FREQUENCY_CONTROL_RET = 200013


def parse_backoff_seconds(value: str) -> list[float]:
    if not value.strip():
        return []
    values = [float(part.strip()) for part in value.split(",")]
    if any(seconds < 0 for seconds in values):
        raise ValueError("backoff seconds must be non-negative")
    return values


def validate_timing_contract(
    *,
    lease_ttl_seconds: float,
    request_timeout_seconds: float,
    cooldown_seconds: float,
    backoff_seconds: Sequence[float],
) -> None:
    if request_timeout_seconds <= 0:
        raise ValueError("request_timeout_seconds must be greater than zero")
    if cooldown_seconds < 0:
        raise ValueError("cooldown_seconds must be non-negative")
    longest_pause = max([cooldown_seconds, *backoff_seconds], default=cooldown_seconds)
    required_ttl = request_timeout_seconds + longest_pause + 5
    if lease_ttl_seconds <= required_ttl:
        raise ValueError(
            f"lease_ttl_seconds must exceed request timeout + longest pause + 5 seconds ({required_ttl})"
        )


def response_ret(stdout: str) -> int | None:
    try:
        payload = json.loads(stdout)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    base_resp = payload.get("base_resp")
    if not isinstance(base_resp, dict):
        return None
    try:
        return int(base_resp.get("ret"))
    except (TypeError, ValueError):
        return None


def acquire_with_wait(
    lease_file: Path,
    *,
    owner_token: str,
    workflow_id: str,
    lease_ttl_seconds: float,
    wait_timeout_seconds: float,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    deadline = monotonic() + wait_timeout_seconds
    while True:
        result = acquire_lease(
            lease_file,
            owner_token=owner_token,
            ttl_seconds=lease_ttl_seconds,
            workflow_id=workflow_id,
        )
        if result["acquired"]:
            return result
        remaining = deadline - monotonic()
        if remaining <= 0:
            return result
        sleep(min(0.5, remaining))


def run_gated_request(
    *,
    lease_file: Path,
    owner_token: str,
    workflow_id: str,
    lease_ttl_seconds: float,
    wait_timeout_seconds: float,
    request_timeout_seconds: float,
    cooldown_seconds: float,
    backoff_seconds: Sequence[float],
    command: Sequence[str],
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[int, str, str, dict[str, Any]]:
    validate_timing_contract(
        lease_ttl_seconds=lease_ttl_seconds,
        request_timeout_seconds=request_timeout_seconds,
        cooldown_seconds=cooldown_seconds,
        backoff_seconds=backoff_seconds,
    )
    if not command:
        raise ValueError("request command is required")

    acquired = acquire_with_wait(
        lease_file,
        owner_token=owner_token,
        workflow_id=workflow_id,
        lease_ttl_seconds=lease_ttl_seconds,
        wait_timeout_seconds=wait_timeout_seconds,
        sleep=sleep,
    )
    if not acquired["acquired"]:
        return 4, "", "API lease wait timeout", {"lease": acquired, "attempts": 0}

    attempts = 0
    last_completed: subprocess.CompletedProcess[str] | None = None
    outcome: tuple[int, str, str, dict[str, Any]] | None = None
    release_result: dict[str, Any] | None = None
    try:
        for attempt in range(len(backoff_seconds) + 1):
            renewed = renew_lease(
                lease_file,
                owner_token=owner_token,
                ttl_seconds=lease_ttl_seconds,
            )
            if not renewed["renewed"]:
                outcome = (
                    5,
                    "",
                    "API lease renewal failed before request",
                    {"lease": renewed, "attempts": attempts},
                )
                break

            attempts += 1
            try:
                completed = runner(
                    list(command),
                    capture_output=True,
                    text=True,
                    timeout=request_timeout_seconds,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                stdout = exc.stdout if isinstance(exc.stdout, str) else ""
                stderr = exc.stderr if isinstance(exc.stderr, str) else ""
                outcome = (124, stdout, stderr or "request command timed out", {"attempts": attempts})
                break
            last_completed = completed

            if response_ret(completed.stdout) != FREQUENCY_CONTROL_RET:
                renewed = renew_lease(
                    lease_file,
                    owner_token=owner_token,
                    ttl_seconds=lease_ttl_seconds,
                )
                if not renewed["renewed"]:
                    outcome = (
                        5,
                        completed.stdout,
                        "API lease renewal failed before cooldown",
                        {"lease": renewed, "attempts": attempts},
                    )
                    break
                sleep(cooldown_seconds)
                outcome = (
                    completed.returncode,
                    completed.stdout,
                    completed.stderr,
                    {"attempts": attempts, "frequency_control_retries": attempt},
                )
                break

            if attempt >= len(backoff_seconds):
                sleep(cooldown_seconds)
                outcome = (
                    6,
                    completed.stdout,
                    completed.stderr or "frequency control retries exhausted",
                    {"attempts": attempts, "frequency_control_retries": attempt},
                )
                break

            renewed = renew_lease(
                lease_file,
                owner_token=owner_token,
                ttl_seconds=lease_ttl_seconds,
            )
            if not renewed["renewed"]:
                outcome = (
                    5,
                    completed.stdout,
                    "API lease renewal failed before backoff",
                    {"lease": renewed, "attempts": attempts},
                )
                break
            sleep(backoff_seconds[attempt])
    finally:
        release_result = release_lease(lease_file, owner_token=owner_token)

    if outcome is None:
        stdout = last_completed.stdout if last_completed else ""
        stderr = last_completed.stderr if last_completed else "request did not run"
        outcome = (1, stdout, stderr, {"attempts": attempts})
    exit_code, stdout, stderr, metadata = outcome
    metadata = {**metadata, "release": release_result}
    if not release_result.get("released"):
        return 5, stdout, "API lease ownership was lost before release", metadata
    return exit_code, stdout, stderr, metadata


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run an MP API request under a shared rate-limit lease.")
    parser.add_argument("--lease-file", type=Path, required=True)
    parser.add_argument("--owner-token", required=True)
    parser.add_argument("--workflow-id", required=True)
    parser.add_argument("--lease-ttl-seconds", type=float, default=300)
    parser.add_argument("--wait-timeout-seconds", type=float, default=300)
    parser.add_argument("--request-timeout-seconds", type=float, default=30)
    parser.add_argument("--cooldown-seconds", type=float, default=2)
    parser.add_argument("--backoff-seconds", default="30,60,120")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    try:
        exit_code, stdout, stderr, metadata = run_gated_request(
            lease_file=args.lease_file,
            owner_token=args.owner_token,
            workflow_id=args.workflow_id,
            lease_ttl_seconds=args.lease_ttl_seconds,
            wait_timeout_seconds=args.wait_timeout_seconds,
            request_timeout_seconds=args.request_timeout_seconds,
            cooldown_seconds=args.cooldown_seconds,
            backoff_seconds=parse_backoff_seconds(args.backoff_seconds),
            command=command,
        )
    except (OSError, ValueError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2

    if stdout:
        sys.stdout.write(stdout)
    if stderr:
        sys.stderr.write(stderr)
    if exit_code != 0:
        print(json.dumps({"status": "request-failed", **metadata}, ensure_ascii=False), file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

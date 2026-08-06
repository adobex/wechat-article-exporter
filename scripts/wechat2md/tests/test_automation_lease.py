from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "automation_lease.py"


def load_module():
    spec = importlib.util.spec_from_file_location("automation_lease_test_module", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_acquire_status_owner_checked_release(tmp_path):
    module = load_module()
    lease = tmp_path / "shared.json"
    now = datetime(2026, 7, 10, tzinfo=timezone.utc)

    first = module.acquire_lease(
        lease,
        owner_token="owner-a",
        ttl_seconds=60,
        workflow_id="workflow-a",
        now=now,
    )
    second = module.acquire_lease(
        lease,
        owner_token="owner-b",
        ttl_seconds=60,
        workflow_id="workflow-b",
        now=now,
    )

    assert first["result"] == "acquired"
    assert second["result"] == "busy"
    assert module.lease_status(lease, now=now)["status"] == "active"
    assert module.release_lease(lease, owner_token="owner-b")["result"] == "owner-token-mismatch"
    assert lease.exists()
    assert module.release_lease(lease, owner_token="owner-a")["released"] is True
    assert module.lease_status(lease, now=now)["status"] == "available"


def test_stale_ttl_can_be_reclaimed_with_new_owner(tmp_path):
    module = load_module()
    lease = tmp_path / "shared.json"
    now = datetime(2026, 7, 10, tzinfo=timezone.utc)
    module.acquire_lease(
        lease,
        owner_token="owner-a",
        ttl_seconds=10,
        workflow_id="workflow-a",
        now=now,
    )

    reclaimed = module.acquire_lease(
        lease,
        owner_token="owner-b",
        ttl_seconds=30,
        workflow_id="workflow-b",
        now=now + timedelta(seconds=11),
    )

    assert reclaimed["result"] == "reclaimed-stale"
    assert reclaimed["lease"]["owner_token"] == "owner-b"
    assert module.release_lease(lease, owner_token="owner-a")["result"] == "owner-token-mismatch"
    assert module.release_lease(lease, owner_token="owner-b")["released"] is True


def test_same_owner_acquire_is_idempotent(tmp_path):
    module = load_module()
    lease = tmp_path / "shared.json"
    now = datetime(2026, 7, 10, tzinfo=timezone.utc)
    module.acquire_lease(
        lease,
        owner_token="owner-a",
        ttl_seconds=60,
        workflow_id="workflow-a",
        now=now,
    )

    again = module.acquire_lease(
        lease,
        owner_token="owner-a",
        ttl_seconds=60,
        workflow_id="workflow-a",
        now=now + timedelta(seconds=5),
    )

    assert again["result"] == "already-owned"


def test_owner_checked_renewal_extends_lease_beyond_original_ttl(tmp_path):
    module = load_module()
    lease = tmp_path / "account.json"
    now = datetime(2026, 8, 3, tzinfo=timezone.utc)
    module.acquire_lease(
        lease,
        owner_token="owner-a",
        ttl_seconds=60,
        workflow_id="workflow-a",
        now=now,
    )

    wrong_owner = module.renew_lease(
        lease,
        owner_token="owner-b",
        ttl_seconds=60,
        now=now + timedelta(seconds=30),
    )
    renewed = module.renew_lease(
        lease,
        owner_token="owner-a",
        ttl_seconds=60,
        now=now + timedelta(seconds=50),
    )

    assert wrong_owner["result"] == "owner-token-mismatch"
    assert renewed["result"] == "renewed"
    assert module.lease_status(lease, now=now + timedelta(seconds=100))["status"] == "active"
    assert module.lease_status(lease, now=now + timedelta(seconds=111))["status"] == "stale"


def test_expired_lease_cannot_be_renewed(tmp_path):
    module = load_module()
    lease = tmp_path / "account.json"
    now = datetime(2026, 8, 3, tzinfo=timezone.utc)
    module.acquire_lease(
        lease,
        owner_token="owner-a",
        ttl_seconds=10,
        workflow_id="workflow-a",
        now=now,
    )

    result = module.renew_lease(
        lease,
        owner_token="owner-a",
        ttl_seconds=10,
        now=now + timedelta(seconds=11),
    )

    assert result["result"] == "lease-expired"
    assert result["renewed"] is False


def test_heartbeat_stops_on_renewal_failure(tmp_path, monkeypatch):
    module = load_module()
    results = iter(
        [
            {"renewed": True, "result": "renewed"},
            {"renewed": False, "result": "owner-token-mismatch"},
        ]
    )
    monkeypatch.setattr(module, "renew_lease", lambda *args, **kwargs: next(results))

    exit_code = module.heartbeat_lease(
        tmp_path / "account.json",
        owner_token="owner-a",
        ttl_seconds=60,
        interval_seconds=10,
        max_lifetime_seconds=300,
        quiet=True,
        sleep=lambda seconds: None,
    )

    assert exit_code == 5


def test_heartbeat_has_a_bounded_maximum_lifetime(tmp_path, monkeypatch):
    module = load_module()
    monotonic_values = iter([0.0, 0.0, 61.0])
    monkeypatch.setattr(
        module,
        "renew_lease",
        lambda *args, **kwargs: {"renewed": True, "result": "renewed"},
    )

    exit_code = module.heartbeat_lease(
        tmp_path / "account.json",
        owner_token="owner-a",
        ttl_seconds=60,
        interval_seconds=10,
        max_lifetime_seconds=60,
        quiet=True,
        sleep=lambda seconds: None,
        monotonic=lambda: next(monotonic_values),
    )

    assert exit_code == 6

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "sync_state.py"


def load_module():
    spec = importlib.util.spec_from_file_location("sync_state_test_module", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path: Path, value: dict) -> bytes:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path.read_bytes()


def write_gate(path: Path, module, **overrides: bool) -> None:
    gate = {field: True for field in module.REQUIRED_GATE_FIELDS}
    gate.update(overrides)
    write_json(path, gate)


def candidate_state(timestamp: int) -> dict:
    return {
        "high_watermark_publish_timestamp": timestamp,
        "high_watermark_article_ids": [f"{timestamp}_1"],
        "last_successful_run_at": "2026-08-06T00:00:00+00:00",
        "last_integrity_audit_at": "2026-08-06T00:00:00+00:00",
        "last_integrity_audit_date_floor": "2020-01-01",
    }


def write_active_lease(path: Path, owner_token: str) -> None:
    write_json(
        path,
        {
            "owner_token": owner_token,
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        },
    )


@pytest.mark.parametrize(
    "failed_gate",
    [
        "complete_source_probe_succeeded",
        "manifest_and_downstream_succeeded",
        "lease_heartbeat_active",
        "post_write_verification_succeeded",
    ],
)
def test_failed_complete_or_downstream_gate_keeps_existing_state_byte_for_byte(tmp_path, failed_gate):
    module = load_module()
    state = tmp_path / "state.json"
    snapshot = tmp_path / "snapshot.json"
    candidate = tmp_path / "candidate.json"
    gate = tmp_path / "gate.json"
    original = write_json(state, {"high_watermark_publish_timestamp": 10, "marker": "old"})
    write_json(candidate, candidate_state(20))
    write_gate(gate, module, **{failed_gate: False})
    module.capture_snapshot(state, snapshot)

    result = module.publish_state(state, snapshot, candidate, gate, [], "")

    assert result["published"] is False
    assert result["result"] == "gate-failed"
    assert failed_gate in result["failed_gates"]
    assert state.read_bytes() == original
    assert module.verify_unchanged(state, snapshot)["unchanged"] is True


def test_migration_conflict_without_complete_audit_does_not_create_canonical_state(tmp_path):
    module = load_module()
    state = tmp_path / "canonical.json"
    snapshot = tmp_path / "snapshot.json"
    candidate = tmp_path / "candidate.json"
    gate = tmp_path / "gate.json"
    write_json(candidate, candidate_state(20))
    write_gate(
        gate,
        module,
        required_integrity_audit_completed=False,
        state_migration_safe=False,
    )
    module.capture_snapshot(state, snapshot)

    result = module.publish_state(state, snapshot, candidate, gate, [], "")

    assert result["published"] is False
    assert set(result["failed_gates"]) >= {
        "required_integrity_audit_completed",
        "state_migration_safe",
    }
    assert not state.exists()
    assert module.verify_unchanged(state, snapshot)["unchanged"] is True


def test_all_gates_publish_candidate_atomically(tmp_path):
    module = load_module()
    state = tmp_path / "state.json"
    snapshot = tmp_path / "snapshot.json"
    candidate = tmp_path / "candidate.json"
    gate = tmp_path / "gate.json"
    legacy_lease = tmp_path / "legacy-lease.json"
    canonical_lease = tmp_path / "canonical-lease.json"
    owner_token = "owner-a"
    write_json(state, {"high_watermark_publish_timestamp": 10})
    expected = candidate_state(20)
    write_json(candidate, expected)
    write_gate(gate, module)
    write_active_lease(legacy_lease, owner_token)
    write_active_lease(canonical_lease, owner_token)
    module.capture_snapshot(state, snapshot)

    result = module.publish_state(
        state,
        snapshot,
        candidate,
        gate,
        [legacy_lease, canonical_lease],
        owner_token,
    )

    assert result["published"] is True
    assert json.loads(state.read_text(encoding="utf-8")) == expected
    assert not list(tmp_path.glob(".state.json.*.tmp"))


def test_concurrent_state_change_after_snapshot_blocks_publish(tmp_path):
    module = load_module()
    state = tmp_path / "state.json"
    snapshot = tmp_path / "snapshot.json"
    candidate = tmp_path / "candidate.json"
    gate = tmp_path / "gate.json"
    lease = tmp_path / "lease.json"
    write_json(state, {"high_watermark_publish_timestamp": 10})
    write_json(candidate, candidate_state(20))
    write_gate(gate, module)
    write_active_lease(lease, "owner-a")
    module.capture_snapshot(state, snapshot)
    concurrent = write_json(state, {"high_watermark_publish_timestamp": 15})

    result = module.publish_state(state, snapshot, candidate, gate, [lease], "owner-a")

    assert result["published"] is False
    assert result["result"] == "state-changed"
    assert state.read_bytes() == concurrent


def test_gate_true_but_lease_owner_mismatch_keeps_state_unchanged(tmp_path):
    module = load_module()
    state = tmp_path / "state.json"
    snapshot = tmp_path / "snapshot.json"
    candidate = tmp_path / "candidate.json"
    gate = tmp_path / "gate.json"
    lease = tmp_path / "lease.json"
    original = write_json(state, candidate_state(10))
    write_json(candidate, candidate_state(20))
    write_gate(gate, module)
    write_active_lease(lease, "other-owner")
    module.capture_snapshot(state, snapshot)

    result = module.publish_state(state, snapshot, candidate, gate, [lease], "owner-a")

    assert result["published"] is False
    assert result["result"] == "lease-check-failed"
    assert result["lease_check"]["failures"][0]["reason"] == "owner-token-mismatch"
    assert state.read_bytes() == original

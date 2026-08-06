from __future__ import annotations

import importlib.util
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "run_artifact.py"


def load_module():
    spec = importlib.util.spec_from_file_location("run_artifact_test_module", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_reservation_uses_full_uuid_and_is_idempotent(tmp_path):
    module = load_module()
    owner_token = "11111111-2222-4333-8444-555555555555"
    now = datetime(2026, 8, 3, 4, 5, 6, tzinfo=timezone.utc)

    first = module.reserve_run_directory(
        tmp_path,
        workflow_id="indienova-steam-incremental",
        owner_token=owner_token,
        now=now,
    )
    second = module.reserve_run_directory(
        tmp_path,
        workflow_id="indienova-steam-incremental",
        owner_token=owner_token,
        now=now,
    )

    assert first["result"] == "reserved"
    assert second["result"] == "already-reserved"
    assert owner_token in first["run_id"]
    assert first["run_dir"] == second["run_dir"]
    assert Path(first["manifest_path"]).name == "files.json"


def test_conflicting_directory_retries_with_an_atomic_unique_reservation(tmp_path):
    module = load_module()
    owner_token = "11111111-2222-4333-8444-555555555555"
    now = datetime(2026, 8, 3, 4, 5, 6, tzinfo=timezone.utc)
    workflow_root = tmp_path / "indienova-steam-incremental"
    conflicting = workflow_root / f"20260803T040506Z-{owner_token}"
    conflicting.mkdir(parents=True)
    (conflicting / "run.json").write_text(
        json.dumps({"workflow_id": "other", "owner_token": str(uuid.uuid4())}),
        encoding="utf-8",
    )
    retry_uuid = uuid.UUID("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")

    result = module.reserve_run_directory(
        tmp_path,
        workflow_id="indienova-steam-incremental",
        owner_token=owner_token,
        now=now,
        collision_uuid_factory=lambda: retry_uuid,
    )

    assert result["result"] == "reserved"
    assert result["run_id"].endswith(f"{owner_token}-{retry_uuid}")
    assert Path(result["run_dir"]).is_dir()
    assert json.loads((Path(result["run_dir"]) / "run.json").read_text(encoding="utf-8"))["run_id"] == result["run_id"]

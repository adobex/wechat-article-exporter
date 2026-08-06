from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import uuid
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "mp_api_request.py"


def load_module():
    spec = importlib.util.spec_from_file_location("mp_api_request_test_module", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(SCRIPT.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


def cli_command(lease_file: Path, timestamps: Path, *, owner_token: str, cooldown: float) -> list[str]:
    request_code = (
        "import json,sys,time; "
        "p=open(sys.argv[1],'a',encoding='utf-8'); "
        "p.write(str(time.time_ns())+'\\n'); p.close(); "
        "print(json.dumps({'base_resp':{'ret':0}}))"
    )
    return [
        sys.executable,
        str(SCRIPT),
        "--lease-file",
        str(lease_file),
        "--owner-token",
        owner_token,
        "--workflow-id",
        f"test-{owner_token[:8]}",
        "--lease-ttl-seconds",
        "10",
        "--wait-timeout-seconds",
        "5",
        "--request-timeout-seconds",
        "2",
        "--cooldown-seconds",
        str(cooldown),
        "--backoff-seconds",
        "",
        "--",
        sys.executable,
        "-c",
        request_code,
        str(timestamps),
    ]


def test_two_workers_are_serialized_through_post_response_cooldown(tmp_path):
    lease_file = tmp_path / "api.json"
    timestamps = tmp_path / "timestamps.txt"
    cooldown = 0.4
    first = subprocess.Popen(
        cli_command(lease_file, timestamps, owner_token=str(uuid.uuid4()), cooldown=cooldown),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    second = subprocess.Popen(
        cli_command(lease_file, timestamps, owner_token=str(uuid.uuid4()), cooldown=cooldown),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    first_stdout, first_stderr = first.communicate(timeout=10)
    second_stdout, second_stderr = second.communicate(timeout=10)

    assert first.returncode == 0, first_stderr
    assert second.returncode == 0, second_stderr
    assert json.loads(first_stdout)["base_resp"]["ret"] == 0
    assert json.loads(second_stdout)["base_resp"]["ret"] == 0
    request_times = sorted(int(value) for value in timestamps.read_text(encoding="utf-8").splitlines())
    assert len(request_times) == 2
    assert request_times[1] - request_times[0] >= cooldown * 0.8 * 1_000_000_000


def test_frequency_control_retries_renew_and_keep_other_owner_busy(tmp_path, monkeypatch):
    module = load_module()
    lease_file = tmp_path / "api.json"
    owner_token = str(uuid.uuid4())
    other_owner = str(uuid.uuid4())
    responses = iter([module.FREQUENCY_CONTROL_RET] * 3 + [0])
    renewals = 0
    other_results: list[str] = []
    real_renew = module.renew_lease

    def tracked_renew(*args, **kwargs):
        nonlocal renewals
        renewals += 1
        return real_renew(*args, **kwargs)

    def fake_runner(*args, **kwargs):
        ret = next(responses)
        return subprocess.CompletedProcess([], 0, json.dumps({"base_resp": {"ret": ret}}), "")

    def fake_sleep(seconds):
        if seconds in {0.01, 0.02, 0.03}:
            result = module.acquire_lease(
                lease_file,
                owner_token=other_owner,
                ttl_seconds=10,
                workflow_id="other",
            )
            other_results.append(result["result"])

    monkeypatch.setattr(module, "renew_lease", tracked_renew)
    exit_code, stdout, stderr, metadata = module.run_gated_request(
        lease_file=lease_file,
        owner_token=owner_token,
        workflow_id="test-retry",
        lease_ttl_seconds=10,
        wait_timeout_seconds=1,
        request_timeout_seconds=1,
        cooldown_seconds=0,
        backoff_seconds=[0.01, 0.02, 0.03],
        command=["fake"],
        runner=fake_runner,
        sleep=fake_sleep,
    )

    assert exit_code == 0, stderr
    assert json.loads(stdout)["base_resp"]["ret"] == 0
    assert metadata["attempts"] == 4
    assert renewals >= 8
    assert other_results == ["busy", "busy", "busy"]
    assert not lease_file.exists()


def test_timing_contract_rejects_ttl_that_cannot_cover_one_request_pause():
    module = load_module()
    with pytest.raises(ValueError, match="lease_ttl_seconds must exceed"):
        module.validate_timing_contract(
            lease_ttl_seconds=150,
            request_timeout_seconds=30,
            cooldown_seconds=2,
            backoff_seconds=[30, 60, 120],
        )

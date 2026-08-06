from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "validate_scheduled_automations.py"
REPO_ROOT = SCRIPT.parents[2]


def load_module():
    spec = importlib.util.spec_from_file_location("scheduled_automation_validator_test_module", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def valid_prompt(workflow_name: str) -> str:
    return " ".join(
        [
            "secondary_window.reset_at_shanghai",
            "当前 YAML 是执行细节唯一正本",
            f"/Users/adobe/Project/tools/wechat-article-exporter/scripts/wechat2md/workflows/{workflow_name}",
            "wechat-account-visible-recovery.yaml",
            "acquire-set",
            "先本地稳定身份对齐",
            "普通 Chrome 微信读书可见目录",
            "有界公开索引作为独立补充",
            "认证接口只作末位探针",
            "不得让浏览器导航隐藏/私有列表接口",
            "此禁令不禁止受控末位探针",
            "localhost:3000",
        ]
    )


def write_automation(root: Path, automation_id: str, workflow_name: str, prompt: str | None = None) -> None:
    directory = root / automation_id
    directory.mkdir(parents=True)
    content = "\n".join(
        [
            "version = 1",
            f'id = "{automation_id}"',
            'kind = "cron"',
            'name = "test"',
            f"prompt = {valid_prompt(workflow_name) if prompt is None else prompt!r}",
            'status = "ACTIVE"',
            'rrule = "DTSTART;TZID=Asia/Shanghai:20260801T220000\\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1"',
        ]
    )
    (directory / "automation.toml").write_text(content + "\n", encoding="utf-8")


def test_validator_accepts_current_cross_contract_with_fixture_automations(tmp_path):
    module = load_module()
    for automation_id, workflow_name in module.AUTOMATIONS.items():
        write_automation(tmp_path, automation_id, workflow_name)

    assert module.validate(tmp_path, REPO_ROOT) == []


def test_validator_rejects_prompt_that_drops_migration_bridge(tmp_path):
    module = load_module()
    for automation_id, workflow_name in module.AUTOMATIONS.items():
        prompt = valid_prompt(workflow_name)
        if automation_id == "indienova-steam-articles-before-usage-reset":
            prompt = prompt.replace("acquire-set", "legacy status check")
        write_automation(tmp_path, automation_id, workflow_name, prompt)

    errors = module.validate(tmp_path, REPO_ROOT)

    assert any("missing prompt marker 'acquire-set'" in error for error in errors)

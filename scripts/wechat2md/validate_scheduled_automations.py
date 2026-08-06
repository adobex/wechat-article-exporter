#!/usr/bin/env python3
"""Validate scheduled WeChat automation prompts against repository contracts."""

from __future__ import annotations

import argparse
import json
import os
import tomllib
from pathlib import Path


AUTOMATIONS = {
    "wechat-product-accounts-before-usage-reset": "wechat-product-accounts-incremental.yaml",
    "indienova-steam-articles-before-usage-reset": "indienova-steam-incremental.yaml",
}
COMMON_PROMPT_MARKERS = (
    "secondary_window.reset_at_shanghai",
    "当前 YAML 是执行细节唯一正本",
    "wechat-account-visible-recovery.yaml",
    "acquire-set",
    "先本地稳定身份对齐",
    "普通 Chrome 微信读书可见目录",
    "有界公开索引作为独立补充",
    "末位",
    "不得让浏览器导航隐藏/私有列表接口",
    "此禁令不禁止",
    "localhost:3000",
)
FORBIDDEN_PROMPT_MARKERS = (
    "canonical/legacy lease busy 检查",
    "仅作微信读书非人工阻塞失败后的降级补充",
)
EXPECTED_SOURCE_ORDERS = {
    "wechat-product-accounts-incremental.yaml": (
        "local_canonical_export_reconciliation",
        "weread_chrome_fallback",
        "public_index_fallback",
        "authenticated_complete_source_probe",
    ),
    "indienova-steam-incremental.yaml": (
        "local_canonical_export_reconciliation",
        "normal_chrome_visible_weread",
        "public_index_fallback",
        "authenticated_complete_source_probe",
    ),
}


def load_automation(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def validate_automation(data: dict, *, automation_id: str, workflow_name: str) -> list[str]:
    errors: list[str] = []
    prompt = data.get("prompt")
    if data.get("id") != automation_id:
        errors.append(f"{automation_id}: id mismatch")
    if data.get("status") != "ACTIVE":
        errors.append(f"{automation_id}: status must be ACTIVE")
    rrule = data.get("rrule")
    if not isinstance(rrule, str) or "TZID=Asia/Shanghai" not in rrule:
        errors.append(f"{automation_id}: schedule must use Asia/Shanghai")
    if not isinstance(prompt, str):
        return [*errors, f"{automation_id}: prompt must be a string"]
    workflow_path = f"/scripts/wechat2md/workflows/{workflow_name}"
    if workflow_path not in prompt:
        errors.append(f"{automation_id}: missing canonical workflow path")
    for marker in COMMON_PROMPT_MARKERS:
        if marker not in prompt:
            errors.append(f"{automation_id}: missing prompt marker {marker!r}")
    for marker in FORBIDDEN_PROMPT_MARKERS:
        if marker in prompt:
            errors.append(f"{automation_id}: stale prompt marker {marker!r}")
    return errors


def validate_repository_contracts(repo_root: Path) -> list[str]:
    errors: list[str] = []
    workflows = repo_root / "scripts" / "wechat2md" / "workflows"
    for workflow_name, expected_order in EXPECTED_SOURCE_ORDERS.items():
        text = (workflows / workflow_name).read_text(encoding="utf-8")
        positions = [text.find(marker) for marker in expected_order]
        if any(position < 0 for position in positions) or positions != sorted(positions):
            errors.append(f"{workflow_name}: source order is missing or stale")
        for marker in ("acquire-set", "sync_state.py publish", "state_migration_safe"):
            if marker not in text:
                errors.append(f"{workflow_name}: missing repository marker {marker!r}")

    readme = (repo_root / "scripts" / "wechat2md" / "README.md").read_text(encoding="utf-8")
    capabilities = (repo_root / "AGENT_CAPABILITIES.yaml").read_text(encoding="utf-8")
    for marker in ("微信读书成功后仍作为独立有界补充", "受 API lease 约束的认证完整性末位探针"):
        if marker not in readme:
            errors.append(f"README.md: missing marker {marker!r}")
    for marker in ("acquire-set", "成功后仍运行有界公开索引作独立补充", "该禁令不阻止"):
        if marker not in capabilities:
            errors.append(f"AGENT_CAPABILITIES.yaml: missing marker {marker!r}")
    return errors


def validate(automation_root: Path, repo_root: Path) -> list[str]:
    errors = validate_repository_contracts(repo_root)
    for automation_id, workflow_name in AUTOMATIONS.items():
        path = automation_root / automation_id / "automation.toml"
        if not path.is_file():
            errors.append(f"{automation_id}: automation.toml is missing")
            continue
        try:
            data = load_automation(path)
        except (OSError, tomllib.TOMLDecodeError) as exc:
            errors.append(f"{automation_id}: cannot parse automation.toml: {exc}")
            continue
        errors.extend(
            validate_automation(data, automation_id=automation_id, workflow_name=workflow_name)
        )
    return errors


def build_parser() -> argparse.ArgumentParser:
    default_codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    default_repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--automation-root", type=Path, default=default_codex_home / "automations")
    parser.add_argument("--repo-root", type=Path, default=default_repo_root)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    errors = validate(args.automation_root.expanduser().resolve(), args.repo_root.expanduser().resolve())
    result = {"valid": not errors, "error_count": len(errors), "errors": errors}
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())

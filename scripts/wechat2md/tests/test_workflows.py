from __future__ import annotations

import hashlib
import importlib.util
import shlex
from pathlib import Path

import yaml


WORKFLOWS = Path(__file__).resolve().parents[1] / "workflows"
README = WORKFLOWS.parent / "README.md"


def load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def test_workflows_use_account_scoped_leases_and_a_short_shared_service_startup_lease():
    steam = load("indienova-steam-incremental.yaml")
    products = load("wechat-product-accounts-incremental.yaml")

    steam_account_lease = steam["account_lease"]
    product_account_leases = products["account_leases"]
    product_lease_files = {account["lease_file"] for account in products["accounts"]}
    product_legacy_lease_files = {account["legacy_lease_file"] for account in products["accounts"]}

    assert steam_account_lease["lease_file"] not in product_lease_files
    assert len(product_lease_files) == len(products["accounts"])
    assert len(product_legacy_lease_files) == len(products["accounts"])
    assert product_lease_files.isdisjoint(product_legacy_lease_files)
    assert all("/leases/accounts/" in path for path in product_lease_files)
    assert "other account workflows remain independent" in steam_account_lease["busy_policy"]
    assert "continue with other accounts" in product_account_leases["busy_policy"]
    assert "acquire-set" in steam_account_lease["acquire_command"]
    assert "acquire-set" in product_account_leases["acquire_command"]
    assert "heartbeat-set" in steam_account_lease["heartbeat_command"]
    assert "heartbeat-set" in product_account_leases["heartbeat_command"]
    assert "release-set" in steam_account_lease["release_command"]
    assert "release-set" in product_account_leases["release_command"]
    assert steam_account_lease["migration_bridge_order"] == ["legacy_lease_file", "lease_file"]
    assert product_account_leases["migration_bridge_order"] == [
        "account.legacy_lease_file",
        "account.lease_file",
    ]
    assert "stop before further download" in steam_account_lease["heartbeat_policy"]
    assert "stop before further download" in product_account_leases["heartbeat_policy"]
    assert "finally" in steam_account_lease["finally_release"]
    assert "finally" in product_account_leases["finally_release"]
    assert "old executor cannot enter" in steam_account_lease["migration_bridge_rule"]

    assert steam["service_startup_lease"]["lease_file"] == products["service_startup_lease"]["lease_file"]
    for workflow in (steam, products):
        startup = workflow["service_startup_lease"]
        assert startup["ttl_seconds"] <= 180
        assert "never hold this lease during" in startup["scope"]
        assert "do not stop it automatically" in startup["shutdown_policy"]
        assert "never kill, replace, or reuse" in startup["incompatible_listener_policy"]
        assert "/api/local/wechat2md/credentials" in workflow["service"]["healthcheck_command"]
        assert workflow["service"]["required_output_root"] in workflow["service"]["healthcheck_command"]
        assert "HTTP 200" in workflow["service"]["readiness_contract"]
        assert "exactly equal" in workflow["service"]["readiness_contract"]
        assert "service_compatibility_result" in workflow["report"]["required_fields"]

    assert steam["authenticated_api_lease"]["lease_file"] == products["authenticated_api_lease"]["lease_file"]
    for workflow in (steam, products):
        api_lease = workflow["authenticated_api_lease"]
        assert "only authenticated" in api_lease["scope"]
        assert api_lease["request_helper"].endswith("mp_api_request.py")
        assert api_lease["post_response_cooldown_seconds"] == 2
        assert api_lease["local_proxy_timeout_seconds"] < api_lease["request_timeout_seconds"]
        assert "abort" in api_lease["timeout_policy"]
        assert "full 2-second post-response cooldown" in api_lease["request_policy"]
        assert "renews before every request" in api_lease["frequency_control_policy"]
        assert api_lease["ttl_seconds"] > (
            api_lease["request_timeout_seconds"] + max(api_lease["backoff_seconds"]) + 5
        )
        assert "never hold this lease" in api_lease["scope"]

    assert steam["steam_import"]["write_lock"].endswith("steam-indienova.lock")
    assert "only for --confirm" in steam["steam_import"]["write_lock_scope"]
    assert "writer lock" in products["concurrency"]["import_policy"]


def test_workflows_use_unique_run_ids_for_concurrent_artifacts():
    steam = load("indienova-steam-incremental.yaml")
    products = load("wechat-product-accounts-incremental.yaml")

    for workflow in (steam, products):
        identity = workflow["run_identity"]
        assert "full UUID" in identity["owner_token_rule"]
        assert "run_artifact.py" in identity["reserve_command"]
        assert "atomically reserved" in identity["rule"]
        assert "<run_id>" in workflow["file_manifest"]["run_dir"]
        assert workflow["file_manifest"]["name"] == "files.json"

    for path in products["product_distillation"]["analysis_outputs"]:
        assert "<run_id>" in path


def test_workflows_use_dynamic_bounded_high_watermark_and_date_floor_audit():
    expected_floors = {
        "indienova-steam-incremental.yaml": "2020-01-01",
        "wechat-product-accounts-incremental.yaml": "2025-01-01",
    }
    for name, date_floor in expected_floors.items():
        workflow = load(name)
        scan = workflow["article_scan"]
        overlap = scan["bounded_overlap"]
        assert scan["default_strategy"] == "persistent_high_watermark_with_bounded_overlap"
        assert overlap["minimum_calendar_overlap_days"] < overlap["maximum_calendar_overlap_days"]
        assert "days_since_last_success" in overlap["dynamic_window_rule"]
        assert scan["integrity_audit"]["interval_days"] == 30
        assert scan["publish_date_min"] == date_floor
        assert "publish_date_min" in scan["integrity_audit"]["scan_rule"]


def test_workflows_document_staging_cleanup_and_state_atomicity():
    for name in ("indienova-steam-incremental.yaml", "wechat-product-accounts-incremental.yaml"):
        workflow = load(name)
        cleanup = workflow["staging_cleanup"]
        assert "run_id" in cleanup["scope"]
        assert "Never glob-delete another run" in cleanup["stale_rule"]
        assert "finally" in cleanup["finally_rule"]
        state = workflow["sync_state"]
        assert state["helper"].endswith("sync_state.py")
        assert "sync_state.py snapshot" in state["snapshot_command"]
        assert "sync_state.py publish" in state["publish_command"]
        assert state["publish_command"].count("--lease-file") == 2
        assert "--owner-token" in state["publish_command"]
        assert "sync_state.py verify-unchanged" in state["failure_verification_command"]
        assert "atomically replace" in state["persistence"]
        assert set(state["gate_schema"]) == {
            "complete_source_probe_succeeded",
            "required_integrity_audit_completed",
            "manifest_and_downstream_succeeded",
            "lease_heartbeat_active",
            "post_write_verification_succeeded",
            "state_migration_safe",
        }
        assert "literal true" in state["commit_gate"]
        assert "unchanged=true" in state["failure_verification"]


def test_workflows_store_state_in_one_file_per_account_with_legacy_read_fallback():
    steam = load("indienova-steam-incremental.yaml")
    products = load("wechat-product-accounts-incremental.yaml")

    steam_resource_key = f"wechat-account-{hashlib.sha256(steam['account']['stable_biz'].encode()).hexdigest()[:20]}"
    assert steam["sync_state"]["scope"] == "one_file_per_account"
    assert steam["account"]["resource_key"] == steam_resource_key
    assert steam["sync_state"]["path"].endswith(f"/accounts/{steam_resource_key}.json")
    assert steam["account_lease"]["lease_file"].endswith(f"/accounts/{steam_resource_key}.json")
    assert steam["sync_state"]["legacy_account_read_fallback"].endswith("/accounts/indienova.json")
    assert steam["sync_state"]["legacy_read_fallback"].endswith("indienova-steam-incremental.json")
    assert steam["account_lease"]["legacy_lease_file"].endswith("/accounts/indienova.json")
    assert "acquire-set" in steam["account_lease"]["acquire_command"]
    assert "valid candidates conflict" in steam["sync_state"]["migration"]
    assert "exact SHA256" in steam["sync_state"]["pre_run_snapshot"]

    assert products["sync_state"]["scope"] == "one_file_per_account"
    state_paths = {account["state_path"] for account in products["accounts"]}
    assert len(state_paths) == len(products["accounts"])
    assert all("/wechat2md-state/accounts/" in path for path in state_paths)
    assert products["sync_state"]["legacy_read_fallback"].endswith("wechat-product-accounts-incremental.json")
    for account in products["accounts"]:
        resource_key = f"wechat-account-{hashlib.sha256(account['stable_biz'].encode()).hexdigest()[:20]}"
        assert account["state_key"] == resource_key
        assert account["state_path"].endswith(f"/{resource_key}.json")
        assert account["lease_file"].endswith(f"/{resource_key}.json")
        assert account["legacy_lease_file"] != account["lease_file"]
        assert account["legacy_state_path"] != account["state_path"]
    assert "account.legacy_state_path" in products["sync_state"]["migration"]
    assert "valid candidates conflict" in products["sync_state"]["migration"]
    assert "exact SHA256" in products["sync_state"]["pre_run_snapshot"]


def test_steam_formal_import_requires_confirm_and_product_import_uses_receipt():
    steam = load("indienova-steam-incremental.yaml")
    products = load("wechat-product-accounts-incremental.yaml")

    assert "--confirm" in steam["steam_import"]["formal_args"]
    commands = products["product_distillation"]["import_commands"]
    assert all("--data-json" in command and "--receipt-json" in command for command in commands)
    assert "--dry-run" in commands[0]
    assert "--confirm" in commands[1]


def test_product_workflow_uses_controlled_authenticated_and_public_frequency_fallbacks():
    products = load("wechat-product-accounts-incremental.yaml")
    fallback = products["article_scan"]["profile_ext_fallback"]
    weread_fallback = products["article_scan"]["weread_chrome_fallback"]
    public_fallback = products["article_scan"]["public_index_fallback"]
    mirror_recovery = products["article_scan"]["trusted_public_mirror_recovery"]
    credential_cache = products["auth"]["profile_credential_cache"]
    source_priority = products["article_scan"]["source_priority"]

    assert source_priority["routine_order"][0] == "local_canonical_export_reconciliation"
    assert source_priority["routine_order"][1] == "weread_chrome_fallback"
    assert source_priority["routine_order"][2] == "public_index_fallback"
    assert source_priority["routine_order"][3] == "authenticated_complete_source_probe"
    assert "account.stable_biz" in source_priority["complete_probe_identity"]
    assert "Do not call searchbiz" in source_priority["complete_probe_identity"]
    assert "generic_account_recovery.canonical_entry" in source_priority["dashboard_rule"]
    assert "continues bounded public discovery" in source_priority["dashboard_rule"]
    assert "only afterward" in source_priority["dashboard_rule"]
    assert "final completeness probes" in source_priority["complete_source_probe"]
    assert "after the preferred acquisition" in source_priority["complete_source_probe"]
    assert "final complete-source probe" in fallback["trigger"]
    assert "Never loop back" in fallback["unavailable_policy"]
    assert products["generic_account_recovery"]["canonical_entry"].endswith(
        "wechat-account-visible-recovery.yaml"
    )
    assert "concrete input" in products["generic_account_recovery"]["relationship"]
    assert products["auth"]["mode"] == "normal_chrome_visible_recovery_with_final_authenticated_probe"
    assert "searchbiz" not in products["authenticated_api_lease"]["scope"]

    assert products["article_scan"]["complete_probe_endpoint"] == "/api/web/mp/appmsgpublish"
    assert "primary_endpoint" not in products["article_scan"]
    assert "complete-source probe" in fallback["trigger"]
    assert fallback["endpoint"] == "/api/local/wechat2md/article-list"
    assert "authenticated_api_lease" in fallback["request_policy"]
    assert "same high-watermark" in fallback["pagination"]
    assert fallback["maximum_pages_per_account"] > 0
    assert "repeated offset" in fallback["progress_guard"]
    assert "repeated page signature" in fallback["progress_guard"]
    assert "preserve the previous per-account sync state" in fallback["progress_failure_policy"]
    assert "retain already verified partial-source downloads" in fallback["unavailable_policy"]
    assert "preserve the previous per-account sync state" in fallback["unavailable_policy"]
    assert credential_cache["storage"] == "process_memory_only"
    assert credential_cache["maximum_age_minutes"] == 25
    assert "never returned" in credential_cache["secret_exposure"]

    assert "weread_reader_url.mjs" in weread_fallback["reader_url_helper"]
    assert "default discovery and acquisition source" in weread_fallback["trigger"]
    assert "already-open, signed-in normal Google Chrome" in weread_fallback["browser_policy"]
    assert "Do not launch a dedicated profile or another browser" in weread_fallback["browser_policy"]
    assert "PC WeChat client" in weread_fallback["browser_policy"]
    assert "system proxy" in weread_fallback["browser_policy"]
    assert "trusted certificate" in weread_fallback["browser_policy"]
    assert "normal Chrome is unavailable" in weread_fallback["login_policy"]
    assert "rendered reader heading" in weread_fallback["identity_policy"]
    assert "visible directory control" in weread_fallback["directory_scan"]
    assert "/web/mp/articles" in weread_fallback["directory_scan"]
    assert "first rendered batch is not complete coverage" in weread_fallback["lazy_load_guard"]
    assert "directoryEntriesLoaded" in weread_fallback["catalog_snapshot"]
    assert "weread_catalog_audit.mjs" in weread_fallback["reconciliation_command"]
    assert "missing=0" in weread_fallback["reconciliation_policy"]
    assert "--apply-date-repairs true" in weread_fallback["metadata_repair_policy"]
    assert "--apply-url-repairs true" in weread_fallback["metadata_repair_policy"]
    assert "urlIdentityMismatches=0" in weread_fallback["metadata_repair_policy"]
    assert "second time" in weread_fallback["dashboard_reconciliation"]
    assert "对齐本地导出" in weread_fallback["dashboard_reconciliation"]
    assert "stable biz" in weread_fallback["dashboard_reconciliation"]
    assert "never changes" in weread_fallback["dashboard_state_policy"]
    assert "Asia/Shanghai" in weread_fallback["date_normalization"]
    assert "full date rendered inside the opened article" in weread_fallback["date_normalization"]
    assert "main article iframe srcdoc" in weread_fallback["article_extraction"]
    assert "meta og:url" in weread_fallback["article_extraction"]
    assert weread_fallback["maximum_directory_entries_per_account"] == 500
    assert weread_fallback["interaction_interval_seconds"] == 1
    assert weread_fallback["coverage"] == "partial"
    assert "never complete an integrity audit or advance high-watermark" in weread_fallback["state_policy"]
    assert "expectedBiz=account.stable_biz" in weread_fallback["download_identity"]
    assert "mode=lite" in weread_fallback["download_identity"]
    assert "imageMode=cdn" in weread_fallback["download_identity"]

    assert public_fallback["endpoint"] == "/api/local/public-article-discovery"
    assert "before any authenticated complete-source probe" in public_fallback["trigger"]
    assert "after successful weread_chrome_fallback" in public_fallback["trigger"]
    assert public_fallback["coverage"] == "partial"
    assert "15-second per-request timeout" in public_fallback["request_policy"]
    assert "at most 10 pages" in public_fallback["query_bounds"]
    assert "at most 300" in public_fallback["query_bounds"]
    assert "unexpected pages" in public_fallback["result_page_policy"]
    assert "expected stable biz" in public_fallback["verification"]
    assert "canonicalUrl" in public_fallback["identity_policy"]
    assert "never satisfy" in public_fallback["state_policy"]
    assert "preserve the previous per-account state" in public_fallback["state_policy"].lower()
    assert "never claim complete history" in public_fallback["zero_result_policy"]
    assert "repeat the primary query's first page once" in public_fallback["zero_result_policy"]
    assert mirror_recovery["discovery_endpoint"] == "/api/local/public-mirror-discovery"
    assert mirror_recovery["download_endpoint"] == "/api/local/wechat2md/mirror"
    assert "exact title and date" in mirror_recovery["trigger"]
    assert "today-reading mirrors" in mirror_recovery["trigger"]
    assert "source_evidence" in mirror_recovery["provenance"]
    assert "never complete" in mirror_recovery["state_policy"]
    assert all(account.get("stable_biz") for account in products["accounts"])
    assert "canonicalUrl" in products["download"]["request_body"]
    assert "complete authenticated reconciliation" in products["file_manifest"]["empty_run_policy"]

    required_fields = set(products["report"]["required_fields"])
    assert {
        "per_account_scan_source",
        "per_account_scan_coverage",
        "per_account_profile_fallback_status",
        "per_account_public_fallback_status",
        "per_account_public_fallback_warnings",
        "per_account_weread_status",
        "per_account_weread_initial_directory_entries",
        "per_account_weread_directory_entries_loaded",
        "per_account_weread_scroll_steps",
        "per_account_weread_articles_discovered",
        "per_account_weread_boundary_reached",
        "per_account_weread_oldest_publish_time",
        "per_account_weread_catalog_missing_before",
        "per_account_weread_catalog_missing_after",
        "per_account_weread_catalog_ambiguous_after",
        "per_account_weread_date_repairs",
        "per_account_weread_official_url_entries",
        "per_account_weread_canonical_urls_verified",
        "per_account_weread_url_repairs",
        "per_account_weread_url_identity_mismatches",
        "per_account_weread_official_url_evidence_errors",
        "per_account_weread_warnings",
        "per_account_dashboard_recovered_articles",
        "per_account_dashboard_recovered_messages",
        "per_account_dashboard_unverifiable_local_records",
        "per_account_dashboard_article_count_after",
        "per_account_dashboard_verified_official_articles",
        "per_account_dashboard_idempotent_recovery_articles",
        "per_account_dashboard_idempotent_recovery_messages",
        "per_account_trusted_mirror_downloads",
        "per_account_unresolved_partial_source_articles",
        "profile_credential_cache_status",
    } <= required_fields


def test_steam_workflow_reuses_generic_visible_recovery_before_authenticated_probes():
    steam = load("indienova-steam-incremental.yaml")
    generic = steam["generic_account_recovery"]
    source_priority = steam["article_scan"]["source_priority"]
    complete_probe = steam["article_scan"]["authenticated_complete_source_probe"]

    assert generic["canonical_entry"].endswith("wechat-account-visible-recovery.yaml")
    assert "stable-biz input" in generic["relationship"]
    assert "account_resource.mjs" in generic["resource_command"]
    assert steam["account"]["stable_biz"] == "MjM5MjIyOTc2Nw=="
    assert steam["account"]["fakeid"] == steam["account"]["stable_biz"]
    assert "Do not call searchbiz" in steam["account"]["fakeid_policy"]
    assert "fakeid_discovery" not in steam["account"]
    assert source_priority["routine_order"] == [
        "local_canonical_export_reconciliation",
        "normal_chrome_visible_weread",
        "public_index_fallback",
        "authenticated_complete_source_probe",
    ]
    assert "Do not call searchbiz" in source_priority["preferred_acquisition"]
    assert "case-insensitively" in source_priority["partial_filter"]
    assert "never complete bounded overlap" in source_priority["partial_state_policy"]
    assert "never switches browser" in source_priority["user_action_policy"]
    assert complete_probe["endpoints"] == [
        "/api/web/mp/appmsgpublish",
        "/api/local/wechat2md/article-list",
    ]
    assert "Final probe only" in complete_probe["trigger"]
    assert "mp_api_request.py" in complete_probe["request_policy"]
    assert "preserves prior state" in complete_probe["success_policy"]
    assert "does not discard" in complete_probe["partial_preservation"]
    assert "already-open normal Google Chrome" in steam["auth"]["chrome_policy"]
    assert steam["download"]["request_body"]["expectedBiz"] == steam["account"]["stable_biz"]
    assert "partial-source no-op preserves prior state" in steam["file_manifest"]["empty_run_policy"]

    required_fields = set(steam["report"]["required_fields"])
    assert {
        "stable_biz",
        "resource_key",
        "source_order_attempted",
        "scan_coverage",
        "weread_directory_entries_loaded",
        "public_index_verified_articles",
        "complete_source_probe_status",
        "sync_state_update_result",
    } <= required_fields


def test_generic_account_recovery_is_dynamic_and_keeps_partial_sources_incomplete():
    generic = load("wechat-account-visible-recovery.yaml")
    serialized = (WORKFLOWS / "wechat-account-visible-recovery.yaml").read_text(encoding="utf-8")

    assert generic["scope"]["account_count"] == "exactly one account per invocation"
    assert "any account" in generic["scope"]["account_policy"]
    assert "account_resource.mjs" in generic["resource_resolution"]["command"]
    assert "stable_biz" in generic["resource_resolution"]["identity_rule"]
    assert generic["source_priority"]["dashboard_refresh"][1].startswith("continue to")
    assert "after partial-source reconciliation" in generic["source_priority"]["dashboard_refresh"][2]
    assert generic["source_priority"]["host_acquisition"][0] == "normal_chrome_visible_weread"
    assert "independent partial supplement" in generic["source_priority"]["partial_supplement_rule"]
    assert "login_required" in generic["source_priority"]["partial_supplement_rule"]
    assert "never the first request" in generic["source_priority"]["blocked_source_rule"]
    assert "visible_catalog_recovery.mjs" in generic["normal_chrome_visible_weread"]["recovery_command"]
    assert "--apply-url-repairs true" in generic["normal_chrome_visible_weread"]["recovery_command"]
    assert "empty successful no-op" in generic["normal_chrome_visible_weread"]["recovery_contract"]
    assert generic["public_index_fallback"]["request_timeout_seconds"] == 15
    assert "first page once" in generic["public_index_fallback"]["empty_result_retry"]
    assert "after preferred and partial-source reconciliation" in generic["authenticated_complete_source_probe"]["trigger"]
    assert "frequency controlled" in generic["authenticated_complete_source_probe"]["trigger"]
    assert generic["scope"]["coverage"] == "partial"
    assert "completed=false" in generic["dashboard_reconciliation"]["completion_policy"]
    assert any("old local record" in rule for rule in generic["forbidden"])
    assert "游戏吗喽说" not in serialized
    assert "新游观察" not in serialized
    assert "王董的新游戏" not in serialized


def test_readme_matches_the_canonical_source_order_and_probe_boundary():
    readme = README.read_text(encoding="utf-8")

    assert "微信读书成功后仍作为独立有界补充" in readme
    assert "部分来源核对结束后" in readme
    assert "受 API lease 约束的认证完整性末位探针" in readme
    assert "仅作微信读书非人工阻塞失败后的降级补充" not in readme
    assert "只有本地与公开来源都不可用时才把完整数据源放到末位探针" not in readme


def test_generic_account_recovery_lease_commands_parse_with_the_real_helper():
    generic = load("wechat-account-visible-recovery.yaml")
    helper_path = WORKFLOWS.parent / "automation_lease.py"
    spec = importlib.util.spec_from_file_location("wechat2md_automation_lease", helper_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    replacements = {"<leaseFile>": "/tmp/account-lease.json", "<owner_token>": "owner-token"}
    for field in ("acquire_command", "heartbeat_command"):
        tokens = shlex.split(generic["account_lease"][field])
        arguments = [replacements.get(token, token) for token in tokens[2:]]
        parsed = module.build_parser().parse_args(arguments)
        assert parsed.lease_file == Path("/tmp/account-lease.json")
        assert parsed.owner_token == "owner-token"

    heartbeat = module.build_parser().parse_args(
        [replacements.get(token, token) for token in shlex.split(generic["account_lease"]["heartbeat_command"])[2:]]
    )
    assert heartbeat.ttl_seconds == 3600
    assert heartbeat.interval_seconds == 300
    assert heartbeat.max_lifetime_seconds == 43200


def test_scheduled_workflow_lease_set_and_state_commands_parse_with_real_helpers():
    lease_path = WORKFLOWS.parent / "automation_lease.py"
    lease_spec = importlib.util.spec_from_file_location("wechat2md_lease_set_test_module", lease_path)
    assert lease_spec and lease_spec.loader
    lease_module = importlib.util.module_from_spec(lease_spec)
    lease_spec.loader.exec_module(lease_module)

    state_path = WORKFLOWS.parent / "sync_state.py"
    state_spec = importlib.util.spec_from_file_location("wechat2md_sync_state_test_module", state_path)
    assert state_spec and state_spec.loader
    state_module = importlib.util.module_from_spec(state_spec)
    state_spec.loader.exec_module(state_module)

    steam = load("indienova-steam-incremental.yaml")
    products = load("wechat-product-accounts-incremental.yaml")
    replacements = {
        "<legacy_lease_file>": "/tmp/legacy.json",
        "<lease_file>": "/tmp/canonical.json",
        "<account.legacy_lease_file>": "/tmp/product-legacy.json",
        "<account.lease_file>": "/tmp/product-canonical.json",
        "<account.state_key>": "account-key",
        "<owner_token>": "owner-token",
        "<path>": "/tmp/state.json",
        "<snapshot_file>": "/tmp/snapshot.json",
        "<candidate_file>": "/tmp/candidate.json",
        "<gate_file>": "/tmp/gate.json",
        "<account.state_path>": "/tmp/product-state.json",
        "<account_snapshot_file>": "/tmp/product-snapshot.json",
        "<account_candidate_file>": "/tmp/product-candidate.json",
        "<account_gate_file>": "/tmp/product-gate.json",
    }

    for workflow in (steam, products):
        lease = workflow["account_lease"] if "account_lease" in workflow else workflow["account_leases"]
        for field, command in (
            ("acquire_command", "acquire-set"),
            ("heartbeat_command", "heartbeat-set"),
            ("release_command", "release-set"),
        ):
            tokens = shlex.split(lease[field])
            args = [replacements.get(token, token) for token in tokens[2:]]
            parsed = lease_module.build_parser().parse_args(args)
            assert parsed.command == command
            assert len(parsed.lease_file) == 2
            assert parsed.lease_file[0].name.endswith("legacy.json")

        state = workflow["sync_state"]
        for field, command in (
            ("snapshot_command", "snapshot"),
            ("publish_command", "publish"),
            ("failure_verification_command", "verify-unchanged"),
        ):
            tokens = shlex.split(state[field])
            args = [replacements.get(token, token) for token in tokens[2:]]
            parsed = state_module.build_parser().parse_args(args)
            assert parsed.command == command
            if command == "publish":
                assert len(parsed.lease_file) == 2
                assert parsed.owner_token == "owner-token"

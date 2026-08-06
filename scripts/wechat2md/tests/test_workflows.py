from __future__ import annotations

import hashlib
import importlib.util
import shlex
from pathlib import Path

import yaml


WORKFLOWS = Path(__file__).resolve().parents[1] / "workflows"


def load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def test_workflows_use_account_scoped_leases_and_a_short_shared_service_startup_lease():
    steam = load("indienova-steam-incremental.yaml")
    products = load("wechat-product-accounts-incremental.yaml")

    steam_account_lease = steam["account_lease"]
    product_account_leases = products["account_leases"]
    product_lease_files = {account["lease_file"] for account in products["accounts"]}

    assert steam_account_lease["lease_file"] not in product_lease_files
    assert len(product_lease_files) == len(products["accounts"])
    assert all("/leases/accounts/" in path for path in product_lease_files)
    assert "other account workflows remain independent" in steam_account_lease["busy_policy"]
    assert "continue with other accounts" in product_account_leases["busy_policy"]
    assert "heartbeat" in steam_account_lease["heartbeat_command"]
    assert "heartbeat" in product_account_leases["heartbeat_command"]
    assert "stop before further download" in steam_account_lease["heartbeat_policy"]
    assert "stop before further download" in product_account_leases["heartbeat_policy"]
    assert "finally" in steam_account_lease["finally_release"]
    assert "finally" in product_account_leases["finally_release"]

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
        assert "atomically replace" in workflow["sync_state"]["persistence"]


def test_workflows_store_state_in_one_file_per_account_with_legacy_read_fallback():
    steam = load("indienova-steam-incremental.yaml")
    products = load("wechat-product-accounts-incremental.yaml")

    assert steam["sync_state"]["scope"] == "one_file_per_account"
    assert "/accounts/indienova.json" in steam["sync_state"]["path"]
    assert steam["sync_state"]["legacy_read_fallback"].endswith("indienova-steam-incremental.json")

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
        assert account["legacy_state_path"] != account["state_path"]
    assert "account.legacy_state_path" in products["sync_state"]["migration"]


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
    assert "generic_account_recovery.canonical_entry" in source_priority["dashboard_rule"]
    assert "continues bounded public discovery" in source_priority["dashboard_rule"]
    assert "Do not call" in source_priority["complete_source_probe"]
    assert products["generic_account_recovery"]["canonical_entry"].endswith(
        "wechat-account-visible-recovery.yaml"
    )
    assert "concrete input" in products["generic_account_recovery"]["relationship"]

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
    assert "weread_chrome_fallback" in fallback["unavailable_policy"]
    assert "Preserve the previous per-account sync state" in fallback["unavailable_policy"]
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


def test_generic_account_recovery_is_dynamic_and_keeps_partial_sources_incomplete():
    generic = load("wechat-account-visible-recovery.yaml")
    serialized = (WORKFLOWS / "wechat-account-visible-recovery.yaml").read_text(encoding="utf-8")

    assert generic["scope"]["account_count"] == "exactly one account per invocation"
    assert "any account" in generic["scope"]["account_policy"]
    assert "account_resource.mjs" in generic["resource_resolution"]["command"]
    assert "stable_biz" in generic["resource_resolution"]["identity_rule"]
    assert generic["source_priority"]["dashboard_refresh"][1].startswith("continue to")
    assert generic["source_priority"]["host_acquisition"][0] == "normal_chrome_visible_weread"
    assert "never the first request" in generic["source_priority"]["blocked_source_rule"]
    assert "visible_catalog_recovery.mjs" in generic["normal_chrome_visible_weread"]["recovery_command"]
    assert "--apply-url-repairs true" in generic["normal_chrome_visible_weread"]["recovery_command"]
    assert "empty successful no-op" in generic["normal_chrome_visible_weread"]["recovery_contract"]
    assert generic["public_index_fallback"]["request_timeout_seconds"] == 15
    assert "first page once" in generic["public_index_fallback"]["empty_result_retry"]
    assert generic["scope"]["coverage"] == "partial"
    assert "completed=false" in generic["dashboard_reconciliation"]["completion_policy"]
    assert any("old local record" in rule for rule in generic["forbidden"])
    assert "游戏吗喽说" not in serialized
    assert "新游观察" not in serialized
    assert "王董的新游戏" not in serialized


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

from __future__ import annotations

import importlib.util
import json
import sys
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "kb-import" / "batch-products-structured-import.py"


def load_module():
    spec = importlib.util.spec_from_file_location("batch_products_import_test_module", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def passing_data() -> dict:
    return {
        "quality": {
            "status": "pass",
            "pass": True,
            "failures": [],
            "metrics": {
                "unknown_publisher_ratio": 0.0,
                "suspicious_name_count": 0,
                "publisher_conflict_count": 0,
            },
        },
        "publisher_products": {
            "Publisher A": [
                {
                    "product_name": "我的休闲时光",
                    "account": "账号A",
                    "article_title": "文章A",
                    "url": "https://example.com/a",
                    "description": "产品描述",
                }
            ]
        },
    }


def test_common_chinese_characters_do_not_make_valid_product_names_noise():
    module = load_module()
    assert module.is_noise_product("我的休闲时光") is False
    assert module.is_noise_product("这城有良田") is False
    assert module.is_noise_product("在我们之间") is False
    assert module.is_noise_product("发行商：XINDONG") is True


def test_same_slug_merges_sources_and_preserves_publisher_conflict():
    module = load_module()
    data = {
        "publisher_products": {
            "Publisher A": [
                {"product_name": "Shared Game", "account": "A", "article_title": "One", "url": "https://a"}
            ],
            "Publisher B": [
                {"product_name": "Shared Game", "account": "B", "article_title": "Two", "url": "https://b"}
            ],
        }
    }

    products = module.collect_products(data)
    item = products["shared-game"]

    assert len(item["sources"]) == 2
    assert item["publishers"] == ["Publisher A", "Publisher B"]
    assert item["publisher_conflict"] is True
    assert item["publisher"] == "冲突待审"
    assert item["needs_review"] is True


def test_strong_store_identity_keeps_same_name_shells_separate():
    module = load_module()
    products = module.collect_products({
        "publisher_products": {
            "Publisher A": [
                {
                    "product_name": "Same Name",
                    "links": ["https://play.google.com/store/apps/details?id=com.example.one"],
                },
                {
                    "product_name": "Same Name",
                    "links": ["https://play.google.com/store/apps/details?id=com.example.two"],
                },
            ]
        }
    })

    assert set(products) == {"com.example.one", "com.example.two"}
    assert {item["identity_key"] for item in products.values()} == {
        "com.example.one",
        "com.example.two",
    }


def test_conflict_document_enters_needs_review(tmp_path):
    module = load_module()
    item = module.collect_products({
        "publisher_products": {
            "Publisher A": [{"product_name": "Shared Game", "url": "https://a"}],
            "Publisher B": [{"product_name": "Shared Game", "url": "https://b"}],
        }
    })["shared-game"]

    doc = module.build_document(item, tmp_path / "analysis.json", datetime.now(timezone.utc).isoformat())

    assert doc["status"] == "needs-review"
    assert doc["product"]["publisher_conflict"] is True
    assert doc["product"]["publishers"] == ["Publisher A", "Publisher B"]
    assert len(doc["wechat_product_analysis"]["sources"]) == 2
    assert doc["wechat_product_analysis"]["attribution_verified"] is False


def test_article_publisher_is_candidate_only(tmp_path):
    module = load_module()
    item = module.collect_products({
        "publisher_products": {
            "Publisher A": [{"product_name": "Candidate Game", "url": "https://a"}],
        }
    })["candidate-game"]

    doc = module.build_document(item, tmp_path / "analysis.json", datetime.now(timezone.utc).isoformat())

    assert "最终中国主体" not in doc["body"]
    assert doc["wechat_product_analysis"]["attribution_verified"] is False
    assert doc["wechat_product_analysis"]["candidate_cn_entity"] == ""


def test_dry_run_writes_sha_bound_receipt(tmp_path, monkeypatch):
    module = load_module()
    data_json = tmp_path / "_publisher_analysis.json"
    data_json.write_text(json.dumps(passing_data(), ensure_ascii=False), encoding="utf-8")
    receipt = tmp_path / "receipt.json"
    monkeypatch.setattr(module, "DOCUMENTS_DIR", tmp_path / "documents")
    monkeypatch.setattr(module, "PRODUCT_RECORDS", tmp_path / "structured" / "records.jsonl")
    monkeypatch.setattr(
        sys,
        "argv",
        [str(SCRIPT), "--data-json", str(data_json), "--receipt-json", str(receipt), "--dry-run"],
    )

    assert module.main() == 0
    payload = json.loads(receipt.read_text(encoding="utf-8"))
    assert payload["data_json_sha256"] == module.sha256_file(data_json)
    assert payload["candidate_summary"]["unique_products"] == 1
    assert payload["quality"]["status"] == "pass"
    assert payload["quality"]["warnings"] == []
    assert payload["expires_at"] > payload["created_at"]


def test_validate_receipt_rejects_expiry_and_candidate_changes(tmp_path, monkeypatch):
    module = load_module()
    monkeypatch.setattr(module, "DOCUMENTS_DIR", tmp_path / "documents")
    monkeypatch.setattr(module, "PRODUCT_RECORDS", tmp_path / "structured" / "records.jsonl")
    data_json = tmp_path / "analysis.json"
    data = passing_data()
    data_json.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    product_index = module.collect_products(data)
    plan = module.build_import_plan(product_index, data_json)
    quality = module.quality_from_data(data)
    created = datetime(2026, 7, 10, tzinfo=timezone.utc)
    receipt = module.build_receipt(
        data_json=data_json,
        data_sha256=module.sha256_file(data_json),
        include_subjects={"path": None, "sha256": None},
        plan=plan,
        quality=quality,
        ttl_hours=1,
        now=created,
    )

    with pytest.raises(ValueError, match="receipt_expired"):
        module.validate_receipt(
            receipt,
            data_json=data_json,
            data_sha256=module.sha256_file(data_json),
            include_subjects={"path": None, "sha256": None},
            plan=plan,
            quality=quality,
            now=created + timedelta(hours=2),
        )

    changed_plan = {**plan, "candidate_digest": "changed"}
    with pytest.raises(ValueError, match="candidate_digest_mismatch"):
        module.validate_receipt(
            receipt,
            data_json=data_json,
            data_sha256=module.sha256_file(data_json),
            include_subjects={"path": None, "sha256": None},
            plan=changed_plan,
            quality=quality,
            now=created,
        )


def test_document_transaction_rolls_back_and_cleans_staging(tmp_path, monkeypatch):
    module = load_module()
    documents_dir = tmp_path / "documents"
    documents_dir.mkdir()
    monkeypatch.setattr(module, "DOCUMENTS_DIR", documents_dir)
    item = module.collect_products(passing_data())["我的休闲时光"]
    doc = module.build_document(item, tmp_path / "analysis.json", datetime.now(timezone.utc).isoformat())
    target = documents_dir / f"{doc['doc_id']}.json"
    original = b'{"old": true}\n'
    target.write_bytes(original)

    def fail_refresh():
        raise RuntimeError("injected structured build failure")

    monkeypatch.setattr(module, "refresh_structured_products", fail_refresh)

    with pytest.raises(RuntimeError, match="injected structured build failure"):
        module.commit_documents_and_structured([doc])

    assert target.read_bytes() == original
    assert not list(tmp_path.glob(".wechat-products-staging-*"))
    assert not list(tmp_path.glob(".wechat-products-backup-*"))


def test_high_risk_quality_override_requires_reason_and_writes_report(tmp_path, monkeypatch):
    module = load_module()
    data = passing_data()
    data["quality"] = {
        "status": "fail",
        "pass": False,
        "failures": ["unknown_publisher_ratio_exceeded"],
        "metrics": {
            "unknown_publisher_ratio": 0.9,
            "suspicious_name_count": 0,
            "publisher_conflict_count": 0,
        },
    }
    data_json = tmp_path / "analysis.json"
    data_json.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    receipt = tmp_path / "receipt.json"
    override = tmp_path / "override.json"
    monkeypatch.setattr(module, "DOCUMENTS_DIR", tmp_path / "documents")
    monkeypatch.setattr(module, "PRODUCT_RECORDS", tmp_path / "structured" / "records.jsonl")
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--data-json", str(data_json), "--receipt-json", str(receipt), "--dry-run"])
    assert module.main() == 3

    monkeypatch.setattr(module, "single_writer_lock", lambda: nullcontext())
    monkeypatch.setattr(module, "commit_documents_and_structured", lambda documents: {"status": "committed-test"})
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(SCRIPT),
            "--data-json",
            str(data_json),
            "--receipt-json",
            str(receipt),
            "--confirm",
            "--high-risk-override-quality-gate",
            "--override-reason",
            "Human reviewed all conflicting candidates",
            "--override-report-json",
            str(override),
        ],
    )

    assert module.main() == 0
    report = json.loads(override.read_text(encoding="utf-8"))
    assert report["status"] == "committed"
    assert report["high_risk_flag"] == "--high-risk-override-quality-gate"
    assert report["reason"] == "Human reviewed all conflicting candidates"


def test_confirm_rebuilds_and_validates_plan_while_writer_lock_is_held(tmp_path, monkeypatch):
    module = load_module()
    data_json = tmp_path / "analysis.json"
    data_json.write_text(json.dumps(passing_data(), ensure_ascii=False), encoding="utf-8")
    receipt = tmp_path / "receipt.json"
    monkeypatch.setattr(module, "DOCUMENTS_DIR", tmp_path / "documents")
    monkeypatch.setattr(module, "PRODUCT_RECORDS", tmp_path / "structured" / "records.jsonl")
    monkeypatch.setattr(
        sys,
        "argv",
        [str(SCRIPT), "--data-json", str(data_json), "--receipt-json", str(receipt), "--dry-run"],
    )
    assert module.main() == 0

    state = {"inside": False, "prepared_inside": False}
    real_prepare = module.prepare_import_context

    @contextmanager
    def tracked_lock():
        state["inside"] = True
        try:
            yield
        finally:
            state["inside"] = False

    def tracked_prepare(**kwargs):
        state["prepared_inside"] = state["inside"]
        return real_prepare(**kwargs)

    monkeypatch.setattr(module, "single_writer_lock", tracked_lock)
    monkeypatch.setattr(module, "prepare_import_context", tracked_prepare)
    monkeypatch.setattr(module, "commit_documents_and_structured", lambda documents: {"status": "committed-test"})
    monkeypatch.setattr(
        sys,
        "argv",
        [str(SCRIPT), "--data-json", str(data_json), "--receipt-json", str(receipt), "--confirm"],
    )

    assert module.main() == 0
    assert state["prepared_inside"] is True
    assert state["inside"] is False


def test_cli_requires_data_json():
    module = load_module()
    with pytest.raises(SystemExit):
        module.build_parser().parse_args(["--dry-run"])

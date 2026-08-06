from __future__ import annotations

import importlib.util
import json
import os
import struct
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "kb-import" / "cleanup-legacy-product-wiki-import.py"


def load_module():
    spec = importlib.util.spec_from_file_location("cleanup_legacy_test_module", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def legacy_row(subject: str = "Legacy Game") -> dict:
    return {
        "synthesis_id": f"legacy-{subject}",
        "title": f"{subject}产品归因（公众号文章）",
        "subject": subject,
        "origin": "web-research",
        "synthesis_type": "attribution",
        "content": "来自公众号文章。",
    }


def write_pair(jsonl: Path, embedding: Path, rows: list[dict], *, dim: int = 2) -> None:
    jsonl.parent.mkdir(parents=True, exist_ok=True)
    embedding.parent.mkdir(parents=True, exist_ok=True)
    jsonl.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    embedding.write_bytes(struct.pack("<II", len(rows), dim) + b"\0" * (len(rows) * dim * 4))


def test_plan_validates_and_generates_aligned_staging_payload(tmp_path):
    module = load_module()
    jsonl = tmp_path / "rows.jsonl"
    embedding = tmp_path / "rows.bin"
    write_pair(jsonl, embedding, [legacy_row(), {"synthesis_id": "keep", "title": "Keep"}])

    plan = module.build_target_plan(jsonl, embedding)

    assert plan["before"] == 2
    assert plan["remove"] == 1
    assert plan["after"] == 1
    staged_jsonl = tmp_path / "staged.jsonl"
    staged_embedding = tmp_path / "staged.bin"
    staged_jsonl.write_bytes(plan["jsonl_bytes"])
    staged_embedding.write_bytes(plan["embedding_bytes"])
    assert module.validate_pair(staged_jsonl, staged_embedding) == {"count": 1, "dim": 2}


def test_preflight_rejects_mismatched_pair_before_any_write(tmp_path):
    module = load_module()
    jsonl = tmp_path / "rows.jsonl"
    embedding = tmp_path / "rows.bin"
    write_pair(jsonl, embedding, [legacy_row()])
    embedding.write_bytes(struct.pack("<II", 2, 2) + b"\0" * 16)
    before_jsonl = jsonl.read_bytes()
    before_embedding = embedding.read_bytes()

    with pytest.raises(ValueError, match="does not match JSONL row count"):
        module.build_target_plan(jsonl, embedding)

    assert jsonl.read_bytes() == before_jsonl
    assert embedding.read_bytes() == before_embedding


def test_failed_atomic_replace_restores_original_pair_and_cleans_staging(tmp_path, monkeypatch):
    module = load_module()
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    monkeypatch.setattr(module, "WIKI_DIR", wiki)
    jsonl = wiki / "rows.jsonl"
    embedding = wiki / "rows.bin"
    write_pair(jsonl, embedding, [legacy_row(), {"synthesis_id": "keep", "title": "Keep"}])
    before_jsonl = jsonl.read_bytes()
    before_embedding = embedding.read_bytes()
    plan = module.build_target_plan(jsonl, embedding)
    real_replace = os.replace
    failed = False

    def flaky_replace(src, dst):
        nonlocal failed
        if not failed and Path(dst) == embedding and "staging" in str(src):
            failed = True
            raise OSError("injected replace failure")
        return real_replace(src, dst)

    monkeypatch.setattr(module.os, "replace", flaky_replace)
    backup = wiki / "backup"

    with pytest.raises(OSError, match="injected replace failure"):
        module.apply_cleanup_plans([plan], backup)

    assert jsonl.read_bytes() == before_jsonl
    assert embedding.read_bytes() == before_embedding
    assert backup.exists()
    assert not list(wiki.glob(".legacy-product-cleanup-staging-*"))

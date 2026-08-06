from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "analysis" / "publisher-analysis.py"


def load_module():
    spec = importlib.util.spec_from_file_location("publisher_analysis_test_module", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cli_requires_explicit_scope():
    module = load_module()
    with pytest.raises(SystemExit):
        module.build_parser().parse_args([])

    args = module.build_parser().parse_args(["--allow-full-scan", "--dry-run"])
    assert args.allow_full_scan is True
    assert args.file_list is None


def test_structured_product_block_recognizes_fields_without_promoting_chapters():
    module = load_module()
    products = module.extract_products(
        [
            "# 本期观察",
            "## 一、产品列表",
            "### Project Nova",
            "- 发行商：XINDONG",
            "- 平台：iOS、Android",
            "- 链接：https://example.com/nova",
            "- 亮点：昼夜循环",
            "- 差异点：多人协作",
            "- 锐评：题材明确但内容量待验证",
            "这是一段产品简介。",
            "## 二、总结",
        ],
        article_publisher=None,
        is_single_pub=False,
    )

    assert [product["name"] for product in products] == ["Project Nova"]
    product = products[0]
    assert product["publisher"] == "XINDONG"
    assert product["publisher_candidates"] == ["XINDONG"]
    assert product["platforms"] == ["iOS", "Android"]
    assert product["links"] == ["https://example.com/nova"]
    assert product["highlights"] == ["昼夜循环"]
    assert product["differences"] == ["多人协作"]
    assert product["critique"] == ["题材明确但内容量待验证"]


def test_numbered_chapter_heading_is_not_used_as_publisher():
    module = load_module()
    products = module.extract_products(
        [
            "# 本期观察",
            "### Real Game",
            "## 二、海外发行观察",
            "没有显式发行商字段。",
        ],
        article_publisher=None,
        is_single_pub=False,
    )

    assert len(products) == 1
    assert products[0]["name"] == "Real Game"
    assert products[0]["publisher"] == "未知"


def test_labeled_game_blocks_extract_product_name_company_and_type():
    module = load_module()
    products = module.extract_products(
        [
            "# 本期产品",
            "1.",
            "游戏名字：Merge Princess",
            "游戏类型：二合",
            "游戏公司：SkyRise Digital Pte. Ltd.",
            "这是第一款产品。",
            "2.",
            "游戏名称：Crimson Match",
            "游戏类型：三消+cm",
            "游戏公司：UMICHAT",
            "这是第二款产品。",
        ],
        article_publisher=None,
        is_single_pub=False,
    )

    assert [product["name"] for product in products] == ["Merge Princess", "Crimson Match"]
    assert products[0]["publisher"] == "SkyRise Digital Pte. Ltd."
    assert products[0]["publisher_candidates"] == ["SkyRise Digital Pte. Ltd."]
    assert "二合" in products[0]["description"]
    assert products[1]["publisher"] == "UMICHAT"


def test_sentence_like_bold_lines_and_genre_headings_are_not_products():
    module = load_module()
    products = module.extract_products(
        [
            "# 本期观察",
            "### RPG类",
            "**下架了，看图类似 Forest Survivor，之前也做过类似的。**",
            "### Rovio不搞怒鸟开始搞别的了？",
            "### Merge Go!",
            "- 平台：iOS",
            "### Actual Game",
            "- 平台：Steam",
        ],
        article_publisher=None,
        is_single_pub=False,
    )

    assert [product["name"] for product in products] == ["Merge Go!", "Actual Game"]


def test_numbered_inline_product_and_publisher_columns_are_split():
    module = load_module()
    products = module.extract_products(
        [
            "# 本期产品",
            r"3\. Lootfall: PvE extraction game       Panzerdog",
            "https://play.google.com/store/apps/details?id=com.panzerdog.lootfall",
            "5.\u00a0Elemon Master       xiaojiao zhang",
            "https://play.google.com/store/apps/details?id=com.herogame.gplay.pocketrpg",
            "My Train Defense     PLAYSTROM",
            "https://play.google.com/store/apps/details?id=com.playstrom.mtd",
            r"2\. 喵喵猫树          LoadComplete",
            "https://play.google.com/store/apps/details?id=com.loadcomplete.cattower",
            r"4\. Highway Heroes: Truck Manager      PIXEL FEDERATION, s.r.o.",
            "https://play.google.com/store/apps/details?id=com.pixelfederation.truck",
        ],
        article_publisher=None,
        is_single_pub=False,
    )

    assert [product["name"] for product in products] == [
        "Lootfall: PvE extraction game",
        "Elemon Master",
        "My Train Defense",
        "喵喵猫树",
        "Highway Heroes: Truck Manager",
    ]
    assert [product["publisher"] for product in products] == [
        "Panzerdog",
        "xiaojiao zhang",
        "PLAYSTROM",
        "LoadComplete",
        "PIXEL FEDERATION, s.r.o.",
    ]


def test_any_suspicious_product_name_is_a_hard_failure():
    module = load_module()
    products = [
        {"name": f"Clean Game {index}", "publisher": "Publisher", "publisher_candidates": ["Publisher"]}
        for index in range(30)
    ]
    products.append(
        {
            "name": "这是一个可以通过合成不断扩展的游戏",
            "publisher": "Publisher",
            "publisher_candidates": ["Publisher"],
        }
    )

    quality = module.build_quality_report(
        [{"title": "A", "account": "账号A", "url": "https://example.com/a", "products": products}]
    )

    assert quality["metrics"]["suspicious_name_ratio"] < 0.05
    assert quality["status"] == "fail"
    assert quality["failures"] == ["suspicious_product_names"]


def test_quality_report_contains_suspicious_unknown_and_conflicts():
    module = load_module()
    articles = [
        {
            "title": "A",
            "account": "账号A",
            "url": "https://example.com/a",
            "products": [
                {"name": "发行商：XINDONG", "publisher": "未知", "publisher_candidates": []},
                {"name": "Shared Game", "publisher": "Publisher A", "publisher_candidates": ["Publisher A"]},
            ],
        },
        {
            "title": "B",
            "account": "账号B",
            "url": "https://example.com/b",
            "products": [
                {"name": "Shared Game", "publisher": "Publisher B", "publisher_candidates": ["Publisher B"]},
            ],
        },
    ]

    quality = module.build_quality_report(articles)

    assert quality["status"] == "fail"
    assert quality["metrics"]["unknown_publisher_count"] == 1
    assert quality["metrics"]["suspicious_name_count"] == 1
    assert quality["metrics"]["publisher_conflict_count"] == 1
    assert quality["suspicious_names"][0]["product_name"] == "发行商：XINDONG"
    assert quality["conflicts"][0]["publishers"] == ["Publisher A", "Publisher B"]
    assert quality["samples"]["publisher_conflicts"]


def test_unknown_publishers_and_attribution_conflicts_are_review_warnings():
    module = load_module()
    articles = [
        {
            "title": "A",
            "account": "账号A",
            "url": "https://example.com/a",
            "products": [
                {"name": "Unknown Game", "publisher": "未知", "publisher_candidates": []},
                {"name": "Unknown Game 2", "publisher": "未知", "publisher_candidates": []},
                {"name": "Unknown Game 3", "publisher": "未知", "publisher_candidates": []},
                {"name": "Unknown Game 4", "publisher": "未知", "publisher_candidates": []},
                {"name": "Shared Game", "publisher": "Publisher A", "publisher_candidates": ["Publisher A"]},
            ],
        },
        {
            "title": "B",
            "account": "账号B",
            "url": "https://example.com/b",
            "products": [
                {"name": "Shared Game", "publisher": "Publisher B", "publisher_candidates": ["Publisher B"]},
            ],
        },
    ]

    quality = module.build_quality_report(articles)

    assert quality["status"] == "pass"
    assert quality["failures"] == []
    assert "unknown_publisher_ratio_exceeded" in quality["warnings"]
    assert "publisher_conflict_ratio_exceeded" in quality["warnings"]


def test_main_writes_embedded_and_standalone_quality_report(tmp_path, monkeypatch):
    module = load_module()
    source = tmp_path / "WechatArticles"
    article = source / "账号A" / "文章A" / "index.md"
    article.parent.mkdir(parents=True)
    article.write_text(
        """---
title: "产品观察"
date: "2026-07-10"
url: "https://example.com/article"
---

# 产品观察

### Project Nova
- 发行商：XINDONG
- 平台：iOS、Android
""",
        encoding="utf-8",
    )
    manifest = tmp_path / "files.json"
    manifest.write_text(json.dumps({"files": [str(article)]}, ensure_ascii=False), encoding="utf-8")
    output = tmp_path / "analysis"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(SCRIPT),
            "--source-dir",
            str(source),
            "--file-list",
            str(manifest),
            "--output-dir",
            str(output),
        ],
    )

    module.main()

    analysis = json.loads((output / "_publisher_analysis.json").read_text(encoding="utf-8"))
    quality = json.loads((output / "_analysis_quality_report.json").read_text(encoding="utf-8"))
    assert analysis["quality"] == quality
    assert quality["status"] == "pass"

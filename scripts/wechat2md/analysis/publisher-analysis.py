#!/usr/bin/env python3
"""
从 WechatArticles 目录提取所有游戏产品信息，按发行商归类。
v2：文章级分类 + 产品级发行商检测 + 更全面的关键词库
"""

import argparse
import os
import re
import json
from pathlib import Path
from collections import defaultdict
from typing import Any, Optional, Tuple, List, Dict

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SOURCE_DIR = Path("/Users/adobe/Project/output/WechatArticles")
OUTPUT_DIR = PROJECT_ROOT / ".local" / "wechat2md-analysis" / "publisher-analysis"

# ── 发行商规范化映射 ─────────────────────────────────────────────
# 关键词(小写) -> canonical 发行商名称
PUBLISHER_MAP = {
    # 海彼
    "海彼": "海彼 (Habby)",
    "habby": "海彼 (Habby)",
    "bailing": "海彼 (Habby)",  # com.bailing.*
    # Voodoo 生态
    "voodoo": "Voodoo",
    "rollic": "Voodoo (Rollic)",
    # 111%
    "111%": "111%",
    # 波克
    "波克": "波克城市 (Bokul)",
    # 游族
    "游族": "游族网络",
    # 网易
    "网易": "网易 (NetEase)",
    "mattel163": "网易 (NetEase)",
    # 点点互动
    "点点互动": "点点互动 (Dian Dian)",
    "点点的": "点点互动 (Dian Dian)",
    "点点战舰": "点点互动 (Dian Dian)",
    # 哈喽沃德
    "哈喽沃德": "哈喽沃德 (Hello World)",
    # 功夫特牛 / PeakX
    "功夫特牛": "功夫特牛 / PeakX",
    "peakx": "功夫特牛 / PeakX",
    "peak x": "功夫特牛 / PeakX",
    # 西安墨焰
    "西安墨焰": "西安墨焰",
    "墨焰": "西安墨焰",
    # Supercell
    "supercell": "Supercell",
    # Square Enix
    "square enix": "Square Enix",
    "史克威尔": "Square Enix",
    "squareenix": "Square Enix",
    # 途游
    "途游": "途游游戏",
    # 莉莉丝
    "莉莉丝": "莉莉丝 (Lilith)",
    "lilith": "莉莉丝 (Lilith)",
    # Lion Studios
    "lion studios": "Lion Studios",
    "lion合作": "Lion Studios",
    "lion的": "Lion Studios",
    # Homa Games
    "homa": "Homa Games",
    # 重力社
    "重力社": "重力社",
    # 壳木
    "壳木": "壳木软件",
    # 凉屋
    "凉屋": "凉屋游戏",
    # 多益
    "多益": "多益网络",
    # 益世界
    "益世界": "益世界",
    # FunPlus
    "funplus": "FunPlus",
    # 智明星通
    "智明星通": "智明星通",
    # 超燃互动
    "超燃": "超燃互动",
    # 4399
    "4399": "4399",
    # 魔兔
    "魔兔": "魔兔游戏",
    # Codigame
    "codigame": "Codigame",
    # Tap4Fun
    "tap4fun": "Tap4Fun",
    # 卓航
    "卓航": "卓航互动",
    # 龙腾
    "龙腾": "龙腾游戏",
    # 王铲铲 (研发名)
    "王铲铲": "王铲铲工作室",
    # 育碧
    "育碧": "育碧 (Ubisoft)",
    "ubisoft": "育碧 (Ubisoft)",
    # Fansipan
    "fansipan": "Fansipan",
    # SayGame
    "saygame": "SayGame",
    # NCsoft
    "ncsoft": "NCSoft",
    # Rivvy (Voodoo 旗下)
    "rivvy": "Voodoo (Rivvy)",
}

# 在文本中精确检测发行商的正则（按顺序优先匹配）
PUBLISHER_PATTERNS = [
    (r"海彼[的]?", "海彼 (Habby)"),
    (r"Voodoo(?:合作商|账号|家|的|旗下)?", "Voodoo"),
    (r"Rollic[的]?", "Voodoo (Rollic)"),
    (r"111%[的]?", "111%"),
    (r"波克[城市的]*", "波克城市 (Bokul)"),
    (r"游族[网络的]*", "游族网络"),
    (r"[Mm]attel\s*163", "网易 (NetEase)"),
    (r"网易[的]?", "网易 (NetEase)"),
    (r"点点互动[的]?", "点点互动 (Dian Dian)"),
    (r"点点[的战舰]*", "点点互动 (Dian Dian)"),
    (r"哈喽沃德[的]?", "哈喽沃德 (Hello World)"),
    (r"功夫特牛[研发的]*", "功夫特牛 / PeakX"),
    (r"[Pp]eak\s*[Xx]", "功夫特牛 / PeakX"),
    (r"西安墨焰[的]?", "西安墨焰"),
    (r"墨焰[的]?", "西安墨焰"),
    (r"[Ss]upercell", "Supercell"),
    (r"史克威尔艾尼克斯", "Square Enix"),
    (r"[Ss]quare\s*[Ee]nix", "Square Enix"),
    (r"途游[游戏的]*", "途游游戏"),
    (r"莉莉丝[的]?", "莉莉丝 (Lilith)"),
    (r"[Ll]ilith", "莉莉丝 (Lilith)"),
    (r"Lion\s*[Ss]tudios?[的]?", "Lion Studios"),
    (r"Lion合作", "Lion Studios"),
    (r"[Hh]oma\s*[Gg]ames?", "Homa Games"),
    (r"重力社[的]?", "重力社"),
    (r"壳木[软件的]*", "壳木软件"),
    (r"凉屋[游戏的]*", "凉屋游戏"),
    (r"多益[网络的]*", "多益网络"),
    (r"益世界[的]?", "益世界"),
    (r"[Ff]un[Pp]lus", "FunPlus"),
    (r"智明星通[的]?", "智明星通"),
    (r"(?<![A-Za-z])IGG(?![A-Za-z])[的]?", "IGG"),
    (r"超燃[互动的]*", "超燃互动"),
    (r"4399[的]?", "4399"),
    (r"魔兔[游戏的]*", "魔兔游戏"),
    (r"[Cc]odigame", "Codigame"),
    (r"[Tt]ap4[Ff]un", "Tap4Fun"),
    (r"卓航[互动的]*", "卓航互动"),
    (r"[Rr]ivvy", "Voodoo (Rivvy)"),
    (r"育碧[的]?", "育碧 (Ubisoft)"),
    (r"[Uu]bisoft", "育碧 (Ubisoft)"),
    (r"[Ss]ay[Gg]ame", "SayGame"),
    (r"[Ff]ansipan", "Fansipan"),
    (r"王铲铲[研发的]*", "王铲铲工作室"),
]

# 专题文章标题中发行商的直接映射（标题包含这些词时，文章是专题文章）
SINGLE_PUBLISHER_TITLE_PATTERNS = [
    (r"海彼", "海彼 (Habby)"),
    (r"Voodoo账号下", "Voodoo"),
    (r"Supercell新产品", "Supercell"),
    (r"111%新品", "111%"),
]

# 排除词：出现在候选产品名中时说明不是产品
EXCLUDE_IN_NAME = [
    "新游", "冒泡", "观察", "总结", "前置", "小结", "番外", "附链接", "视频",
    "比如", "以下", "注意", "Tips", "另外", "即将", "期待", "例如",
    "回归", "更新", "上线", "测试", "上架", "发布", "以及", "点评",
    "综合", "观感", "体验", "分析", "整体", "感受",
]

FIELD_LABELS = {
    "发行商": "publishers",
    "发行公司": "publishers",
    "出版商": "publishers",
    "厂商": "publishers",
    "游戏公司": "publishers",
    "开发商": "developers",
    "研发商": "developers",
    "平台": "platforms",
    "上线平台": "platforms",
    "发布平台": "platforms",
    "链接": "links",
    "产品链接": "links",
    "商店链接": "links",
    "下载链接": "links",
    "亮点": "highlights",
    "产品亮点": "highlights",
    "差异点": "differences",
    "差异化": "differences",
    "差异": "differences",
    "锐评": "critique",
    "点评": "critique",
    "评价": "critique",
    "简介": "description",
    "描述": "description",
    "产品描述": "description",
    "玩法": "description",
    "核心玩法": "description",
    "游戏类型": "description",
}

PRODUCT_NAME_LABELS = {
    "产品名", "产品名称", "游戏名", "游戏名字", "游戏名称",
}

GENERIC_SECTION_HEADINGS = {
    "产品", "产品列表", "游戏", "游戏列表", "新游", "新游列表", "本期产品",
    "本期新游", "正文", "前言", "总结", "小结", "结语", "其他", "其它",
    "亮点", "产品亮点", "差异点", "差异化", "锐评", "点评", "平台", "链接",
    "发行商", "开发商", "基础信息", "项目信息", "产品信息", "游戏信息",
    "Merge", "RPG", "SLG",
}

QUALITY_THRESHOLDS = {
    "max_unknown_publisher_ratio": 0.60,
    "max_suspicious_name_ratio": 0.0,
    "max_publisher_conflict_ratio": 0.02,
}


def detect_publisher(text: str) :
    """在文本中检测发行商关键词，返回规范名称"""
    if not text:
        return None
    for pattern, publisher in PUBLISHER_PATTERNS:
        if re.search(pattern, text):
            return publisher
    text_lower = text.lower()
    for keyword, publisher in PUBLISHER_MAP.items():
        if keyword.lower() in text_lower:
            return publisher
    return None


def detect_article_publisher(title: str, body_intro: str) :
    """
    检测文章级发行商。
    返回 (publisher, is_single_publisher_article)
    """
    combined = title + "\n" + body_intro

    # 检查是否是专题文章（标题明确标识单一发行商）
    for pattern, publisher in SINGLE_PUBLISHER_TITLE_PATTERNS:
        if re.search(pattern, title):
            # 确认标题不是多发行商混合（不含分号）
            if "；" not in title and ";" not in title:
                return publisher, True

    # 从标题/intro检测发行商（不算专题）
    publisher = detect_publisher(combined[:500])
    return publisher, False


def article_account(filepath: Path, source_dir: Path) -> str:
    try:
        rel_parts = filepath.resolve().relative_to(source_dir.resolve()).parts
    except ValueError:
        return ""
    return rel_parts[0] if len(rel_parts) >= 3 else ""


def parse_article(filepath: Path, source_dir: Path = SOURCE_DIR) :
    content = filepath.read_text(encoding="utf-8")
    lines = content.splitlines()

    # 解析 frontmatter
    meta = {}
    body_start = 0
    if lines and lines[0].strip() == "---":
        for i, line in enumerate(lines[1:], 1):
            if line.strip() == "---":
                body_start = i + 1
                break
            if ":" in line:
                key, _, val = line.partition(":")
                meta[key.strip()] = val.strip().strip('"')

    body_lines = lines[body_start:]
    body_text = "\n".join(body_lines)

    # 获取文章介绍段（第一个图片之前的文字）
    intro_lines = []
    for l in body_lines[:20]:
        if l.strip().startswith("!"):
            break
        intro_lines.append(l)
    body_intro = "\n".join(intro_lines)

    title = meta.get("title", filepath.parent.name)
    article_publisher, is_single = detect_article_publisher(title, body_intro)

    products = extract_products(body_lines, article_publisher, is_single)

    # 统计文章中出现的发行商（用于文章级分析）
    mentioned_publishers = []
    for _, pub in PUBLISHER_PATTERNS:
        pattern = [p for p, pp in PUBLISHER_PATTERNS if pp == pub][0]
        if re.search(pattern, body_text) and pub not in mentioned_publishers:
            mentioned_publishers.append(pub)

    return {
        "title": title,
        "account": article_account(filepath, source_dir),
        "date": meta.get("date", ""),
        "url": meta.get("url", ""),
        "article_publisher": article_publisher,
        "is_single_publisher": is_single,
        "mentioned_publishers": mentioned_publishers,
        "products": products,
    }


def clean_markdown_value(value: str) -> str:
    value = re.sub(r"^\s*[-+*]\s+", "", str(value or "").strip())
    value = re.sub(r"^#{1,6}\s+", "", value)
    value = value.replace("**", "").replace("__", "").strip()
    return value.strip("*` \t")


def field_key_for_label(label: str) -> Optional[str]:
    normalized = re.sub(r"[\s*：:]", "", clean_markdown_value(label))
    return FIELD_LABELS.get(normalized)


def parse_field_line(line: str) -> Optional[Tuple[str, str]]:
    cleaned = clean_markdown_value(line)
    match = re.match(r"^([^：:]{1,16})\s*[：:]\s*(.*?)\s*$", cleaned)
    if not match:
        return None
    key = field_key_for_label(match.group(1))
    if not key:
        return None
    return key, clean_markdown_value(match.group(2))


def is_chapter_heading(value: str) -> bool:
    cleaned = clean_markdown_value(value).strip(".。")
    compact = re.sub(r"\s+", "", cleaned).lower()
    if compact in {re.sub(r"\s+", "", item).lower() for item in GENERIC_SECTION_HEADINGS}:
        return True
    if field_key_for_label(compact):
        return True
    if re.match(r"^(?:第)?[一二三四五六七八九十百0-9]+(?:[章节部分、.．):：]|$)", compact):
        return True
    if re.match(r"^[a-z0-9+#-]{2,16}类$", compact, re.I):
        return True
    return bool(re.match(r"^(?:本期|今日|近期|一周|每周).*(?:汇总|盘点|观察|总结|推荐)$", compact))


def suspicious_name_reasons(name: str) -> List[str]:
    cleaned = clean_markdown_value(name)
    reasons: List[str] = []
    if len(cleaned) < 2 or len(cleaned) > 80:
        reasons.append("invalid_length")
    if is_chapter_heading(cleaned):
        reasons.append("chapter_heading")
    if parse_field_line(cleaned) or re.match(r"^(发行商|开发商|平台|链接|亮点|差异点|锐评)\s*[：:]", cleaned):
        reasons.append("metadata_label")
    if cleaned.endswith(("。", "，", "；", "：", ":")):
        reasons.append("sentence_punctuation")
    if cleaned.endswith(("?", "？")) and len(re.findall(r"[\u4e00-\u9fff]", cleaned)) >= 3:
        reasons.append("sentence_question")
    if re.search(r"https?://|www\.", cleaned, re.I):
        reasons.append("url")
    if re.search(r"[ \t\u00a0\u3000]{2,}", cleaned):
        reasons.append("inline_publisher_suffix")
    if len(re.findall(r"[\u4e00-\u9fff]", cleaned)) >= 10 and re.search(
        r"(我们|玩家|产品|游戏|可以|通过|目前|因此|如果|以及|整体|主要)", cleaned
    ):
        reasons.append("sentence_like")
    return reasons


def plausible_product_name(name: str) -> bool:
    cleaned = clean_markdown_value(name)
    if suspicious_name_reasons(cleaned):
        return False
    if any(ex in cleaned for ex in EXCLUDE_IN_NAME):
        return False
    if re.search(
        r"\b(Ltd|Limited|Studio|Inc|Corp|LLC|Publishing|Entertainment|Network|Software|Co\.)\b",
        cleaned,
        re.I,
    ):
        return False
    return True


def parse_inline_product_candidate(line: str) -> Optional[Tuple[str, Optional[str]]]:
    stripped = line.strip()
    numbered = re.match(r"^\s*\d+\s*(?:\\\.|[.．、])\s*(.+?)\s*$", stripped)
    value = numbered.group(1) if numbered else stripped
    columns = re.split(r"[ \t\u00a0\u3000]{2,}", value, maxsplit=1)
    if not numbered and len(columns) < 2:
        return None

    name = clean_markdown_value(columns[0])
    publisher = clean_markdown_value(columns[1]) if len(columns) > 1 else ""
    if not name or not plausible_product_name(name):
        return None
    if publisher and (
        len(publisher) > 80
        or re.search(r"https?://|www\.", publisher, re.I)
        or publisher.endswith(("。", "，", "；", "！", "!", "？", "?"))
    ):
        return None
    return name, publisher or None


def extract_product_candidate_details(line: str) -> Optional[Tuple[str, Optional[str]]]:
    stripped = line.strip()
    if not stripped or parse_field_line(stripped):
        return None

    labeled = re.match(r"^([^：:]{1,16})\s*[：:]\s*(.+?)\s*$", clean_markdown_value(stripped))
    if labeled:
        label = re.sub(r"\s+", "", clean_markdown_value(labeled.group(1)))
        if label in PRODUCT_NAME_LABELS:
            candidate = clean_markdown_value(labeled.group(2))
            return (candidate, None) if plausible_product_name(candidate) else None

    bold = re.match(r"^\*{1,2}(?:\d+[.、]\s*)?(.+?)\*{1,2}[.。]?$", stripped)
    if bold:
        candidate = clean_markdown_value(bold.group(1))
        return (candidate, None) if plausible_product_name(candidate) else None

    heading = re.match(r"^#{2,4}\s+(.+?)\s*$", stripped)
    if heading:
        candidate = clean_markdown_value(heading.group(1))
        return (candidate, None) if plausible_product_name(candidate) else None

    inline = parse_inline_product_candidate(stripped)
    if inline:
        return inline

    if re.match(r"^[A-Z][A-Za-z0-9][A-Za-z0-9\s:!&\-'\.]{2,55}$", stripped):
        candidate = clean_markdown_value(stripped)
        return (candidate, None) if plausible_product_name(candidate) else None
    return None


def extract_product_candidate(line: str) -> Optional[str]:
    details = extract_product_candidate_details(line)
    return details[0] if details else None


def split_field_values(value: str) -> List[str]:
    return [
        cleaned
        for part in re.split(r"[、,，|；;]+", value or "")
        if (cleaned := clean_markdown_value(part))
    ]


def normalize_publishers(value: str) -> List[str]:
    value = clean_markdown_value(value)
    if not value:
        return []
    detected = detect_publisher(value)
    if detected:
        return [detected]
    return split_field_values(value)


def parse_product_block(
    name: str,
    lines: List[str],
    article_publisher: Optional[str],
    is_single_pub: bool,
    inline_publisher: Optional[str] = None,
) -> Dict[str, Any]:
    fields: Dict[str, List[str]] = defaultdict(list)
    prose: List[str] = []
    pending_field: Optional[str] = None

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        heading = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if heading:
            pending_field = field_key_for_label(heading.group(1))
            continue

        parsed = parse_field_line(line)
        if parsed:
            key, value = parsed
            if value:
                fields[key].append(value)
            pending_field = key if not value else None
            continue

        cleaned = clean_markdown_value(line)
        if pending_field and cleaned and not line.startswith("!"):
            fields[pending_field].append(cleaned)
            pending_field = None
            continue
        pending_field = None

        urls = re.findall(r"https?://[^\s)]+", line)
        if urls:
            fields["links"].extend(urls)
        if line.startswith("!") or line.startswith("http") or is_chapter_heading(cleaned):
            continue
        if not extract_product_candidate(line):
            prose.append(cleaned)

    publishers: List[str] = []
    if inline_publisher:
        detected_inline_publisher = detect_publisher(inline_publisher)
        publishers = [detected_inline_publisher or clean_markdown_value(inline_publisher)]
    for raw in fields.get("publishers", []):
        publishers.extend(normalize_publishers(raw))
    publishers = list(dict.fromkeys(publishers))

    if not publishers:
        non_heading_text = "\n".join(prose + fields.get("description", []))
        detected = detect_publisher(non_heading_text)
        if detected:
            publishers = [detected]
    if not publishers and is_single_pub and article_publisher:
        publishers = [article_publisher]

    platforms: List[str] = []
    for raw in fields.get("platforms", []):
        platforms.extend(split_field_values(raw))
    links: List[str] = []
    for raw in fields.get("links", []):
        found = re.findall(r"https?://[^\s)]+", raw)
        links.extend(found or [raw])

    description_values = fields.get("description", []) or prose
    return {
        "name": clean_markdown_value(name),
        "publisher": publishers[0] if len(publishers) == 1 else ("未知" if not publishers else "冲突待审"),
        "publisher_candidates": publishers,
        "platforms": list(dict.fromkeys(platforms)),
        "links": list(dict.fromkeys(links)),
        "highlights": fields.get("highlights", []),
        "differences": fields.get("differences", []),
        "critique": fields.get("critique", []),
        "description": " ".join(description_values)[:600].strip(),
    }


def extract_products(body_lines: list, article_publisher: Optional[str], is_single_pub: bool) :
    start = 0
    for idx, line in enumerate(body_lines):
        if line.strip().startswith("# "):
            start = idx + 1
            break

    candidates: List[Tuple[int, str, Optional[str]]] = []
    for index in range(start, len(body_lines)):
        details = extract_product_candidate_details(body_lines[index])
        if details:
            name, inline_publisher = details
            candidates.append((index, name, inline_publisher))

    products: List[Dict[str, Any]] = []
    for candidate_index, (line_index, name, inline_publisher) in enumerate(candidates):
        next_index = candidates[candidate_index + 1][0] if candidate_index + 1 < len(candidates) else len(body_lines)
        block_lines = body_lines[line_index + 1:next_index]
        products.append(parse_product_block(name, block_lines, article_publisher, is_single_pub, inline_publisher))
    return products


def extract_file_list_values(value: Any) -> List[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        out: List[str] = []
        for item in value:
            out.extend(extract_file_list_values(item))
        return out
    if isinstance(value, dict):
        out: List[str] = []
        for key in ("all_files", "files", "accounts"):
            if key in value:
                out.extend(extract_file_list_values(value[key]))
        if out:
            return out
        for child in value.values():
            out.extend(extract_file_list_values(child))
        return out
    return []


def normalize_article_file(raw_path: str, source_dir: Path) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = source_dir / path
    if path.is_dir():
        path = path / "index.md"
    return path.resolve()


def is_in_scope(filepath: Path, source_dir: Path, accounts: set[str]) -> bool:
    try:
        rel_parts = filepath.resolve().relative_to(source_dir.resolve()).parts
    except ValueError:
        return False
    if any(part.startswith("_") for part in rel_parts):
        return False
    if accounts and article_account(filepath, source_dir) not in accounts:
        return False
    return filepath.name == "index.md"


def collect_article_files(
    source_dir: Path,
    file_list: Optional[Path],
    accounts: set[str],
    *,
    allow_full_scan: bool = False,
) -> List[Path]:
    source_dir = source_dir.expanduser().resolve()
    files: List[Path] = []
    if file_list:
        with file_list.expanduser().open(encoding="utf-8") as handle:
            data = json.load(handle)
        raw_files = extract_file_list_values(data)
        if not raw_files:
            raise ValueError(f"文件清单不包含任何可识别路径: {file_list}")
        for raw_path in raw_files:
            filepath = normalize_article_file(raw_path, source_dir)
            if filepath.exists() and is_in_scope(filepath, source_dir, accounts):
                files.append(filepath)
            else:
                print(f"跳过不在范围内或不存在的文件: {filepath}")
    else:
        if not allow_full_scan:
            raise ValueError("默认禁止全目录扫描；请传 --file-list，或显式传 --allow-full-scan。")
        roots = [source_dir / account for account in sorted(accounts)] if accounts else [source_dir]
        for root in roots:
            if root.exists():
                files.extend(p.resolve() for p in root.rglob("index.md") if is_in_scope(p, source_dir, accounts))

    return sorted(dict.fromkeys(files))


def product_quality_key(name: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", str(name or "").casefold())


def build_quality_report(all_articles: List[Dict[str, Any]]) -> Dict[str, Any]:
    rows: List[Dict[str, Any]] = []
    for article in all_articles:
        for product in article.get("products", []):
            rows.append({
                "product_name": str(product.get("name") or "").strip(),
                "publisher": str(product.get("publisher") or "未知").strip() or "未知",
                "publisher_candidates": list(product.get("publisher_candidates") or []),
                "account": article.get("account", ""),
                "article_title": article.get("title", ""),
                "url": article.get("url", ""),
            })

    empty_articles = [
        {
            "account": article.get("account", ""),
            "article_title": article.get("title", ""),
            "url": article.get("url", ""),
        }
        for article in all_articles
        if not article.get("products")
    ]
    suspicious: List[Dict[str, Any]] = []
    unknown: List[Dict[str, Any]] = []
    grouped_publishers: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        reasons = suspicious_name_reasons(row["product_name"])
        if reasons:
            suspicious.append({**row, "reasons": reasons})
        candidates = [
            candidate
            for candidate in row.get("publisher_candidates", [])
            if candidate and candidate not in {"未知", "冲突待审"}
        ]
        if row["publisher"] in {"", "未知"} and not candidates:
            unknown.append(row)
        key = product_quality_key(row["product_name"])
        if not key:
            continue
        group = grouped_publishers.setdefault(key, {
            "product_name": row["product_name"],
            "publishers": set(),
            "sources": [],
        })
        group["publishers"].update(candidates or ([row["publisher"]] if row["publisher"] not in {"", "未知", "冲突待审"} else []))
        group["sources"].append({
            "account": row["account"],
            "article_title": row["article_title"],
            "url": row["url"],
            "publisher": row["publisher"],
        })

    conflicts = [
        {
            "product_name": group["product_name"],
            "publishers": sorted(group["publishers"]),
            "sources": group["sources"][:10],
        }
        for group in grouped_publishers.values()
        if len(group["publishers"]) > 1
    ]
    total = len(rows)
    unique_total = len(grouped_publishers)
    unknown_ratio = len(unknown) / total if total else 1.0
    suspicious_ratio = len(suspicious) / total if total else 1.0
    conflict_ratio = len(conflicts) / unique_total if unique_total else 0.0

    failures: List[str] = []
    warnings: List[str] = []
    if not all_articles:
        failures.append("no_articles")
    if total == 0:
        failures.append("no_products")
    if unknown_ratio > QUALITY_THRESHOLDS["max_unknown_publisher_ratio"]:
        warnings.append("unknown_publisher_ratio_exceeded")
    if suspicious:
        failures.append("suspicious_product_names")
    if conflict_ratio > QUALITY_THRESHOLDS["max_publisher_conflict_ratio"]:
        warnings.append("publisher_conflict_ratio_exceeded")
    if empty_articles:
        warnings.append("articles_without_products")

    status = "pass" if not failures else "fail"
    return {
        "status": status,
        "pass": status == "pass",
        "thresholds": QUALITY_THRESHOLDS,
        "metrics": {
            "article_count": len(all_articles),
            "product_record_count": total,
            "unique_product_count": unique_total,
            "unknown_publisher_count": len(unknown),
            "unknown_publisher_ratio": round(unknown_ratio, 6),
            "suspicious_name_count": len(suspicious),
            "suspicious_name_ratio": round(suspicious_ratio, 6),
            "publisher_conflict_count": len(conflicts),
            "publisher_conflict_ratio": round(conflict_ratio, 6),
            "articles_without_products_count": len(empty_articles),
        },
        "failures": failures,
        "warnings": warnings,
        "suspicious_names": suspicious,
        "conflicts": conflicts,
        "articles_without_products": empty_articles,
        "samples": {
            "parsed_products": rows[:10],
            "unknown_publishers": unknown[:10],
            "suspicious_names": suspicious[:10],
            "publisher_conflicts": conflicts[:10],
            "articles_without_products": empty_articles[:10],
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="按公众号文章提取产品与发行商归因。")
    parser.add_argument("--source-dir", default=str(SOURCE_DIR), help="WechatArticles 输出根目录。")
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--file-list", type=Path, help="只处理 manifest 中列出的 index.md 文件（默认要求）。")
    scope.add_argument(
        "--allow-full-scan",
        action="store_true",
        help="高风险显式开关：允许扫描 source-dir 全部 index.md。",
    )
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR), help="分析结果输出目录。")
    parser.add_argument("--account", action="append", default=[], help="限制处理的公众号账号，可重复传入。")
    parser.add_argument("--dry-run", action="store_true", help="只解析并打印摘要，不写分析产物。")
    return parser


def main():
    args = build_parser().parse_args()
    source_dir = Path(args.source_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    accounts = {a for a in args.account if a}

    all_articles = []
    publisher_product_map = defaultdict(list)   # publisher -> products
    publisher_article_map = defaultdict(list)   # publisher -> articles

    files = collect_article_files(
        source_dir,
        args.file_list,
        accounts,
        allow_full_scan=args.allow_full_scan,
    )
    print(f"共发现 {len(files)} 篇文章，开始解析...")

    for index_file in files:
        article = parse_article(index_file, source_dir=source_dir)
        all_articles.append(article)

        # 文章级：登记每个被提及的发行商 → 文章
        for pub in article["mentioned_publishers"]:
            publisher_article_map[pub].append({
                "title": article["title"],
                "account": article["account"],
                "date": article["date"],
                "url": article["url"],
                "is_single": article["is_single_publisher"],
            })

        # 产品级
        for product in article["products"]:
            pub = product["publisher"]
            publisher_product_map[pub].append({
                "article_title": article["title"],
                "account": article["account"],
                "article_date": article["date"],
                "product_name": product["name"],
                "description": product["description"],
                "publisher_candidates": product.get("publisher_candidates", []),
                "platforms": product.get("platforms", []),
                "links": product.get("links", []),
                "highlights": product.get("highlights", []),
                "differences": product.get("differences", []),
                "critique": product.get("critique", []),
                "url": article["url"],
            })

    total_products = sum(len(a["products"]) for a in all_articles)
    print(f"共提取 {total_products} 条产品记录")

    quality = build_quality_report(all_articles)

    # 发行商文章数排行
    sorted_by_articles = sorted(publisher_article_map.items(), key=lambda x: len(x[1]), reverse=True)
    sorted_by_products = sorted(publisher_product_map.items(), key=lambda x: len(x[1]), reverse=True)

    # ── 输出 JSON ──────────────────────────────────────────────────
    result = {
        "stats": {
            "total_articles": len(all_articles),
            "total_products": total_products,
            "publishers_by_article_count": len(publisher_article_map),
            "publishers_by_product_count": len(publisher_product_map),
            "source_dir": str(source_dir),
            "file_list": str(args.file_list.expanduser().resolve()) if args.file_list else "",
            "allow_full_scan": bool(args.allow_full_scan),
            "scope_mode": "file-list" if args.file_list else "full-scan-explicit",
            "accounts": sorted(accounts),
        },
        "publisher_article_coverage": {
            pub: {
                "article_count": len(articles),
                "articles": articles,
            }
            for pub, articles in sorted_by_articles
        },
        "publisher_products": {
            pub: items for pub, items in sorted_by_products
        },
        "quality": quality,
    }

    if args.dry_run:
        print(json.dumps({
            "dry_run": True,
            "stats": result["stats"],
            "quality": quality,
            "would_write": [
                str(output_dir / "_publisher_analysis.json"),
                str(output_dir / "_publisher_analysis.md"),
                str(output_dir / "_analysis_quality_report.json"),
            ],
        }, ensure_ascii=False, indent=2))
        return

    output_dir.mkdir(parents=True, exist_ok=True)
    output_json = output_dir / "_publisher_analysis.json"
    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"JSON 已写入: {output_json}")

    quality_json = output_dir / "_analysis_quality_report.json"
    with open(quality_json, "w", encoding="utf-8") as f:
        json.dump(quality, f, ensure_ascii=False, indent=2)
    print(f"质量报告已写入: {quality_json}")

    # ── 输出 Markdown 报告 ─────────────────────────────────────────
    output_md = output_dir / "_publisher_analysis.md"
    with open(output_md, "w", encoding="utf-8") as f:
        f.write("# 公众号文章产品来源分析报告\n\n")
        f.write(f"> 共 **{len(all_articles)}** 篇文章 · **{total_products}** 条产品记录\n\n")
        f.write(f"> 质量门禁：**{quality['status'].upper()}** · 未知发行商比例 "
                f"**{quality['metrics']['unknown_publisher_ratio']:.2%}** · "
                f"可疑名称 **{quality['metrics']['suspicious_name_count']}** · "
                f"发行商冲突 **{quality['metrics']['publisher_conflict_count']}**\n\n")

        # 一、发行商文章覆盖度排行
        f.write("## 一、发行商文章提及次数排行\n\n")
        f.write("（统计各发行商在全部文章中被提及的文章篇数，反映关注度）\n\n")
        f.write("| 排名 | 发行商 | 文章篇数 | 专题文章数 |\n|---|---|---|---|\n")
        for rank, (pub, articles) in enumerate(sorted_by_articles, 1):
            single_count = sum(1 for a in articles if a["is_single"])
            f.write(f"| {rank} | {pub} | {len(articles)} | {single_count} |\n")

        # 二、产品数量排行（已归因）
        known_by_products = [(p, items) for p, items in sorted_by_products if p != "未知"]
        f.write("\n## 二、发行商产品归因数量排行\n\n")
        f.write("（仅统计已成功归因到具体发行商的产品）\n\n")
        f.write("| 排名 | 发行商 | 归因产品数 | 唯一产品数 |\n|---|---|---|---|\n")
        for rank, (pub, items) in enumerate(known_by_products, 1):
            unique_names = len(set(i["product_name"] for i in items))
            f.write(f"| {rank} | {pub} | {len(items)} | {unique_names} |\n")

        # 三、各发行商产品明细
        f.write("\n## 三、各发行商产品明细\n\n")
        for pub, items in known_by_products:
            f.write(f"### {pub}\n\n")
            seen = {}
            for item in items:
                name = item["product_name"]
                if name in seen:
                    continue
                seen[name] = item
            for name, item in seen.items():
                desc = item["description"][:120] if item["description"] else ""
                f.write(f"- **{name}**")
                if desc:
                    f.write(f" — {desc}")
                f.write(f"\n  *({item['article_title'][:50]})*\n")
            f.write("\n")

        # 四、文章级发行商关联
        f.write("## 四、各发行商关联文章列表\n\n")
        for pub, articles in sorted_by_articles:
            f.write(f"### {pub}（提及 {len(articles)} 篇）\n\n")
            seen_titles = set()
            for a in articles:
                if a["title"] in seen_titles:
                    continue
                seen_titles.add(a["title"])
                tag = "【专题】" if a["is_single"] else ""
                f.write(f"- {tag}{a['title']}\n")
            f.write("\n")

    print(f"Markdown 报告已写入: {output_md}")

    # ── 打印摘要 ──────────────────────────────────────────────────
    print("\n=== 发行商文章提及数 TOP 15 ===")
    for pub, articles in sorted_by_articles[:15]:
        single = sum(1 for a in articles if a["is_single"])
        print(f"  {pub}: {len(articles)} 篇 (专题 {single} 篇)")

    print("\n=== 已归因产品数 TOP 15 (排除未知) ===")
    for pub, items in known_by_products[:15]:
        unique = len(set(i["product_name"] for i in items))
        print(f"  {pub}: {len(items)} 条记录 / {unique} 款唯一产品")


if __name__ == "__main__":
    main()

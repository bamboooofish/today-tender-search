"""Collect today's tender list directly from the official PCC website."""

from datetime import date, datetime, timedelta, timezone
from urllib.parse import urljoin
import re

import requests
from bs4 import BeautifulSoup


PCC_TODAY_URL = "https://web.pcc.gov.tw/prkms/today/common/todayTender"
TAIPEI_TZ = timezone(timedelta(hours=8))
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7",
}

# The official daily page separates the six tender types and their corrections.
PCC_CATEGORY_TYPES = {
    "label_type1_0": "公開招標公告",
    "label_type1_1": "經公開評選或公開徵求之限制性招標公告",
    "label_type1_2": "選擇性招標(建立合格廠商名單)公告",
    "label_type1_3": "選擇性招標(個案)公告",
    "label_type1_4": "選擇性招標後續邀標公告",
    "label_type1_5": "公開取得報價單或企劃書公告",
    "label_type2_0": "公開招標更正公告",
    "label_type2_1": "經公開評選或公開徵求之限制性招標更正公告",
    "label_type2_2": "選擇性招標(建立合格廠商名單)更正公告",
    "label_type2_3": "選擇性招標(個案)更正公告",
    "label_type2_4": "選擇性招標後續邀標更正公告",
    "label_type2_5": "公開取得報價單或企劃書更正公告",
}

ROC_DATE_PATTERN = re.compile(r"(?<!\d)(\d{2,3})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})")


def taipei_now():
    return datetime.now(TAIPEI_TZ)


def normalize(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def parse_deadline_date(value):
    """Convert a PCC ROC date such as 115/11/09 to an ISO date."""
    match = ROC_DATE_PATTERN.search(normalize(value))
    if not match:
        return ""

    year, month, day = map(int, match.groups())
    if year < 1911:
        year += 1911
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return ""


def parse_today_html(html, published_date=None):
    """Extract the selected announcement types from the official daily page."""
    soup = BeautifulSoup(html, "html.parser")
    category_tables = soup.select('table[id^="label_type"]')
    if not category_tables:
        raise ValueError("政府電子採購網頁面沒有今日標案分類資料。")

    collected_date = published_date or taipei_now().date().isoformat()
    items = []
    seen = set()
    found_result_table = False

    for category_table in category_tables:
        announcement_type = PCC_CATEGORY_TYPES.get(category_table.get("id", ""))
        if not announcement_type:
            continue

        result_table = category_table.find_next_sibling("table", attrs={"id": "row"})
        if result_table is None:
            continue
        found_result_table = True

        for row in result_table.select("tbody tr"):
            cells = row.find_all("td", recursive=False)
            if len(cells) < 5:
                continue

            agency = normalize(cells[1].get_text(" ", strip=True))
            title = normalize(cells[2].get_text(" ", strip=True))
            number_link = cells[3].find("a", href=True)
            case_number = normalize(
                number_link.get_text(" ", strip=True) if number_link else cells[3].get_text(" ", strip=True)
            )
            deadline = normalize(cells[4].get_text(" ", strip=True))
            if not agency or not title or not case_number or "無符合條件資料" in case_number:
                continue

            url = urljoin(PCC_TODAY_URL, number_link["href"]) if number_link else ""
            key = (agency, case_number, title, announcement_type)
            if key in seen:
                continue
            seen.add(key)

            item = {
                "agency": agency,
                "title": title,
                "id": case_number,
                "type": announcement_type,
                "date": collected_date,
                "deadline": deadline,
                "deadline_date": parse_deadline_date(deadline),
                "url": url,
            }
            items.append(item)

    if not found_result_table:
        raise ValueError("政府電子採購網頁面沒有今日標案結果表格。")
    return items


def collect_today():
    now = taipei_now()
    response = requests.get(PCC_TODAY_URL, headers=HEADERS, timeout=45)
    response.raise_for_status()
    items = parse_today_html(response.text, now.date().isoformat())
    return {
        "date": now.date().isoformat(),
        "collected_at": now.isoformat(timespec="seconds"),
        "status": "success",
        "items": items,
        "source": PCC_TODAY_URL,
    }

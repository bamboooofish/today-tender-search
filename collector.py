"""Collect today's tender announcements through the Apps Script JSON API."""

from datetime import date, datetime, timedelta, timezone

import requests


# Keep this deployment URL in sync with APPS_SCRIPT_URL in app.js.
APPS_SCRIPT_URL = (
    "https://script.google.com/macros/s/"
    "AKfycbz7lV7tuMMZNmATiEnY5RCfD3Tl6z0ePGUWmkNZTSQhqvoYSlk2EzM1hFaFJ6crPaHV/exec"
)
TENDER_LIST_API_URL = APPS_SCRIPT_URL + "?action=listbydate"
TAIPEI_TZ = timezone(timedelta(hours=8))
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "today-tender-search-archive/1.0",
}

# Match the announcement categories shown in the tender selection section.
TENDER_ANNOUNCEMENT_TYPES = frozenset(
    {
        "公開招標公告",
        "經公開評選或公開徵求之限制性招標公告",
        "選擇性招標(建立合格廠商名單)公告",
        "選擇性招標(個案)公告",
        "選擇性招標後續邀標公告",
        "公開取得報價單或企劃書公告",
        "公開招標更正公告",
        "經公開評選或公開徵求之限制性招標更正公告",
        "選擇性招標(建立合格廠商名單)更正公告",
        "選擇性招標(個案)更正公告",
        "選擇性招標後續邀標更正公告",
        "公開取得報價單或企劃書更正公告",
    }
)


def taipei_now():
    return datetime.now(TAIPEI_TZ)


def normalize(value):
    return " ".join(str(value or "").split())


def parse_api_date(value):
    """Convert the API's YYYYMMDD date to YYYY-MM-DD."""
    raw = normalize(value)
    if len(raw) == 8 and raw.isdigit():
        try:
            return datetime.strptime(raw, "%Y%m%d").date().isoformat()
        except ValueError:
            return ""
    if len(raw) == 10:
        try:
            return date.fromisoformat(raw).isoformat()
        except ValueError:
            return ""
    return ""


def collect_today():
    now = taipei_now()
    requested_date = now.strftime("%Y%m%d")
    collected_date = now.date().isoformat()
    response = requests.get(
        APPS_SCRIPT_URL,
        params={"action": "listbydate", "date": requested_date},
        headers=HEADERS,
        timeout=45,
    )
    response.raise_for_status()

    try:
        payload = response.json()
    except ValueError as error:
        raise ValueError("標案清單 API 回傳的內容不是有效 JSON。") from error

    if not isinstance(payload, dict):
        raise ValueError("標案清單 API 回傳格式錯誤。")
    if payload.get("error"):
        raise RuntimeError(normalize(payload["error"]))

    records = payload.get("records")
    if not isinstance(records, list):
        raise ValueError("標案清單 API 回應缺少 records 清單。")

    items = []
    seen = set()
    for record in records:
        if not isinstance(record, dict):
            continue

        brief = record.get("brief")
        if not isinstance(brief, dict):
            continue

        announcement_type = normalize(brief.get("type"))
        if announcement_type not in TENDER_ANNOUNCEMENT_TYPES:
            continue

        record_date = parse_api_date(record.get("date"))
        agency = normalize(record.get("unit_name"))
        title = normalize(brief.get("title"))
        case_number = normalize(record.get("job_number"))
        unit_id = normalize(record.get("unit_id"))
        filename = normalize(record.get("filename"))
        if (
            record_date != collected_date
            or not agency
            or not title
            or not case_number
            or not unit_id
            or not filename
        ):
            continue

        key = (agency, case_number, title, announcement_type)
        if key in seen:
            continue
        seen.add(key)

        items.append(
            {
                "agency": agency,
                "title": title,
                "id": case_number,
                "type": announcement_type,
                "date": record_date,
                "deadline": "",
                "deadline_date": "",
                "url": "",
                "unit_id": unit_id,
                "filename": filename,
            }
        )

    return {
        "date": collected_date,
        "collected_at": now.isoformat(timespec="seconds"),
        "status": "success",
        "items": items,
        "source": TENDER_LIST_API_URL,
    }

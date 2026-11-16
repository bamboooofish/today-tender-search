"""Create the production-only static files for GitHub Pages."""

from pathlib import Path
from datetime import date, datetime, timedelta, timezone
import re
import shutil
import json


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "dist"
LOCAL_ONLY_BLOCK = re.compile(
    r"^[ \t]*<!-- LOCAL-ONLY:START -->.*?<!-- LOCAL-ONLY:END -->[ \t]*\r?\n?",
    re.MULTILINE | re.DOTALL,
)
STATIC_FILES = ("styles.css", "app.js")
ARCHIVE = ROOT / "data" / "archive"
TAIPEI_TZ = timezone(timedelta(hours=8))
RETENTION_DAYS = 14


def clear_output_directory():
    root = ROOT.resolve()
    output = OUTPUT.resolve()
    if output.parent != root or output.name != "dist":
        raise RuntimeError("Refusing to clean a path outside the generated dist folder.")
    if OUTPUT.exists():
        for child in OUTPUT.iterdir():
            if child.is_symlink() or child.is_file():
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)
    else:
        OUTPUT.mkdir(parents=True)


def build():
    clear_output_directory()
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    html, removed_blocks = LOCAL_ONLY_BLOCK.subn("", html)
    if removed_blocks != 2:
        raise RuntimeError("Expected both local-only blocks in index.html.")
    if "local-test.js" in html or "collectToday" in html:
        raise RuntimeError("A local test control was left in the production HTML.")
    (OUTPUT / "index.html").write_text(html, encoding="utf-8")

    for name in STATIC_FILES:
        shutil.copy2(ROOT / name, OUTPUT / name)

    write_recent_data()

    print("Built GitHub Pages files in " + str(OUTPUT))
    print("Included: index.html, styles.css, app.js, data/recent.json")
    print("Excluded: Apps Script source, local test button, local-test.js, sample.json, server.py, data/archive/, data/latest.json")


def write_recent_data():
    today = datetime.now(TAIPEI_TZ).date()
    oldest = today - timedelta(days=RETENTION_DAYS - 1)
    collected_dates = set()
    items = []
    seen = set()

    if ARCHIVE.exists():
        for path in sorted(ARCHIVE.glob("????-??-??.json")):
            try:
                archived_date = date.fromisoformat(path.stem)
                if archived_date < oldest or archived_date > today:
                    continue
                snapshot = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, OSError, json.JSONDecodeError):
                continue
            if not isinstance(snapshot, dict) or snapshot.get("status") != "success":
                continue
            snapshot_date = archived_date.isoformat()
            collected_dates.add(snapshot_date)
            for source_item in snapshot.get("items", []):
                if not isinstance(source_item, dict):
                    continue
                item = dict(source_item)
                item["date"] = item.get("date") or snapshot_date
                key = (
                    item["date"],
                    item.get("agency", ""),
                    item.get("id", ""),
                    item.get("title", ""),
                    item.get("type", ""),
                )
                if key in seen:
                    continue
                seen.add(key)
                items.append(item)

    items.sort(key=lambda item: (item.get("date", ""), item.get("title", "")), reverse=True)
    all_dates = [
        (oldest + timedelta(days=offset)).isoformat()
        for offset in range(RETENTION_DAYS)
    ]
    payload = {
        "generated_at": datetime.now(TAIPEI_TZ).isoformat(timespec="seconds"),
        "from": oldest.isoformat(),
        "to": today.isoformat(),
        "collected_dates": sorted(collected_dates),
        "missing_dates": [value for value in all_dates if value not in collected_dates],
        "items": items,
    }
    serialized = json.dumps(payload, ensure_ascii=False) + "\n"
    source_output = ROOT / "data" / "recent.json"
    source_output.parent.mkdir(parents=True, exist_ok=True)
    source_output.write_text(serialized, encoding="utf-8")
    output = OUTPUT / "data" / "recent.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(serialized, encoding="utf-8")


if __name__ == "__main__":
    build()

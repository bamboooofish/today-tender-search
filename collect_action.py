"""Collect today's tender list and retain the latest 14 daily snapshots."""

from pathlib import Path
import json

from collector import PCC_TODAY_URL, collect_today, taipei_now


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "data" / "latest.json"
ARCHIVE = ROOT / "data" / "archive"


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def main():
    now = taipei_now()
    failed = False
    try:
        payload = collect_today()
    except Exception as error:
        failed = True
        payload = {
            "date": now.date().isoformat(),
            "collected_at": now.isoformat(timespec="seconds"),
            "status": "error",
            "message": "今日資料蒐集失敗，請稍後再查看。",
            "items": [],
            "source": PCC_TODAY_URL,
        }
        print("Collection failed: " + repr(error))
    else:
        print("Collected " + str(len(payload["items"])) + " announcement(s) for " + payload["date"])

    write_json(OUTPUT, payload)
    print("Wrote " + str(OUTPUT.relative_to(ROOT)))
    if failed:
        raise SystemExit(1)

    archive_path = ARCHIVE / (payload["date"] + ".json")
    write_json(archive_path, payload)
    print("Archived " + str(archive_path.relative_to(ROOT)))


if __name__ == "__main__":
    main()

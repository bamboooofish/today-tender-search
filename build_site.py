"""Create the production-only static files for GitHub Pages."""

from pathlib import Path
import re
import shutil


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "dist"
LOCAL_ONLY_BLOCK = re.compile(
    r"^[ \t]*<!-- LOCAL-ONLY:START -->.*?<!-- LOCAL-ONLY:END -->[ \t]*\r?\n?",
    re.MULTILINE | re.DOTALL,
)
STATIC_FILES = ("styles.css", "app.js")


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

    print("Built GitHub Pages files in " + str(OUTPUT))
    print("Included: index.html, styles.css, app.js")
    print("Excluded: Apps Script source, local test button, local-test.js, sample.json, server.py, data/latest.json")


if __name__ == "__main__":
    build()

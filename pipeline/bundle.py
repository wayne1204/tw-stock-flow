#!/usr/bin/env python3
"""
Build a single self-contained HTML file.

    python3 pipeline/bundle.py          ->  dist/taiex-atlas-standalone.html

Inlines ECharts, the merged dataset and detect.js into one file with no external
requests at all. That file opens straight from a phone's filesystem, works fully
offline, and can be moved around by Drive / email / USB without carrying a
directory structure or needing a web server.

The normal index.html is unchanged and still the thing to use on a desktop.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
DIST = os.path.join(ROOT, "dist")
VENDOR = os.path.join(ROOT, "vendor")

CDN_RE = re.compile(r'<script src="(https://cdn\.jsdelivr\.net/[^"]+)"></script>')
LOCAL_RE = re.compile(r'<script src="((?!https?:)[^"]+)"></script>')


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def safe(js):
    """
    A literal </script> inside inlined JS would close the tag early. Escaping the
    slash is invisible to the JS parser but stops the HTML parser terminating.
    """
    return js.replace("</script", "<\\/script")


def echarts_source(url):
    """Prefer the npm copy; otherwise download once and cache under vendor/."""
    local = os.path.join(ROOT, "node_modules", "echarts", "dist", "echarts.min.js")
    if os.path.exists(local):
        return read(local), "node_modules"

    cached = os.path.join(VENDOR, "echarts.min.js")
    if os.path.exists(cached):
        return read(cached), "vendor cache"

    print(f"  ECharts not found locally; downloading once from {url}")
    try:
        import requests
        r = requests.get(url, timeout=60)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        raise SystemExit(
            f"ERROR: could not obtain ECharts ({e}).\n"
            "Either run `npm install`, or place echarts.min.js in vendor/.")
    os.makedirs(VENDOR, exist_ok=True)
    with open(cached, "w", encoding="utf-8") as f:
        f.write(r.text)
    return r.text, "downloaded"


def main():
    html = read(os.path.join(WEB, "index.html"))

    data_js = os.path.join(WEB, "data", "taiex-daily.js")
    if not os.path.exists(data_js):
        raise SystemExit(
            "ERROR: web/data/taiex-daily.js not found — run `python3 pipeline/fetch_data.py` first.\n"
            "This build refuses to produce a page with no data rather than shipping "
            "an empty shell.")

    # 1. ECharts, from the CDN URL the page already references
    m = CDN_RE.search(html)
    if not m:
        raise SystemExit("ERROR: could not find the ECharts CDN tag in index.html")
    src, origin = echarts_source(m.group(1))
    html = html.replace(m.group(0), f"<script>{safe(src)}</script>", 1)
    print(f"  inlined ECharts ({len(src)//1024} KB, from {origin})")

    # 2. Every local <script src=...>
    for tag, rel in [(mm.group(0), mm.group(1)) for mm in LOCAL_RE.finditer(html)]:
        path = os.path.join(WEB, rel)
        if not os.path.exists(path):
            raise SystemExit(f"ERROR: {rel} referenced by index.html but not found")
        body = read(path)
        html = html.replace(tag, f"<script>{safe(body)}</script>", 1)
        print(f"  inlined {rel} ({len(body)//1024} KB)")

    if "<script src=" in html:
        leftover = re.findall(r'<script src="[^"]+"', html)
        raise SystemExit(f"ERROR: unresolved external script(s): {leftover}")

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, "taiex-atlas-standalone.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)

    size = os.path.getsize(out) / 1024
    print(f"\n  -> {out}  ({size:.0f} KB, fully self-contained)")
    print("     Copy it to a phone and open it; no server and no network needed.")


if __name__ == "__main__":
    main()

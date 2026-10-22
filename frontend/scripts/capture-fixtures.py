"""Refreshes src/test/fixtures/results.json with real DemoResults from a running lab.

    python3 -I frontend/scripts/capture-fixtures.py http://localhost:3900

Calls every catalog test path (and its "Do it wrong" mode when the demo has one), trims the
commands and rows to keep the file small, and writes the fixtures the visual tests render.
"""

import json
import pathlib
import re
import sys
import urllib.request

base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3900"
root = pathlib.Path(__file__).resolve().parent.parent
catalog = (root / "src/demos/catalog.js").read_text()
tests = re.findall(r"'?([a-z0-9-]+)'?: \{ test: \{ method: 'POST', path: '([^']+)'", catalog)
out = {}
for demo_id, path in tests:
    for mode in ("run", "mistake"):
        url = base + path + ((("&" if "?" in path else "?") + "mistake=true") if mode == "mistake" else "")
        body = json.load(urllib.request.urlopen(urllib.request.Request(url, method="POST"), timeout=120))
        if mode == "mistake" and body["data"].get("mode") != "mistake":
            continue
        body["commands"] = body["commands"][:3]
        for q in body["data"].get("queries", []):
            q["rows"] = q["rows"][:12]
        out[f"{demo_id}:{mode}"] = body
(root / "src/test/fixtures/results.json").write_text(json.dumps(out))
print(f"{len(out)} fixtures written")

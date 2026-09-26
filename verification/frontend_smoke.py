"""Verify the packaged React/FastAPI HTTP boundary without launching a browser."""
import json
import sys
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
from fastapi.testclient import TestClient
from app.controller import app, WEB_DIR


class AssetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = []
        self.has_root = False

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        self.has_root |= attrs.get("id") == "root"
        if tag == "script" and attrs.get("type") == "module":
            self.assets.append(attrs["src"])
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.assets.append(attrs["href"])


client = TestClient(app)
response = client.get("/")
assert response.status_code == 200, response.text
assert response.headers["cache-control"] == "no-cache"
parsed = AssetParser()
parsed.feed(response.text)
assert parsed.has_root and len(parsed.assets) >= 2, response.text
all_assets = sorted(set(parsed.assets) | {"/assets/" + p.name for p in (WEB_DIR / "assets").glob("*.js")})
for asset in all_assets:
    assert asset.startswith("/assets/") and "/assets/assets/" not in asset, asset
    resource = client.get(asset)
    assert resource.status_code == 200 and len(resource.content) > 100, asset
    assert "text/html" not in resource.headers["content-type"], asset
assert "unpkg.com" not in response.text
for path in ("/src/App.jsx", "/package.json", "/assets/%2e%2e/package.json"):
    assert client.get(path).status_code == 404, path
assert client.get("/api/config").status_code == 200
assert client.get("/api/config").json()["analysis_enabled"] is False
assert len(client.get("/api/datasets/real").json()["features"]) == 470
print(json.dumps({"packaged_react_fastapi": "passed", "assets": all_assets, "browser_used": False}))

"""HTTP checks for the FastAPI / React bundle boundary; no browser involved."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import controller


def test_unbuilt_frontend_reports_503_without_disabling_api(tmp_path, monkeypatch):
    monkeypatch.setattr(controller, "WEB_DIR", tmp_path / "unbuilt")
    client = TestClient(controller.app)
    response = client.get("/")
    assert response.status_code == 503
    assert "npm run build" in response.json()["detail"]
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/api/config").status_code == 200


def test_built_index_is_html_and_revalidated(tmp_path, monkeypatch):
    index = '<!doctype html><html><body><div id="root"></div></body></html>'
    (tmp_path / "index.html").write_text(index, encoding="utf-8")
    monkeypatch.setattr(controller, "WEB_DIR", tmp_path)
    response = TestClient(controller.app).get("/")
    assert response.status_code == 200
    assert response.text == index
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"


def test_assets_can_be_built_later_and_cannot_expose_source(tmp_path):
    assets = tmp_path / "dist" / "assets"
    app = FastAPI()
    app.mount("/assets", controller.FrontendAssets(directory=assets, check_dir=False))
    client = TestClient(app)
    assert client.get("/assets/index-fixture.js").status_code == 404

    assets.mkdir(parents=True)
    (assets / "index-fixture.js").write_text("console.log('compiled fixture');", encoding="utf-8")
    (assets.parent / "source.jsx").write_text("unpublished source", encoding="utf-8")
    response = client.get("/assets/index-fixture.js")
    assert response.status_code == 200
    assert "compiled fixture" in response.text
    assert "javascript" in response.headers["content-type"]
    assert client.get("/assets/%2e%2e/source.jsx").status_code == 404
    assert client.get("/source.jsx").status_code == 404
"""HTTP tests for the access module, independent of controller integration."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
import pytest

from app import access

SECRET = "test-only-guest-session-secret-32-bytes-minimum"
ORIGIN = "https://geoscope.example.test"


@pytest.fixture
def guest_app(monkeypatch):
    monkeypatch.setenv("APP_ACCESS_TOKEN", SECRET)
    monkeypatch.setenv("PUBLIC_ANALYSIS_ENABLED", "true")
    monkeypatch.setenv("PUBLIC_ORIGIN", ORIGIN)
    app = FastAPI()
    records = {"private": None}

    @app.get("/config")
    def config(request: Request):
        response = JSONResponse({"analysis_enabled": access.browser_access_enabled()})
        access.issue_session(request, response)
        return response

    @app.get("/whoami")
    def whoami(request: Request):
        return {"principal": access.identify(request)}

    @app.post("/records/{key}")
    def create_record(key: str, request: Request):
        principal = access.identify(request, mutation=True)
        records[key] = principal
        return {"created": True}

    @app.get("/records/{key}")
    def read_record(key: str, request: Request):
        principal = access.identify(request)
        access.assert_owner(records.get(key), principal)
        return {"record": key}

    return app


def client_for(app):
    return TestClient(app, base_url=ORIGIN)


def issue(client):
    response = client.get("/config")
    assert response.status_code == 200
    assert response.json()["analysis_enabled"] is True
    value = client.cookies.get(access.COOKIE_NAME)
    assert value
    return value, response


def test_cookie_is_opaque_protected_and_reused_without_renewal(guest_app):
    client = client_for(guest_app)
    token, first = issue(client)
    version, sid, issued, signature = token.split(".")
    assert version == "v1" and len(sid) == 64 and len(signature) == 64 and issued.isdigit()
    cookie = first.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    assert "path=/" in cookie and "max-age=86400" in cookie and "domain=" not in cookie
    assert first.headers["cache-control"] == "no-store"
    assert SECRET not in first.text and SECRET not in token
    second = client.get("/config")
    assert "set-cookie" not in second.headers
    assert client.cookies.get(access.COOKIE_NAME) == token
    assert client.get("/whoami").json()["principal"] == sid


def test_guest_ownership_isolated_and_private_records_require_bearer(guest_app):
    alice, bob = client_for(guest_app), client_for(guest_app)
    issue(alice)
    issue(bob)
    assert alice.post("/records/upload-a", headers={"Origin": ORIGIN}).status_code == 200
    assert alice.get("/records/upload-a").status_code == 200
    assert bob.get("/records/upload-a").status_code == 404
    assert alice.get("/records/private").status_code == 404
    assert bob.get("/records/private").status_code == 404
    assert bob.get("/records/upload-a", headers={"Authorization": f"Bearer {SECRET}"}).status_code == 200
    assert bob.get("/records/private", headers={"Authorization": f"Bearer {SECRET}"}).status_code == 200


@pytest.mark.parametrize("origin", [None, "null", "https://attacker.example", ORIGIN + "/", "http://geoscope.example.test"])
def test_guest_writes_require_exact_origin(guest_app, origin):
    client = client_for(guest_app)
    issue(client)
    headers = {} if origin is None else {"Origin": origin}
    assert client.post("/records/new", headers=headers).status_code == 403
    assert client.get("/records/new").status_code == 404


def test_guest_write_accepts_same_origin_and_rejects_conflicting_fetch_metadata(guest_app):
    client = client_for(guest_app)
    issue(client)
    assert client.post("/records/one", headers={"Origin": ORIGIN}).status_code == 200
    assert client.post("/records/two", headers={"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}).status_code == 200
    assert client.post("/records/three", headers={"Origin": ORIGIN, "Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_private_bearer_works_without_origin_or_public_mode(guest_app, monkeypatch):
    monkeypatch.setenv("PUBLIC_ANALYSIS_ENABLED", "false")
    client = client_for(guest_app)
    config = client.get("/config")
    assert config.json()["analysis_enabled"] is False
    assert "set-cookie" not in config.headers
    assert client.post("/records/private-new").status_code == 401
    assert client.post("/records/private-new", headers={"Authorization": f"Bearer {SECRET}"}).status_code == 200
    assert client.get("/whoami", headers={"Authorization": f"Bearer {SECRET}"}).json()["principal"] == "admin"


def test_invalid_bearer_does_not_fall_through_to_an_existing_guest(guest_app):
    client = client_for(guest_app)
    issue(client)
    assert client.post("/records/new", headers={"Origin": ORIGIN, "Authorization": "Bearer wrong"}).status_code == 401


def test_unsigned_tampered_malformed_and_missing_sessions_fail(guest_app):
    client = client_for(guest_app)
    valid, _ = issue(client)
    parts = valid.split(".")
    parts[1] = ("0" if parts[1][0] != "0" else "1") + parts[1][1:]
    modified_sid = ".".join(parts)
    for cookie in ("", "unsigned", "v1.bad.bad.bad", modified_sid, valid + "x", "x" * 300):
        anonymous = client_for(guest_app)
        response = anonymous.get("/whoami", headers={"Cookie": f"{access.COOKIE_NAME}={cookie}"})
        assert response.status_code == 401


def test_expired_and_future_sessions_fail_even_if_cookie_is_sent(guest_app, monkeypatch):
    original_time = access.time.time()
    client = client_for(guest_app)
    token, _ = issue(client)
    for now in (original_time + access.SESSION_TTL_SECONDS + 1, original_time - 60):
        monkeypatch.setattr(access.time, "time", lambda: now)
        response = client_for(guest_app).get("/whoami", headers={"Cookie": f"{access.COOKIE_NAME}={token}"})
        assert response.status_code == 401


def test_key_rotation_invalidates_existing_cookie(guest_app, monkeypatch):
    client = client_for(guest_app)
    original, _ = issue(client)
    monkeypatch.setenv("APP_ACCESS_TOKEN", "rotated-test-only-secret-at-least-32-bytes")
    assert client.get("/whoami").status_code == 401
    replacement, _ = issue(client)
    assert replacement != original


def test_http_local_development_cookie_is_not_secure(guest_app, monkeypatch):
    monkeypatch.setenv("PUBLIC_ORIGIN", "http://127.0.0.1:5173")
    client = TestClient(guest_app, base_url="http://127.0.0.1:5173")
    _, response = issue(client)
    assert "secure" not in response.headers["set-cookie"].lower()
    assert client.post("/records/dev", headers={"Origin": "http://127.0.0.1:5173"}).status_code == 200


@pytest.mark.parametrize("origin", [
    "", "null", "//geoscope.example.test", "ftp://geoscope.example.test",
    "https://user:password@geoscope.example.test", ORIGIN + "/path",
    ORIGIN + "?query=yes", ORIGIN + "#fragment", ORIGIN + ":99999",
    "https://bad host.example", "https://example.test\n.evil.example",
])
def test_invalid_origin_configuration_disables_browser_access(guest_app, monkeypatch, origin):
    monkeypatch.setenv("PUBLIC_ORIGIN", origin)
    client = client_for(guest_app)
    response = client.get("/config")
    assert response.json()["analysis_enabled"] is False
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("secret", ["", "short", " " * 40])
def test_missing_or_weak_secret_cannot_enable_browser_access(guest_app, monkeypatch, secret):
    monkeypatch.setenv("APP_ACCESS_TOKEN", secret)
    assert access.browser_access_enabled() is False
    response = client_for(guest_app).get("/config")
    assert "set-cookie" not in response.headers


def test_origin_configuration_canonicalizes_scheme_host_and_default_port(guest_app, monkeypatch):
    monkeypatch.setenv("PUBLIC_ORIGIN", "HTTPS://GeoScope.Example.Test:443/")
    client = client_for(guest_app)
    issue(client)
    assert client.post("/records/canonical", headers={"Origin": ORIGIN}).status_code == 200

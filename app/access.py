"""Server-only bearer authentication and signed public-demo guest sessions."""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import os
import re
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response

COOKIE_NAME = "geoscope_guest"
SESSION_TTL_SECONDS = 24 * 60 * 60
_CLOCK_SKEW_SECONDS = 30
_TOKEN_PART = re.compile(r"[a-f0-9]{64}\Z")


@dataclass(frozen=True)
class _PublicConfig:
    secret: bytes
    origin: str
    secure: bool


def _canonical_origin(value: str) -> str | None:
    value = value.strip()
    if not value or any(ord(character) < 33 for character in value):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            return None
        host = parsed.hostname.lower()
        if ":" in host:
            host = f"[{ipaddress.IPv6Address(host).compressed}]"
        else:
            host = host.encode("idna").decode("ascii")
            if len(host) > 253 or any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in host.split(".")
            ):
                return None
        port = parsed.port
        if port is not None and not 1 <= port <= 65535:
            return None
        default_port = 443 if parsed.scheme == "https" else 80
        suffix = f":{port}" if port is not None and port != default_port else ""
        return f"{parsed.scheme}://{host}{suffix}"
    except (ValueError, UnicodeError):
        return None


def _public_config() -> _PublicConfig | None:
    if os.getenv("PUBLIC_ANALYSIS_ENABLED", "").strip().lower() not in {"true", "1"}:
        return None
    secret = os.getenv("APP_ACCESS_TOKEN", "")
    # A randomly generated secret is required operationally. Reject common weak
    # configuration shapes without printing the configured value.
    if not 32 <= len(secret.encode("utf-8")) <= 4096 or any(character.isspace() for character in secret):
        return None
    origin = _canonical_origin(os.getenv("PUBLIC_ORIGIN", ""))
    if origin is None:
        return None
    return _PublicConfig(secret.encode("utf-8"), origin, origin.startswith("https://"))


def browser_access_enabled() -> bool:
    return _public_config() is not None


def _signature(sid: str, issued: str, secret: bytes) -> str:
    payload = f"geoscope-guest-v1:{sid}:{issued}".encode("ascii")
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def _read_session(value: str | None, config: _PublicConfig) -> str | None:
    if not value or len(value) > 256:
        return None
    parts = value.split(".")
    if len(parts) != 4:
        return None
    version, sid, issued, signature = parts
    if version != "v1" or not _TOKEN_PART.fullmatch(sid) or not _TOKEN_PART.fullmatch(signature):
        return None
    if not re.fullmatch(r"[0-9]{1,12}", issued):
        return None
    if not hmac.compare_digest(signature, _signature(sid, issued, config.secret)):
        return None
    now = int(time.time())
    issued_at = int(issued)
    if issued_at > now + _CLOCK_SKEW_SECONDS or now - issued_at >= SESSION_TTL_SECONDS:
        return None
    return sid


def identify(request: Request, authorization: str | None = None, *, mutation: bool = False) -> str:
    """Return admin for a valid private bearer or the signed guest session ID."""
    supplied = authorization if authorization is not None else request.headers.get("authorization")
    secret = os.getenv("APP_ACCESS_TOKEN", "")
    if supplied is not None:
        expected = f"Bearer {secret}".encode("utf-8")
        if secret and len(supplied) <= 8192 and hmac.compare_digest(supplied.encode("utf-8"), expected):
            return "admin"
        raise HTTPException(401, "Invalid bearer authentication.")

    config = _public_config()
    if config is None:
        if not secret:
            raise HTTPException(503, "Analysis access is not configured.")
        raise HTTPException(401, "Private API bearer authentication is required.")
    sid = _read_session(request.cookies.get(COOKIE_NAME), config)
    if sid is None:
        raise HTTPException(401, "A valid guest session is required. Reload the application.")
    if mutation:
        if request.headers.get("origin") != config.origin:
            raise HTTPException(403, "Guest writes require the configured same-origin application.")
        fetch_site = request.headers.get("sec-fetch-site")
        if fetch_site is not None and fetch_site != "same-origin":
            raise HTTPException(403, "Cross-origin guest writes are not allowed.")
    return sid


def issue_session(request: Request, response: Response) -> None:
    """Issue an opaque host-only guest cookie without exposing the API key."""
    response.headers["Cache-Control"] = "no-store"
    config = _public_config()
    if config is None or _read_session(request.cookies.get(COOKIE_NAME), config) is not None:
        return
    sid = secrets.token_hex(32)
    issued = str(int(time.time()))
    value = f"v1.{sid}.{issued}.{_signature(sid, issued, config.secret)}"
    response.set_cookie(
        COOKIE_NAME, value, max_age=SESSION_TTL_SECONDS, path="/",
        secure=config.secure, httponly=True, samesite="strict",
    )


def assert_owner(owner: str | None, principal: str) -> None:
    """Private bearer callers may access all records; guests need an exact owner."""
    if principal == "admin":
        return
    if isinstance(owner, str) and owner and isinstance(principal, str) and hmac.compare_digest(
        owner.encode("utf-8"), principal.encode("utf-8")
    ):
        return
    raise HTTPException(404, "Resource not found.")

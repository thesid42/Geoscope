from __future__ import annotations

import hmac
import base64
import os
import threading
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.sandbox import SandboxFailure, SandboxUnavailable, cleanup_stale_jobs, execute, inspect_data, runtime_ready

app = FastAPI(title="Park Access Isolated Worker", docs_url=None, redoc_url=None)
WORKER_TOKEN = os.getenv("WORKER_TOKEN", "")
MAX_REQUEST_BYTES = 25 * 1024 * 1024
JOB_SLOTS = threading.BoundedSemaphore(2)
REQUEST_SLOTS = threading.BoundedSemaphore(2)


@app.on_event("startup")
def cleanup_old_sandboxes():
    cleanup_stale_jobs()


@app.middleware("http")
async def request_guard(request: Request, call_next):
    if request.url.path in {"/execute", "/inspect"}:
        auth = request.headers.get("authorization")
        if not WORKER_TOKEN or not auth or not hmac.compare_digest(auth, f"Bearer {WORKER_TOKEN}"):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        if not REQUEST_SLOTS.acquire(blocking=False):
            return JSONResponse({"detail": "Worker is at its request limit."}, status_code=429)
        try:
            return await _read_limited_worker_request(request, call_next)
        finally:
            REQUEST_SLOTS.release()
    return await call_next(request)


async def _read_limited_worker_request(request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > MAX_REQUEST_BYTES:
                    return JSONResponse({"detail": "Request exceeds the worker input limit."}, status_code=413)
            except ValueError:
                return JSONResponse({"detail": "Invalid content length."}, status_code=400)
        received = 0
        body_parts = []
        more = True
        while more:
            message = await request.receive()
            if message["type"] != "http.request":
                return JSONResponse({"detail": "Invalid request body."}, status_code=400)
            part = message.get("body", b"")
            received += len(part)
            if received > MAX_REQUEST_BYTES:
                return JSONResponse({"detail": "Request exceeds the worker input limit."}, status_code=413)
            body_parts.append(part)
            more = message.get("more_body", False)
        body = b"".join(body_parts)
        sent = False
        async def receive_buffered():
            nonlocal sent
            if sent:
                return {"type": "http.request", "body": b"", "more_body": False}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        request._receive = receive_buffered
        return await call_next(request)


class ExecuteRequest(BaseModel):
    code: str = Field(max_length=512_000)
    data: dict[str, Any]
    timeout_seconds: int = Field(default=90, ge=1, le=180)


class InspectRequest(BaseModel):
    data: dict[str, Any]
    timeout_seconds: int = Field(default=90, ge=1, le=180)


def authorize(value: str | None) -> None:
    if not WORKER_TOKEN or not value or not hmac.compare_digest(value, f"Bearer {WORKER_TOKEN}"):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
def health():
    ready, message = runtime_ready()
    return {"ok": ready, "sandbox": message}


@app.post("/execute")
def run(req: ExecuteRequest, authorization: str | None = Header(default=None)):
    authorize(authorization)
    if not JOB_SLOTS.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Worker is at its concurrent job limit.")
    try:
        output = execute(req.code, req.data, timeout_seconds=req.timeout_seconds)
        return {"result": output["result"], "artifacts": {name: base64.b64encode(content).decode("ascii") for name, content in output["artifacts"].items()}, "stdout": output["stdout"], "stderr": output["stderr"], "verified_against_reference": output["verified_against_reference"]}
    except SandboxUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SandboxFailure as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc), "stderr": exc.stderr[-16000:], "stdout": exc.stdout[-16000:], "timed_out": exc.timed_out}) from exc
    finally:
        JOB_SLOTS.release()


@app.post("/inspect")
def inspect(req: InspectRequest, authorization: str | None = Header(default=None)):
    authorize(authorization)
    if not JOB_SLOTS.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Worker is at its concurrent job limit.")
    try:
        return {"inspection": inspect_data(req.data, timeout_seconds=req.timeout_seconds), "reference_verified": True}
    except SandboxUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SandboxFailure as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc), "stderr": exc.stderr[-16000:], "stdout": exc.stdout[-16000:], "timed_out": exc.timed_out}) from exc
    finally:
        JOB_SLOTS.release()

from __future__ import annotations

import json
import base64
import math
import os
import platform
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any


MAX_INPUT_BYTES = 24 * 1024 * 1024
MAX_OUTPUT_BYTES = 12 * 1024 * 1024
MAX_LOG_BYTES = 64 * 1024
IMAGE = os.getenv("SANDBOX_IMAGE", "parkscope-sandbox:local")
_cleanup_failure: str | None = None


class SandboxUnavailable(RuntimeError):
    def __init__(self, message: str, *, stderr: str = "", stdout: str = ""):
        super().__init__(message)
        self.stderr = stderr
        self.stdout = stdout


class SandboxFailure(RuntimeError):
    def __init__(self, message: str, *, stderr: str = "", stdout: str = "", timed_out: bool = False):
        super().__init__(message)
        self.stderr = stderr
        self.stdout = stdout
        self.timed_out = timed_out


def _docker(*args: str, timeout: float = 5) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SandboxUnavailable(f"Docker is unavailable: {exc}") from exc


def runtime_ready() -> tuple[bool, str]:
    if _cleanup_failure:
        return False, f"Sandbox worker is quarantined after a cleanup failure: {_cleanup_failure}"
    if platform.system() != "Linux":
        return False, "Isolated analysis requires Linux with Docker and the gVisor runsc runtime."
    try:
        info = _docker("info", "--format", "{{json .Runtimes}}")
    except SandboxUnavailable as exc:
        return False, str(exc)
    if info.returncode != 0:
        return False, "Docker daemon is unavailable or inaccessible."
    try:
        runtimes = json.loads(info.stdout)
    except json.JSONDecodeError:
        return False, "Could not inspect Docker runtimes."
    if "runsc" not in runtimes:
        return False, "The Docker daemon does not advertise the required gVisor runsc runtime."
    image = _docker("image", "inspect", IMAGE, "--format", "{{.Id}}")
    if image.returncode != 0:
        return False, f"Required sandbox image {IMAGE!r} is not installed. Build Dockerfile.sandbox on the worker."
    return True, "gVisor runsc and sandbox image are ready."


def cleanup_stale_jobs() -> None:
    listed = _docker("ps", "--all", "--quiet", "--filter", "label=park-agent.managed=true", timeout=8)
    if listed.returncode != 0:
        raise SandboxUnavailable("Could not inspect prior sandbox containers during worker startup.")
    for container_id in listed.stdout.split():
        removed = _docker("rm", "--force", container_id, timeout=8)
        if removed.returncode != 0:
            still_exists = _docker("inspect", container_id, timeout=4)
            absent = still_exists.returncode != 0 and any(marker in still_exists.stderr.lower() for marker in ("no such object", "no such container"))
            if not absent:
                raise SandboxUnavailable("Could not remove an orphaned sandbox container.")


class _BoundedPipe:
    def __init__(self, pipe, limit: int):
        self.data = bytearray()
        self.truncated = False
        self.pipe = pipe
        self.limit = limit
        self.thread = threading.Thread(target=self._drain, daemon=True)
        self.thread.start()

    def _drain(self) -> None:
        while True:
            chunk = self.pipe.read(8192)
            if not chunk:
                return
            remaining = self.limit - len(self.data)
            if remaining > 0:
                self.data.extend(chunk[:remaining])
            if len(chunk) > remaining:
                self.truncated = True

    def text(self) -> str:
        self.thread.join(timeout=2)
        value = self.data.decode("utf-8", errors="replace")
        return value + ("\n[output truncated]" if self.truncated else "")


def execute(code: str, data: dict[str, Any], *, timeout_seconds: int = 90) -> dict[str, Any]:
    from app.reference import REFERENCE_CODE

    try:
        reference = _execute_once(REFERENCE_CODE, data, timeout_seconds=timeout_seconds)
    except SandboxFailure as exc:
        raise SandboxFailure("Trusted dataset inspection failed before generated analysis.", stderr=exc.stderr, stdout=exc.stdout, timed_out=exc.timed_out) from exc
    actual = _execute_once(code, data, timeout_seconds=timeout_seconds)
    try:
        _verify_result(actual["result"], reference["result"])
        _verify_map(actual["artifacts"].get("result.geojson"), reference["artifacts"].get("result.geojson"), data)
    except SandboxFailure as exc:
        exc.stderr = actual["stderr"]
        exc.stdout = actual["stdout"]
        raise
    clean = {"mode": actual["result"]["mode"], "metrics": actual["result"]["metrics"], "reference_verified": True}
    if "comparison" in reference["result"]:
        clean["comparison"] = reference["result"]["comparison"]
    actual["result"] = clean
    actual["artifacts"]["result.json"] = json.dumps(clean, allow_nan=False, separators=(",", ":")).encode()
    actual["verified_against_reference"] = True
    return actual


def inspect_data(data: dict[str, Any], *, timeout_seconds: int = 90) -> dict[str, Any]:
    from app.reference import REFERENCE_CODE

    try:
        inspected = _execute_once(REFERENCE_CODE, data, timeout_seconds=timeout_seconds)
    except SandboxFailure as exc:
        raise SandboxFailure("Trusted dataset inspection failed before any model request.", stderr=exc.stderr, stdout=exc.stdout, timed_out=exc.timed_out) from exc
    return inspected["result"]


def _execute_once(code: str, data: dict[str, Any], *, timeout_seconds: int = 90) -> dict[str, Any]:
    if len(code.encode("utf-8")) > 512_000:
        raise SandboxFailure("Generated script exceeds the 512 KiB limit.")
    input_bytes = json.dumps(data, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(input_bytes) > MAX_INPUT_BYTES:
        raise SandboxFailure("Analysis input exceeds the configured size limit.")
    available, message = runtime_ready()
    if not available:
        raise SandboxUnavailable(message)
    job_id = uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="park-job-") as temp:
        root = Path(temp)
        incoming = root / "input"
        output = root / "output"
        incoming.mkdir(mode=0o700)
        output.mkdir(mode=0o700)
        (incoming / "analysis.py").write_text(code, encoding="utf-8")
        (incoming / "request.json").write_bytes(input_bytes)
        os.chmod(incoming, 0o755)
        os.chmod(incoming / "analysis.py", 0o444)
        os.chmod(incoming / "request.json", 0o444)
        # Output lives only in an inode- and byte-bounded tmpfs inside the container.
        # Keep an idle container alive while the trusted worker copies two allowlisted files.
        command = [
            "docker", "create", "--name", f"park-agent-{job_id}", "--runtime=runsc",
            "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--user=10001:10001", "--cpus=1", "--memory=768m", "--memory-swap=768m",
            "--pids-limit=64", "--ulimit", "nofile=64:64", "--ulimit", "fsize=12582912:12582912",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001",
            "--tmpfs", "/output:rw,noexec,nosuid,nodev,size=16m,nr_inodes=128,uid=10001,gid=10001",
            "--mount", f"type=bind,src={incoming},dst=/input,readonly",
            "--label", "park-agent.managed=true", "--entrypoint", "python", IMAGE,
            "-I", "-c", f"import time; time.sleep({max(1, timeout_seconds)+90})",
        ]
        container_id: str | None = None
        proc: subprocess.Popen | None = None
        try:
            created = _docker(*command[1:], timeout=10)
            if created.returncode != 0 or not created.stdout.strip():
                raise SandboxUnavailable("Docker could not create an isolated runsc container.")
            container_id = created.stdout.strip().splitlines()[0]
            inspected = _docker("inspect", container_id, timeout=10)
            try:
                container_spec = json.loads(inspected.stdout)[0]
                cfg = container_spec["HostConfig"]
            except (IndexError, KeyError, json.JSONDecodeError) as exc:
                raise SandboxUnavailable("Could not inspect the created sandbox configuration.") from exc
            if not _secure_config(cfg, container_spec):
                raise SandboxUnavailable("Created container did not retain the required gVisor and resource isolation settings.")
            started = _docker("start", container_id, timeout=10)
            if started.returncode != 0:
                raise SandboxUnavailable("Docker could not start the isolated runsc container.")
            proc = subprocess.Popen(["docker", "exec", container_id, "python", "-I", "/input/analysis.py"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
            stdout = _BoundedPipe(proc.stdout, MAX_LOG_BYTES)
            stderr = _BoundedPipe(proc.stderr, MAX_LOG_BYTES)
            try:
                proc.wait(timeout=max(1, timeout_seconds))
            except subprocess.TimeoutExpired as exc:
                proc.kill()
                proc.wait(timeout=3)
                raise SandboxFailure("Sandbox exceeded its wall-time limit and was terminated.", stderr=stderr.text(), stdout=stdout.text(), timed_out=True) from exc
            out_text, err_text = stdout.text(), stderr.text()
            if proc.returncode != 0:
                raise SandboxFailure("Generated analysis exited with an error.", stderr=err_text, stdout=out_text)
            extract = _exec_extractor(container_id)
            artifact_paths = extract
        except SandboxFailure:
            if container_id:
                _docker("kill", container_id, timeout=4)
            raise
        finally:
            if proc is not None and proc.poll() is None:
                proc.kill()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
            # The generated deterministic name also cleans up if `docker create` timed out
            # after the daemon made the container but before returning its ID.
            active_error = __import__("sys").exc_info()[1]
            try:
                removed = _docker("rm", "--force", f"park-agent-{job_id}", timeout=8)
                if removed.returncode != 0:
                    still_exists = _docker("inspect", f"park-agent-{job_id}", timeout=4)
                    absent = still_exists.returncode != 0 and any(marker in still_exists.stderr.lower() for marker in ("no such object", "no such container"))
                    if not absent:
                        raise SandboxUnavailable("The worker could not remove the completed sandbox container.")
            except SandboxUnavailable as cleanup_error:
                global _cleanup_failure
                message = f"Sandbox cleanup failed; the worker must be taken out of service. {cleanup_error}"
                if active_error:
                    message += f" Original task error: {active_error}"
                _cleanup_failure = message
                raise SandboxUnavailable(message, stderr=getattr(active_error, "stderr", ""), stdout=getattr(active_error, "stdout", "")) from cleanup_error
        if "result.json" not in artifact_paths:
            raise SandboxFailure("Generated analysis did not create result.json.", stderr=err_text, stdout=out_text)
        try:
            result = json.loads(artifact_paths["result.json"])
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SandboxFailure("Generated result.json was not valid JSON.", stderr=err_text, stdout=out_text) from exc
        return {"result": result, "artifacts": artifact_paths, "stdout": out_text, "stderr": err_text}


_EXTRACTOR = r'''import base64,json,os,signal,stat,time
me=os.getpid()
for item in os.listdir('/proc'):
    if not item.isdigit() or int(item) in (1,me): continue
    try: os.kill(int(item),signal.SIGKILL)
    except (ProcessLookupError,PermissionError): pass
time.sleep(.05)
files={}; total=0
for name in ('result.json','result.geojson'):
    path='/output/'+name
    try: fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError: continue
    except OSError: raise SystemExit('allowlisted output is not a safe regular file')
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>12582912: raise SystemExit('output is not a bounded regular file')
        total+=st.st_size
        if total>12582912: raise SystemExit('total output limit exceeded')
        chunks=[]; left=st.st_size
        while left:
            chunk=os.read(fd,min(left,65536))
            if not chunk: raise SystemExit('short output read')
            chunks.append(chunk); left-=len(chunk)
        files[name]=base64.b64encode(b''.join(chunks)).decode('ascii')
    finally: os.close(fd)
print(json.dumps(files,separators=(',',':')))
'''


def _exec_extractor(container_id: str) -> dict[str, bytes]:
    try:
        proc = subprocess.Popen(["docker", "exec", container_id, "python", "-I", "-c", _EXTRACTOR], stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
    except OSError as exc:
        raise SandboxFailure("Could not start bounded artifact extraction.") from exc
    stdout = _BoundedPipe(proc.stdout, MAX_OUTPUT_BYTES * 2)
    stderr = _BoundedPipe(proc.stderr, 16_000)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired as exc:
        proc.kill()
        proc.wait(timeout=3)
        raise SandboxFailure("Bounded artifact extraction timed out.", stderr=stderr.text()) from exc
    out, err = stdout.text(), stderr.text()
    if stdout.truncated or proc.returncode != 0:
        raise SandboxFailure("Sandbox artifacts were unsafe or could not be collected.", stderr=err, stdout=out)
    try:
        encoded = json.loads(out, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(f"non-finite {x}")))
        if not isinstance(encoded, dict) or set(encoded) - {"result.json", "result.geojson"}:
            raise ValueError("unexpected artifact key")
        decoded = {name: base64.b64decode(value, validate=True) for name, value in encoded.items()}
        if any(len(value) > MAX_OUTPUT_BYTES for value in decoded.values()) or sum(map(len, decoded.values())) > MAX_OUTPUT_BYTES:
            raise ValueError("artifact byte limit exceeded")
        return decoded
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        raise SandboxFailure("Sandbox artifact envelope was malformed.", stderr=err, stdout=out) from exc


def _verify_result(actual: Any, expected: Any) -> None:
    if not isinstance(actual, dict) or actual.get("mode") != expected.get("mode"):
        raise SandboxFailure("Generated result mode did not match the requested analysis.")
    if not isinstance(actual.get("metrics"), dict):
        raise SandboxFailure("Generated metrics were missing.")
    if set(actual["metrics"]) != set(expected["metrics"]):
        raise SandboxFailure("Generated metric fields did not match the verified schema.")

    def compare(got: Any, want: Any, path: str) -> None:
        if isinstance(want, dict):
            if not isinstance(got, dict) or set(got) != set(want):
                raise SandboxFailure(f"Generated metric object {path} did not match the verified schema.")
            for key in want:
                compare(got[key], want[key], f"{path}.{key}")
        elif isinstance(want, bool) or want is None or isinstance(want, str):
            if type(got) is not type(want) or got != want:
                raise SandboxFailure(f"Generated metric {path} did not match the trusted reference.")
        elif isinstance(want, (int, float)):
            if isinstance(got, bool) or not isinstance(got, (int, float)) or not math.isfinite(got):
                raise SandboxFailure(f"Generated metric {path} was not a finite number.")
            tolerance = 0 if isinstance(want, int) else 0.05
            if abs(got - want) > tolerance:
                raise SandboxFailure(f"Generated metric {path} differed from the trusted reference.")
        else:
            raise SandboxFailure(f"Unsupported trusted metric type at {path}.")

    compare(actual["metrics"], expected["metrics"], "metrics")
    if expected.get("comparison") is not None and actual.get("comparison") != expected["comparison"]:
        raise SandboxFailure("Generated candidate ranking did not match the trusted reference.")


def _verify_map(actual_bytes: bytes | None, expected_bytes: bytes | None, request: dict[str, Any]) -> None:
    if not actual_bytes or not expected_bytes:
        raise SandboxFailure("Generated population map was missing.")
    try:
        actual = json.loads(actual_bytes, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(f"non-finite {x}")))
        expected = json.loads(expected_bytes, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(f"non-finite {x}")))
        if not isinstance(actual, dict) or not isinstance(expected, dict):
            raise ValueError("GeoJSON root is not an object")
        if actual.get("type") != "FeatureCollection" or expected.get("type") != "FeatureCollection":
            raise ValueError("type")
        a_features, e_features = actual["features"], expected["features"]
        if not isinstance(a_features, list) or not isinstance(e_features, list) or len(a_features) != len(e_features):
            raise ValueError("feature count")
        metric_key = "inside_zone" if request.get("analysis_mode") == "exposure" else "nearest_m"
        for got, want in zip(a_features, e_features):
            if not isinstance(got, dict) or not isinstance(want, dict):
                raise ValueError("feature is not an object")
            if got.get("type") != "Feature" or got.get("id") != want.get("id") or got.get("geometry") != want.get("geometry"):
                raise ValueError("feature identity or geometry")
            gp, wp = got.get("properties"), want.get("properties")
            if not isinstance(gp, dict) or not isinstance(wp, dict) or set(gp) != set(wp) or gp.get(metric_key) is None:
                raise ValueError("missing metric property")
            if metric_key == "nearest_m":
                value = gp[metric_key]
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value-wp[metric_key]) > 0.05:
                    raise ValueError("distance")
                if gp.get("underserved") is not wp.get("underserved"):
                    raise ValueError("threshold flag")
                for key in wp.keys() - {"nearest_m", "underserved"}:
                    if gp[key] != wp[key]:
                        raise ValueError("source properties")
            elif gp[metric_key] is not wp[metric_key]:
                raise ValueError("zone flag")
            elif any(gp[k] != wp[k] for k in wp.keys() - {"inside_zone"}):
                raise ValueError("source properties")
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise SandboxFailure(f"Generated map did not match trusted per-feature results: {exc}") from exc


def _secure_config(config: dict[str, Any], container: dict[str, Any] | None = None) -> bool:
    security_options = config.get("SecurityOpt") or []
    no_new_privileges = any(option in {"no-new-privileges", "no-new-privileges:true"} for option in security_options)
    basic = (
        config.get("Runtime") == "runsc"
        and config.get("NetworkMode") == "none"
        and config.get("ReadonlyRootfs") is True
        and config.get("Privileged") is False
        and config.get("CapDrop") == ["ALL"]
        and config.get("Memory") == 768 * 1024 * 1024
        and config.get("MemorySwap") == 768 * 1024 * 1024
        and config.get("NanoCpus") == 1_000_000_000
        and config.get("PidsLimit") == 64
        and no_new_privileges
    )
    if not basic:
        return False
    if container is None:
        return True
    config_info = container.get("Config") or {}
    mounts = container.get("Mounts") or []
    safe_input = [m for m in mounts if m.get("Destination") == "/input" and m.get("Type") == "bind" and m.get("RW") is False]
    safe_other_mounts = all(
        (m.get("Destination") == "/input" and m.get("Type") == "bind" and m.get("RW") is False)
        or (m.get("Destination") in {"/tmp", "/output"} and m.get("Type") == "tmpfs")
        for m in mounts
    )
    tmpfs = config.get("Tmpfs") or {}
    secrets_in_env = any(re.search(r"(TOKEN|SECRET|PASSWORD|API.?KEY)", str(item).split("=", 1)[0], re.I) for item in config_info.get("Env", []))
    return (
        config_info.get("User") == "10001:10001"
        and not secrets_in_env
        and len(safe_input) == 1
        and safe_other_mounts
        and "/output" in tmpfs and "noexec" in tmpfs["/output"] and "size=16m" in tmpfs["/output"]
        and "/tmp" in tmpfs and "noexec" in tmpfs["/tmp"]
        and not config.get("Devices")
        and not config.get("DeviceRequests")
        and not config.get("Binds")
    )

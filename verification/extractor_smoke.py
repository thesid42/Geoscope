"""Trusted local Docker plumbing test; explicitly NOT a gVisor containment test.

Runs only the fixed fixtures below in runc containers with no host mounts. It
never calls the application's generated-code executor or changes Docker config.
"""
from __future__ import annotations

import json
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.sandbox import IMAGE, MAX_OUTPUT_BYTES, SandboxFailure, _exec_extractor


def docker(*args: str, timeout: int = 20, check: bool = True):
    value = subprocess.run(["docker", *args], capture_output=True, text=True,
                           timeout=timeout, shell=False)
    if check and value.returncode:
        raise RuntimeError(f"Docker {args[0]} failed: {value.stderr[:1000]}")
    return value


def main():
    name = "geoscope-plumbing-" + uuid.uuid4().hex
    report = {
        "scope": "Trusted fixed-code artifact plumbing only; NOT gVisor containment or a live agent run",
        "runtime": "runc", "image": IMAGE,
        "started_at": datetime.now(timezone.utc).isoformat(), "checks": [],
    }
    cleanup_ok = False
    try:
        docker("create", "--name", name, "--runtime=runc", "--network=none",
               "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
               "--user=10001:10001", "--cpus=0.5", "--memory=192m",
               "--memory-swap=192m", "--pids-limit=64",
               "--tmpfs", "/output:rw,noexec,nosuid,nodev,size=16m,nr_inodes=128,uid=10001,gid=10001",
               "--label", "geoscope.verification=true", "--entrypoint", "python", IMAGE,
               "-I", "-c", "import time; time.sleep(300)")
        configuration = json.loads(docker("inspect", name).stdout)[0]
        assert configuration["HostConfig"]["Runtime"] == "runc"
        assert configuration["HostConfig"]["NetworkMode"] == "none"
        assert not configuration["HostConfig"].get("Binds")
        assert not configuration["HostConfig"].get("Mounts")
        docker("start", name)

        def fixture(code):
            docker("exec", name, "python", "-I", "-c", code)

        fixture("import json; "
                "open('/output/result.json','w').write(json.dumps({'fixture':True,'value':42})); "
                "open('/output/result.geojson','w').write(json.dumps({'type':'FeatureCollection','features':[], 'fixture_padding':'x'*1048576}))")
        artifacts = _exec_extractor(name)
        assert json.loads(artifacts["result.json"]) == {"fixture": True, "value": 42}
        assert len(json.loads(artifacts["result.geojson"])["fixture_padding"]) == 1048576
        report["checks"].append({"name": "tmpfs base64 round trip over 1 MiB", "passed": True,
                                 "artifact_bytes": {k: len(v) for k, v in artifacts.items()}})

        fixtures = [
            ("reject symlink", "import os; os.symlink('/etc/passwd','/output/result.json')"),
            ("reject hardlink", "import os; open('/output/original','w').write('{}'); os.link('/output/original','/output/result.json')"),
            ("reject FIFO without blocking", "import os; os.mkfifo('/output/result.json')"),
            ("reject oversized single artifact", f"open('/output/result.json','wb').truncate({MAX_OUTPUT_BYTES + 1})"),
            ("reject combined artifact bytes", "open('/output/result.json','wb').truncate(7*1024*1024); open('/output/result.geojson','wb').truncate(7*1024*1024)"),
        ]
        for label, code in fixtures:
            fixture("import os; [os.unlink('/output/'+n) for n in os.listdir('/output')]")
            fixture(code)
            try:
                _exec_extractor(name)
            except SandboxFailure as exc:
                report["checks"].append({"name": label, "passed": True, "error": str(exc)})
            else:
                raise AssertionError(f"Unsafe fixture was accepted: {label}")
    finally:
        removed = docker("rm", "--force", name, check=False)
        remaining = docker("ps", "-a", "--filter", f"name=^/{name}$", "--format", "{{.Names}}")
        cleanup_ok = not remaining.stdout.strip()
        report["cleanup_confirmed"] = cleanup_ok
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        report["passed"] = cleanup_ok and len(report["checks"]) == 6
        (ROOT / "verification" / "extractor-smoke.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    assert cleanup_ok, "Plumbing probe container was not removed"
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

import json
import io
import subprocess

import pytest

from app import sandbox
from app.sandbox import SandboxFailure, SandboxUnavailable, _secure_config, _verify_map, _verify_result


@pytest.mark.parametrize("mode,metrics,comparison", [
    ("access", {"analysis_crs": "EPSG:32610", "threshold_m": 400, "population_total": 600, "population_features": 3, "service_features": 1, "baseline": {"served_population": 100, "underserved_population": 500, "weighted_mean_nearest_m": 633.33}}, None),
    ("compare", {"analysis_crs": "EPSG:32610", "threshold_m": 400, "population_total": 600, "population_features": 3, "service_features": 1, "baseline": {"served_population": 100, "underserved_population": 500, "weighted_mean_nearest_m": 633.33}, "candidate_a": {"served_population": 600, "newly_served_population": 500, "weighted_mean_nearest_m": 200.0, "weighted_mean_distance_reduction_m": 433.33}, "candidate_b": {"served_population": 300, "newly_served_population": 200, "weighted_mean_nearest_m": 466.67, "weighted_mean_distance_reduction_m": 166.67}}, {"preferred_candidate": "A", "basis": "newly served population within the stated straight-line threshold"}),
    ("exposure", {"analysis_crs": "EPSG:32610", "population_total": 600, "population_features": 3, "zone_features": 2, "inside_population": 300, "outside_population": 300, "share_inside_pct": 50.0, "inside_feature_count": 2}, None),
])
def test_each_mode_accepts_only_the_trusted_metrics_envelope(mode, metrics, comparison):
    expected = {"mode": mode, "metrics": metrics}
    if comparison:
        expected["comparison"] = comparison
    actual = json.loads(json.dumps(expected))
    _verify_result(actual, expected)


def test_secure_runtime_settings_are_verified():
    safe = {
        "Runtime": "runsc", "NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
        "CapDrop": ["ALL"], "Memory": 768 * 1024 * 1024, "MemorySwap": 768 * 1024 * 1024,
        "NanoCpus": 1_000_000_000, "PidsLimit": 64, "SecurityOpt": ["no-new-privileges:true"],
    }
    assert _secure_config(safe)
    for key, value in (("Runtime", "runc"), ("NetworkMode", "bridge"), ("ReadonlyRootfs", False), ("PidsLimit", 256)):
        candidate = dict(safe, **{key: value})
        assert not _secure_config(candidate)


def test_absent_runsc_fails_closed_without_creating_a_container(monkeypatch):
    calls = []
    monkeypatch.setattr(sandbox.platform, "system", lambda: "Linux")
    monkeypatch.setattr(sandbox, "_docker", lambda *args, **kwargs: calls.append(args) or subprocess.CompletedProcess(args, 0, '{"runc":{"path":"runc"}}', ""))
    data = {"type": "FeatureCollection", "features": []}
    with pytest.raises(SandboxUnavailable, match="runsc"):
        sandbox.execute("raise RuntimeError('should not run')", data)
    assert calls == [("info", "--format", "{{json .Runtimes}}")]


def test_cleanup_failure_quarantines_worker_and_preserves_task_diagnostics(monkeypatch):
    original_runtime_ready = sandbox.runtime_ready
    monkeypatch.setattr(sandbox, "_cleanup_failure", None)
    monkeypatch.setattr(sandbox, "runtime_ready", lambda: (True, "ready"))
    monkeypatch.setattr(sandbox, "_secure_config", lambda *_: True)

    class FailedAnalysis:
        def __init__(self, *args, **kwargs):
            self.stdout = io.BytesIO(b"partial stdout")
            self.stderr = io.BytesIO(b"analysis stderr")
            self.returncode = None

        def wait(self, timeout=None):
            self.returncode = 1

        def poll(self):
            return self.returncode

        def kill(self):
            self.returncode = -9

    monkeypatch.setattr(sandbox.subprocess, "Popen", FailedAnalysis)
    commands = []

    def fake_docker(*args, **kwargs):
        commands.append(args)
        if args[0] == "create":
            return subprocess.CompletedProcess(args, 0, "container-id\n", "")
        if args[0] == "inspect" and args[1] == "container-id":
            return subprocess.CompletedProcess(args, 0, '[{"HostConfig":{}}]', "")
        if args[0] == "start":
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0] == "kill":
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0] == "rm":
            return subprocess.CompletedProcess(args, 1, "", "permission denied")
        if args[0] == "inspect":
            return subprocess.CompletedProcess(args, 1, "", "daemon unavailable")
        raise AssertionError(args)

    monkeypatch.setattr(sandbox, "_docker", fake_docker)
    data = {"type": "FeatureCollection", "features": []}
    with pytest.raises(SandboxUnavailable, match="cleanup failed") as caught:
        sandbox._execute_once("pass", data)
    assert "Generated analysis exited with an error" in str(caught.value)
    assert caught.value.stderr == "analysis stderr"
    assert caught.value.stdout == "partial stdout"

    monkeypatch.setattr(sandbox, "runtime_ready", original_runtime_ready)
    ready, message = sandbox.runtime_ready()
    assert not ready and "quarantined" in message
    monkeypatch.setattr(sandbox, "_cleanup_failure", None)


def test_exposure_map_rejects_a_changed_inside_zone_flag():
    expected = {"type": "FeatureCollection", "features": [{
        "type": "Feature", "id": "tract-1", "properties": {"layer": "population", "population": 120, "inside_zone": True},
        "geometry": {"type": "Point", "coordinates": [-122.4, 37.7]},
    }]}
    actual = json.loads(json.dumps(expected))
    _verify_map(json.dumps(actual).encode(), json.dumps(expected).encode(), {"analysis_mode": "exposure"})
    actual["features"][0]["properties"]["inside_zone"] = False
    with pytest.raises(SandboxFailure, match="zone flag"):
        _verify_map(json.dumps(actual).encode(), json.dumps(expected).encode(), {"analysis_mode": "exposure"})

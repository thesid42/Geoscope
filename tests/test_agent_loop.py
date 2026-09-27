import asyncio
import base64
import json
from dataclasses import replace

import pytest

from app import controller
from app.datasets import DEMO, validate_geojson
from app.reference import REFERENCE_CODE
from app.sandbox import SandboxFailure, _verify_map, _verify_result


def test_trusted_reference_source_compiles():
    compile(REFERENCE_CODE, "reference.py", "exec")


@pytest.mark.parametrize("invalid", [float("nan"), float("inf")])
def test_geojson_rejects_nonfinite_values_in_any_property(invalid):
    data = json.loads(json.dumps(DEMO))
    data["features"][0]["properties"]["vendor_value"] = invalid
    with pytest.raises(ValueError, match="NaN or infinite"):
        validate_geojson(data)


def test_geojson_rejects_overflowing_json_exponent():
    raw = json.dumps(DEMO).replace('"population": 1200', '"population": 1200, "source_value": 1e999', 1)
    parsed = json.loads(raw)
    with pytest.raises(ValueError, match="NaN or infinite"):
        validate_geojson(parsed)


def test_geojson_rejects_malformed_crs_and_polygon_positions():
    malformed_crs = json.loads(json.dumps(DEMO))
    malformed_crs["crs"] = {"properties": ["bad"]}
    with pytest.raises(ValueError, match="CRS properties"):
        validate_geojson(malformed_crs)

    malformed_polygon = json.loads(json.dumps(DEMO))
    malformed_polygon["features"][6]["geometry"]["coordinates"][0][1] = ["bad", "bad"]
    with pytest.raises(ValueError, match="polygon coordinates must be numeric"):
        validate_geojson(malformed_polygon)


def test_metrics_match_reference_with_distance_tolerance():
    expected = {"mode": "access", "metrics": {"crs": "EPSG:32610", "total": 10, "mean": 100.0, "share": None}}
    actual = {"mode": "access", "metrics": {"crs": "EPSG:32610", "total": 10, "mean": 100.03, "share": None}}
    _verify_result(actual, expected)
    actual["metrics"]["mean"] = 100.2
    with pytest.raises(SandboxFailure, match="trusted reference"):
        _verify_result(actual, expected)


def test_metrics_reject_extra_or_nonfinite_claims():
    expected = {"mode": "access", "metrics": {"total": 10, "mean": None}}
    with pytest.raises(SandboxFailure, match="verified schema"):
        _verify_result({"mode": "access", "metrics": {"total": 10, "mean": None, "false_metric": 99}}, expected)
    with pytest.raises(SandboxFailure, match="finite"):
        _verify_result({"mode": "access", "metrics": {"total": 10, "mean": float("nan")}}, expected | {"metrics": {"total": 10, "mean": 100.0}})


def test_result_map_rejects_forged_source_properties_and_bad_json_shapes():
    request = {"analysis_mode": "access"}
    expected = {"type": "FeatureCollection", "features": [{
        "type": "Feature", "id": "block-1", "properties": {"layer": "population", "population": 100, "name": "Original", "nearest_m": 25.0, "underserved": False},
        "geometry": {"type": "Point", "coordinates": [-122.4, 37.7]},
    }]}
    actual = json.loads(json.dumps(expected))
    _verify_map(json.dumps(actual).encode(), json.dumps(expected).encode(), request)
    actual["features"][0]["properties"]["name"] = "Forged"
    with pytest.raises(SandboxFailure, match="source properties"):
        _verify_map(json.dumps(actual).encode(), json.dumps(expected).encode(), request)
    for malformed in ([], {"type": "FeatureCollection", "features": ["not a feature"]}):
        with pytest.raises(SandboxFailure, match="did not match"):
            _verify_map(json.dumps(malformed).encode(), json.dumps(expected).encode(), request)


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def test_empty_population_inspection_is_actionable_and_skips_model_requests(tmp_path, monkeypatch):
    settings = replace(controller.settings, data_dir=tmp_path, vultr_api_key="test-vultr-secret", vultr_model_id="catalog-id", worker_url="http://private-worker", worker_token="private-token", worker_timeout_seconds=3)
    monkeypatch.setattr(controller, "settings", settings)

    class FakeClient:
        calls = []

        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            self.calls.append(("POST", url))
            assert url.endswith("/inspect")
            return FakeResponse(422, {"detail": {"message": "Trusted dataset inspection failed before any model request.", "stderr": "ValueError: The selected area contains no population representative points. Expand the area or supply finer local data."}})

        async def get(self, url, **kwargs):
            self.calls.append(("GET", url))
            raise AssertionError("The model catalog must not be requested after failed trusted inspection")

    monkeypatch.setattr(controller.httpx, "AsyncClient", FakeClient)
    run = {
        "id": "b" * 32, "status": "queued", "question": "Find a clinic site in this small area.", "dataset_name": "Unit fixture", "synthetic": True,
        "threshold_m": 400, "analysis_mode": "scenario", "projected_crs": "EPSG:32610", "candidate_a": None, "candidate_b": None,
        "logs": [], "created_at": "2026-09-26T00:00:00Z", "updated_at": None, "result": None, "artifacts": {}, "error": None, "attempts": [],
        "study_area": [-122.43, 37.76, -122.42, 37.77], "service_type": "clinic", "building": {"width_m": 24, "depth_m": 18, "height_m": 12, "setback_m": 3},
    }
    assert controller.ACTIVE_RUNS.acquire(blocking=False)
    asyncio.run(controller._run_agent(run, DEMO, None, None, 400, "EPSG:32610"))
    assert run["status"] == "failed"
    assert run["error"].startswith("No population sample points fall inside the selected area.")
    assert "Traceback" not in run["error"]
    assert FakeClient.calls == [("POST", "http://private-worker/inspect")]


@pytest.mark.parametrize("mode", ["access", "scenario", "exposure"])
@pytest.mark.parametrize("summary_failure", [False, True])
def test_multistep_agent_uses_vultr_and_repairs_bounded_failure(tmp_path, monkeypatch, mode, summary_failure):
    settings = replace(controller.settings, data_dir=tmp_path, vultr_api_key="test-vultr-secret", vultr_model_id="catalog-id", worker_url="http://private-worker", worker_token="private-token", worker_timeout_seconds=3)
    monkeypatch.setattr(controller, "settings", settings)
    population_features = [f for f in DEMO["features"] if f["properties"]["layer"] == "population"]
    mapped = {"type": "FeatureCollection", "features": []}
    for feature in population_features:
        copy = json.loads(json.dumps(feature))
        copy["properties"]["nearest_m"] = 10.0
        copy["properties"]["underserved"] = False
        mapped["features"].append(copy)
    result = {"mode": mode, "metrics": {"analysis_crs": "EPSG:32610", "threshold_m": 400, "population_total": 6850, "population_features": 6, "service_features": 2, "baseline": {"served_population": 6850, "underserved_population": 0, "weighted_mean_nearest_m": 10.0}}, "reference_verified": True}
    artifacts = {"result.json": base64.b64encode(json.dumps(result).encode()).decode(), "result.geojson": base64.b64encode(json.dumps(mapped).encode()).decode()}

    class FakeClient:
        calls = []
        execute_count = 0

        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, **kwargs):
            self.calls.append(("GET", url))
            return FakeResponse(200, {"data": [{"id": "catalog-id"}]})

        async def post(self, url, **kwargs):
            self.calls.append(("POST", url))
            if url.endswith("/inspect"):
                if mode == "exposure":
                    data = kwargs["json"]["data"]
                    assert data["study_area"] == run["study_area"]
                    assert data["zone_source"] == "drawn_area"
                    zones = [f for f in data["features"] if f["properties"]["layer"] == "zone"]
                    assert len(zones) == 1 and zones[0]["properties"]["name"] == "Selected study area"
                    assert DEMO["features"][-1]["properties"].get("name") != "Selected study area"
                return FakeResponse(200, {"inspection": {"geometry_validation": "checked", "population_features": 6}, "reference_verified": True})
            if url.endswith("/execute"):
                type(self).execute_count += 1
                if type(self).execute_count == 1:
                    return FakeResponse(422, {"detail": {"message": "Generated analysis exited with an error.", "stderr": "NameError: typo", "stdout": ""}})
                return FakeResponse(200, {"result": result, "artifacts": artifacts, "stdout": "geoscope-analysis-ok\n", "stderr": "", "verified_against_reference": True})
            system = kwargs["json"]["messages"][0]["content"]
            if "careful GIS analyst" in system:
                content = '{"steps":["project","measure","compare"]}'
            elif system.startswith("Write only"):
                content = "print('broken first attempt')"
            elif system.startswith("Repair"):
                assert controller._script_instructions(mode) in system
                repair = json.loads(kwargs["json"]["messages"][1]["content"])
                assert repair["analysis_mode"] == mode
                assert repair["analysis_inputs"]["projected_crs"] == "EPSG:32610"
                content = "print('geoscope-analysis-ok')"
            else:
                assert run["status"] == "running", "Polling must not stop before the summary is available"
                if summary_failure:
                    return FakeResponse(503, {})
                content = "Six population areas are within the selected threshold in this demonstration."
            return FakeResponse(200, {"choices": [{"message": {"content": content}}]})

    monkeypatch.setattr(controller.httpx, "AsyncClient", FakeClient)
    run = {
        "id": "a" * 32, "status": "queued", "question": "Which areas are closest to a service?", "dataset_name": "Unit fixture",
        "synthetic": False, "threshold_m": 400, "analysis_mode": mode, "projected_crs": "EPSG:32610", "candidate_a": None,
        "candidate_b": None, "logs": [], "created_at": "2026-09-26T00:00:00Z", "updated_at": None,
        "result": None, "artifacts": {}, "error": None, "attempts": [],
    }
    if mode == "scenario":
        run.update(study_area=[-122.34,47.60,-122.31,47.62],service_type="clinic",building={"width_m":24,"depth_m":18,"height_m":12,"setback_m":3})
    if mode == "exposure":
        run.update(study_area=[-122.34,47.60,-122.31,47.62])
    assert controller.ACTIVE_RUNS.acquire(blocking=False)
    asyncio.run(controller._run_agent(run, DEMO, None, None, 400, "EPSG:32610"))
    assert run["status"] == "completed", run.get("error")
    assert ("optional natural-language summary was unavailable" in run["summary"]) == summary_failure
    assert len(run["attempts"]) == 2
    assert [attempt["status"] for attempt in run["attempts"]] == ["failed", "completed"]
    assert run["attempts"][1]["stdout"] == "geoscope-analysis-ok\n"
    assert FakeClient.execute_count == 2
    assert all(url.startswith("https://api.vultrinference.com/v1/") for method, url in FakeClient.calls if url.endswith("/models") or url.endswith("/chat/completions"))
    assert not any("openai.com" in url or "api.openai" in url for _, url in FakeClient.calls)
    assert (tmp_path / run["id"] / "analysis.py").is_file()
    assert (tmp_path / run["id"] / "request.json").is_file()
    assert (tmp_path / run["id"] / "analysis-attempt-1.py").read_text().startswith("print")
    trace = json.loads((tmp_path / run["id"] / "trace.json").read_text())
    assert len(trace["attempts"]) == 2 and trace["request_sha256"]

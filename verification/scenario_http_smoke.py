"""HTTP-only smoke for an explicitly launched local SF mock server; no browser."""
import argparse
import json
from pathlib import Path
import time
import httpx


def main(origin):
    report = {"kind": "local_mock_http_checks", "browser_used": False, "cloud_agent_used": False, "checks": []}
    with httpx.Client(base_url=origin, timeout=20) as client:
        config = client.get("/api/config"); config.raise_for_status()
        assert config.json()["demo_mode"] and config.json()["analysis_enabled"]
        assert config.headers["cache-control"] == "no-store"
        dataset = client.get("/api/datasets/localdemo").json()
        assert dataset["scenario_status"] == "MOCK_SIMULATION"
        assert client.post("/api/runs", json={}).status_code == 403
        client.headers["Origin"] = origin
        request = {"dataset_id":"localdemo", "analysis_mode":"scenario", "question":"Where can this hypothetical clinic fit and improve nearby service coverage?",
                   "study_area":[-122.433,37.758,-122.417,37.776], "service_type":"clinic", "threshold_m":400,
                   "building":{"width_m":24,"depth_m":18,"height_m":12,"setback_m":3}}
        def run(payload):
            response = client.post("/api/runs", json=payload); response.raise_for_status()
            run_id = response.json()["id"]
            for _ in range(100):
                state = client.get(f"/api/runs/{run_id}"); state.raise_for_status()
                state = state.json()
                if state["status"] in {"completed", "failed"}: break
                time.sleep(.1)
            assert state["status"] == "completed", state
            assert state["demo_mode"] and state["result"]["geometry_verified"]
            assert state["result"]["reference_verified"] is False
            artifact = client.get(f"/api/runs/{run_id}/artifacts/result.json"); artifact.raise_for_status()
            assert artifact.json() == state["result"]
            assert client.get(f"/api/runs/{run_id}/map").status_code == 200
            with httpx.Client(base_url=origin) as other:
                other.get("/api/config")
                assert other.get(f"/api/runs/{run_id}").status_code == 404
            return state["result"]["metrics"]
        for service in ("clinic", "library"):
            payload = {**request, "service_type": service}
            metrics = run(payload)
            assert metrics["eligible_sites"] == 4
            assert len(metrics["candidates"]) == 3
            assert sum(check["status"] == "excluded" for check in metrics["site_checks"]) == 3
            report["checks"].append({"service_type":service, "plots_checked":metrics["sites_evaluated"], "eligible_plots":metrics["eligible_sites"], "preferred_site":metrics["candidates"][0]["id"], "nearest_existing_service_m":metrics["candidates"][0]["nearest_existing_service_m"], "plot_area_m2":metrics["candidates"][0]["plot_area_m2"]})
        oversized = run({**request,"building":{**request["building"],"width_m":100,"depth_m":100}})
        assert oversized["eligible_sites"] == 0 and not oversized["candidates"]
        report["checks"].append({"large_footprint_rejected":True, "guest_isolation":True, "artifact_roundtrip":True, "origin_required":True})
    target = Path("verification/scenario-smoke.json")
    target.write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--origin",default="http://127.0.0.1:8765")
    main(parser.parse_args().origin)

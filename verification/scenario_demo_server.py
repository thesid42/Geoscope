"""Explicit local mock: trusted parcel simulation, never generated code or cloud claims.

Run with the test GIS dependencies installed:
  python -m verification.scenario_demo_server --port 8765
"""
import argparse
import asyncio
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import secrets


def build_demo_app(port=8765):
    os.environ.setdefault("APP_ACCESS_TOKEN", secrets.token_urlsafe(48))
    os.environ["PUBLIC_ANALYSIS_ENABLED"] = "true"
    os.environ["PUBLIC_ORIGIN"] = f"http://127.0.0.1:{port}"
    os.environ.setdefault("APP_DATA_DIR", str(Path.cwd() / "tmp" / "sf-scenario-demo"))
    from app import controller
    from app.scenario_program import calculate
    controller.settings = replace(controller.settings, worker_url="http://mock.invalid", worker_token="unused-mock-value")
    controller.app.state.demo_mode = True

    async def run_mock(run, dataset, a, b, threshold, projected_crs):
        run["status"] = "running"
        request = {**dataset, "analysis_mode": "scenario", "threshold_m": threshold, "projected_crs": projected_crs,
                   **{key: run[key] for key in ("study_area", "service_type", "building")}}
        if run.get("design"):
            request.update(design=run["design"], walk=run["walk"], walk_network=controller._walking_snapshot(run.get("dataset_id")))
            request.pop("design_proposals", None)
        encoded = json.dumps(request, allow_nan=False, separators=(",", ":")).encode()
        run["request_sha256"] = hashlib.sha256(encoded).hexdigest()
        folder = controller.settings.data_dir / run["id"]
        (folder / "request.json").write_bytes(encoded)
        controller._log(run, "SF mock: running fixed parcel-fit and coverage calculations locally. No LLM, generated code, Vultr or gVisor run.", "in_progress")
        if run.get("design"):
            from app.simulation_program import search_layouts, evaluate_proposals
            proposals = await asyncio.to_thread(search_layouts, request, "balanced")
            result, mapped = await asyncio.to_thread(evaluate_proposals, request, proposals, "balanced")
        else:
            result, mapped = await asyncio.to_thread(calculate, request)
        result.update(reference_verified=False, geometry_verified=True)
        run["result"] = result
        count = result["metrics"]["eligible_sites"]
        run["summary"] = f"Local mock simulation: {count} plots passed the supplied land-use, footprint, setback and obstruction checks. Eligible plots are ranked by distance to mapped facilities and plot area, not population. Availability and surrounding land features in this SF fixture are simulated."
        run["plan"] = "Filter supplied land records; fit the footprint and setback inside each plot and study area; reject building/restriction collisions; rank independent proposals by distance to existing matching services, then plot area."
        script = Path(__file__).resolve().parents[1] / "app" / ("simulation_program.py" if run.get("design") else "scenario_program.py")
        controller._persist_artifacts(run, {"result.json": json.dumps(result, allow_nan=False).encode(), "result.geojson": json.dumps(mapped, allow_nan=False).encode()}, script.read_text(encoding="utf-8"))
        if run.get("design"):
            run["summary"] = f"Local fixed-toolkit preview: {count} submitted layouts passed floor-area, connected open-space and land checks. Walking outcomes use a downloaded pedestrian network where available. No LLM or cloud sandbox ran in this local preview."
            run["plan"] = "Bounded layout search; independent geometric constraints; before/after walking access."
        run["status"] = "completed"
        controller._log(run, "Mock geometry checks complete. Results are a local simulation, not evidence of cloud containment or real land availability.", "complete")

    controller._run_agent_inner = run_mock
    return controller.app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(build_demo_app(args.port), host="127.0.0.1", port=args.port)

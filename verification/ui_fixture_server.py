"""Compatibility entry point for the current labeled SF mock simulation.

Run `python verification/ui_fixture_server.py`; serves loopback port 8766.
This replaces the older static canned-result UI helper. No generated code runs.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if __name__ == "__main__":
    import uvicorn
    from verification.scenario_demo_server import build_demo_app
    uvicorn.run(build_demo_app(8766), host="127.0.0.1", port=8766)

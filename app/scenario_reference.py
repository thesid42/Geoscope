"""Load a fixed script for execution in the isolated worker; never import GIS into the controller."""
from pathlib import Path
SCENARIO_REFERENCE_CODE = Path(__file__).with_name("scenario_program.py").read_text(encoding="utf-8")

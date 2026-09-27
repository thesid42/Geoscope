"""Bounded user inputs for hypothetical local service siting."""
import math
from typing import Literal
from pydantic import BaseModel, Field

ServiceType = Literal["clinic", "library", "school", "community_center"]

class BuildingSpec(BaseModel):
    setback_m: float = Field(default=3, ge=0, le=20, allow_inf_nan=False, strict=True)
    width_m: float = Field(default=24, ge=5, le=100, allow_inf_nan=False, strict=True)
    depth_m: float = Field(default=18, ge=5, le=100, allow_inf_nan=False, strict=True)
    height_m: float = Field(default=12, ge=3, le=80, allow_inf_nan=False, strict=True)


def validate_study_area(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("Select a rectangular study area: west, south, east, north.")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value):
        raise ValueError("Study area coordinates must be finite longitude/latitude numbers.")
    west, south, east, north = map(float, value)
    if not (-180 <= west < east <= 180 and -80 <= south < north <= 84):
        raise ValueError("Study area must be a non-crossing EPSG:4326 rectangle within UTM latitudes.")
    # Conservative geographic size check before any sandbox admission.
    width = (east-west) * 111320 * math.cos(math.radians((north+south)/2))
    height = (north-south) * 111320
    if not (20 <= width <= 10000 and 20 <= height <= 10000):
        raise ValueError("Study area width and height must each be between 20 metres and 10 kilometres.")
    if south < 0 < north:
        raise ValueError("Study area must be within one hemisphere.")
    return [west, south, east, north]


def validate_land_dataset(dataset):
    sites = [f for f in dataset["features"] if f["properties"]["layer"] == "candidate_site"]
    if not sites:
        raise ValueError("Scenario mode needs candidate_site parcel polygons. Select the East Harlem official lots, the SF mock, or upload land data.")
    if len(sites) > 100:
        raise ValueError("Scenario mode accepts at most 100 candidate plots.")
    ids = [f.get("id") for f in sites]
    if any(not isinstance(value, str) or not value.strip() or len(value) > 80 for value in ids) or len(set(ids)) != len(ids):
        raise ValueError("Candidate plots need unique nonempty string feature IDs (up to 80 characters).")
    inventory = dataset.get("land_inventory")
    coverage_keys = ("building_coverage", "road_coverage", "restriction_coverage")
    if not isinstance(inventory, dict) or any(inventory.get(key) != "complete_for_candidate_sites" for key in coverage_keys):
        raise ValueError("Land data must declare building, road, and restriction coverage complete_for_candidate_sites in land_inventory; missing obstructions cannot be assumed absent.")
    for key in ("source", "as_of"):
        if not isinstance(inventory.get(key), str) or not inventory[key].strip() or len(inventory[key]) > 1000:
            raise ValueError("Land inventory needs a source and as_of date.")
    from datetime import date
    try:
        date.fromisoformat(inventory["as_of"])
    except ValueError as exc:
        raise ValueError("Land inventory as_of must be an ISO date (YYYY-MM-DD).") from exc
    return sites


class DesignSpec(BaseModel):
    """User goals; the agent selects placement, footprint and floors."""
    model_config = {"extra": "forbid"}
    target_floor_area_m2: float = Field(default=900, ge=100, le=5000, allow_inf_nan=False, strict=True)
    max_floors: int = Field(default=3, ge=1, le=6, strict=True)
    min_open_space_pct: float = Field(default=40, ge=10, le=85, allow_inf_nan=False, strict=True)
    setback_m: float = Field(default=3, ge=0, le=20, allow_inf_nan=False, strict=True)


class WalkSpec(BaseModel):
    model_config = {"extra": "forbid"}
    minutes: int = Field(default=10, ge=3, le=20, strict=True)
    speed_mps: float = Field(default=1.2, ge=0.5, le=2, allow_inf_nan=False, strict=True)
    max_snap_m: float = Field(default=100, ge=10, le=200, allow_inf_nan=False, strict=True)

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
import tempfile


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    vultr_api_key: str
    vultr_model_id: str
    worker_url: str
    worker_token: str
    max_upload_bytes: int = 20 * 1024 * 1024
    max_features: int = 100_000
    worker_timeout_seconds: int = 90

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            data_dir=Path(os.getenv("APP_DATA_DIR", "/data" if os.name == "posix" else str(Path(tempfile.gettempdir()) / "geoscope-data"))),
            vultr_api_key=os.getenv("VULTR_SERVERLESS_INFERENCE_API_KEY", ""),
            vultr_model_id=os.getenv("VULTR_MODEL_ID", ""),
            worker_url=os.getenv("WORKER_URL", ""),
            worker_token=os.getenv("WORKER_TOKEN", ""),
            max_upload_bytes=int(os.getenv("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024))),
            max_features=int(os.getenv("MAX_FEATURES", "100000")),
            worker_timeout_seconds=int(os.getenv("WORKER_TIMEOUT_SECONDS", "90")),
        )

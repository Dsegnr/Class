from backend.app import create_app
from fastapi.staticfiles import StaticFiles
from pathlib import Path

app = create_app()
dist = Path(__file__).resolve().parents[1] / "frontend/dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")

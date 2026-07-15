"""FastAPI app: a web GUI + JSON API over the local Overture Italy GeoParquet files.

Run with:  python -m server   (or: uvicorn server.main:app --reload)
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .db import Database

app = FastAPI(title="Overture Italy GeoParquet Explorer")
db = Database()

STATIC_DIR = Path(__file__).parent / "static"

MAX_FEATURES = 10_000
DEFAULT_FEATURES = 4_000


class SqlRequest(BaseModel):
    sql: str
    max_rows: int = 500


@app.get("/api/datasets")
def list_datasets():
    return {
        "data_dir": str(db.data_dir.resolve()),
        "datasets": [
            {
                "name": ds.name,
                "file": ds.path.name,
                "rows": ds.row_count,
                "size_bytes": ds.path.stat().st_size,
                "columns": ds.columns,
            }
            for ds in db.datasets()
        ],
    }


@app.get("/api/datasets/{name}/features")
def features(
    name: str,
    bbox: str | None = Query(None, description="west,south,east,north in WGS84"),
    limit: int = Query(DEFAULT_FEATURES, ge=1, le=MAX_FEATURES),
    search: str | None = Query(None, description="Filter by names.primary (ILIKE substring)"),
):
    ds = db.get(name)
    if ds is None:
        raise HTTPException(404, f"Dataset '{name}' not found. Download it first (see README).")
    parsed_bbox = None
    if bbox:
        try:
            xmin, ymin, xmax, ymax = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(400, "bbox must be 'west,south,east,north'")
        parsed_bbox = (xmin, ymin, xmax, ymax)
    try:
        return db.features(ds, parsed_bbox, limit, search)
    except Exception as exc:  # surface DuckDB errors to the UI
        raise HTTPException(500, str(exc))


@app.get("/api/search")
def search(q: str = Query(..., min_length=2), limit: int = Query(20, ge=1, le=100)):
    return {"results": db.search_places(q, limit)}


@app.post("/api/sql")
def run_sql(req: SqlRequest):
    try:
        return db.run_sql(req.sql, max_rows=min(max(req.max_rows, 1), 5000))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(400, str(exc))


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

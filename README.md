# Overture Italy — GeoParquet Explorer

Query and browse [Overture Maps](https://overturemaps.org) data for Italy: a DuckDB-powered
downloader that extracts Italy from Overture's cloud-hosted GeoParquet, plus a local web GUI
(map + search + SQL console) layered directly on top of the GeoParquet files. No database
import step — DuckDB queries the files in place.

```
┌────────────────────┐     scripts/download_italy.py      ┌──────────────────────┐
│ Overture on S3     │ ─────────(DuckDB + spatial)──────▶ │ data/italy_*.parquet │
│ (GeoParquet)       │    clipped to Italy's boundary     │ (local GeoParquet)   │
└────────────────────┘                                    └──────────┬───────────┘
                                                                     │ DuckDB (in place)
                                                          ┌──────────▼───────────┐
                                                          │ python -m server     │
                                                          │ FastAPI + MapLibre   │
                                                          │ http://localhost:8000│
                                                          └──────────────────────┘
```

## Requirements

- Python 3.10+ (Windows, macOS, or Linux)
- Internet access for the download step (Overture's public S3 bucket)
- ~1 GB free disk for the core datasets; **tens of GB** if you download buildings/addresses

QGIS is optional: the same `data/*.parquet` files open directly in QGIS as vector layers.

## Setup

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

## 1. Download data

Start small — a smoke test with places in central Rome:

```bash
python scripts/download_italy.py --rome-test
```

Then download real Italy-wide datasets. The script first fetches Italy's exact land boundary
from Overture's `divisions/division_area` theme (cached in `data/overture_italy.duckdb`), then
clips every feature type to it with `ST_Intersects` — so you get Italy's actual shape, not a
rectangle that includes half of Switzerland:

```bash
# One type
python scripts/download_italy.py --types place

# A practical subset: place, division_area, segment, building, water, land_use
python scripts/download_italy.py --types core

# Everything (15 feature types; building/address/segment are large — hours, tens of GB)
python scripts/download_italy.py --types all
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--release 2026-06-17.0` | Pin an Overture release (default: `2026-06-17.0`) |
| `--data-dir data` | Output directory |
| `--force` | Re-download even if the file already exists |
| `--refresh-boundary` | Refetch the Italy boundary |

One GeoParquet file per feature type is written (`data/italy_place.parquet`,
`data/italy_building.parquet`, …). Schemas differ per type, so they are deliberately not merged.

## 2. Explore in the GUI

```bash
python -m server
# open http://localhost:8000
```

Features:

- **Layers** — toggle any downloaded dataset; features load for the current viewport
  (bbox-filtered via each file's `bbox` column, so it stays fast even on huge files).
  Heavy layers (buildings, addresses, segments) only load once you zoom in.
- **Search** — find features by name (`names.primary`) across all datasets, places first;
  click a hit to fly there.
- **SQL** — a read-only DuckDB console over the files. Every dataset is exposed as a view
  named after its feature type, so you can write:

  ```sql
  SELECT categories."primary" AS category, count(*) AS n
  FROM place
  GROUP BY category ORDER BY n DESC LIMIT 25;
  ```

  If a result column is a geometry (e.g. `SELECT names."primary", geometry FROM place WHERE …`),
  the rows are also plotted on the map in pink.
- Click any feature on the map to inspect its attributes.

The server runs on `127.0.0.1:8000` by default (`HOST`/`PORT` env vars to change) and is
intended as a **local, single-user tool** — don't expose it to the internet.

## API

The GUI is a thin client over a JSON API you can use directly:

| Endpoint | Description |
|---|---|
| `GET /api/datasets` | List downloaded datasets with row counts, sizes, schemas |
| `GET /api/datasets/{type}/features?bbox=w,s,e,n&limit=4000&search=…` | GeoJSON FeatureCollection for a viewport |
| `GET /api/search?q=colosseo` | Name search across datasets |
| `POST /api/sql` `{"sql": "SELECT …"}` | Read-only SQL (SELECT/WITH/DESCRIBE/…), geometry columns returned as GeoJSON |

## Querying outside the GUI

The files are standard GeoParquet — anything that speaks it works:

- **DuckDB CLI**: `SELECT count(*) FROM read_parquet('data/italy_building.parquet');`
- **QGIS**: drag any `data/*.parquet` file onto the map canvas.
- **Python**: `duckdb`, `geopandas.read_parquet`, `pyarrow`, …

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

Tests generate a tiny GeoParquet fixture with DuckDB, so they need no network or downloads.

## Notes

- Keep the `sources` column in exports — it carries Overture's attribution/provenance.
- Border-crossing features (e.g. a road into Switzerland) are kept whole: clipping uses
  `ST_Intersects`, preserving original Overture geometries and IDs.
- Data: © Overture Maps Foundation and its data providers ([ODbL/CDLA licenses per theme](https://docs.overturemaps.org/attribution/)).
  Basemap tiles in the GUI: © OpenStreetMap contributors.

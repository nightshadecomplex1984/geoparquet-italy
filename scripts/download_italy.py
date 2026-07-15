#!/usr/bin/env python3
"""Download Overture Maps data for Italy into local GeoParquet files.

Uses DuckDB to query Overture's cloud-hosted GeoParquet on S3, clips every
feature type to Italy's exact land boundary (taken from Overture's own
``divisions/division_area`` dataset), and writes one GeoParquet file per
feature type into the data directory.

Examples:
    # Quick smoke test: places in central Rome only (small, fast)
    python scripts/download_italy.py --rome-test

    # Download the Italy boundary plus a single feature type
    python scripts/download_italy.py --types place

    # Download everything (buildings and addresses are tens of GB - be patient)
    python scripts/download_italy.py --types all

    # Pin a different Overture release
    python scripts/download_italy.py --release 2026-06-17.0 --types place
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import duckdb

DEFAULT_RELEASE = "2026-06-17.0"
S3_BASE = "s3://overturemaps-us-west-2/release"

# All Overture core feature types, keyed by type name -> theme.
FEATURE_TYPES: dict[str, str] = {
    "place": "places",
    "division": "divisions",
    "division_area": "divisions",
    "division_boundary": "divisions",
    "connector": "transportation",
    "infrastructure": "base",
    "land": "base",
    "land_use": "base",
    "water": "base",
    "segment": "transportation",
    "building": "buildings",
    "building_part": "buildings",
    "address": "addresses",
    "land_cover": "base",
    "bathymetry": "base",
}

# Recommended download order: small/interpretable types first, huge ones last.
DOWNLOAD_ORDER = list(FEATURE_TYPES.keys())

# A named subset that covers the most common mapping needs.
CORE_TYPES = ["place", "division_area", "segment", "building", "water", "land_use"]


def connect(data_dir: Path) -> duckdb.DuckDBPyConnection:
    """Open the project DuckDB database and prepare cloud + spatial access."""
    data_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(data_dir / "overture_italy.duckdb"))
    con.execute("INSTALL spatial; INSTALL httpfs;")
    con.execute("LOAD spatial; LOAD httpfs;")
    con.execute("SET s3_region = 'us-west-2';")
    return con


def source_path(release: str, feature_type: str) -> str:
    theme = FEATURE_TYPES[feature_type]
    return f"{S3_BASE}/{release}/theme={theme}/type={feature_type}/*.parquet"


def ensure_italy_boundary(
    con: duckdb.DuckDBPyConnection, release: str, data_dir: Path, refresh: bool = False
) -> None:
    """Create (and cache) the italy_boundary table from Overture division areas."""
    exists = con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'italy_boundary'"
    ).fetchone()[0]
    if exists and not refresh:
        print("Italy boundary already cached in DuckDB (use --refresh-boundary to refetch).")
        return

    print("Fetching Italy land boundary from Overture divisions ...")
    started = time.time()
    con.execute(
        f"""
        CREATE OR REPLACE TABLE italy_boundary AS
        SELECT
            id,
            names.primary AS name,
            geometry,
            bbox,
            country,
            subtype,
            is_land,
            is_territorial
        FROM read_parquet('{source_path(release, "division_area")}', hive_partitioning = true)
        WHERE country = 'IT'
          AND subtype = 'country'
          AND is_land = true
        ORDER BY ST_Area(geometry) DESC
        LIMIT 1
        """
    )
    name, geom_type = con.execute(
        "SELECT name, ST_GeometryType(geometry) FROM italy_boundary"
    ).fetchone()
    print(f"Boundary ready: {name} ({geom_type}) in {time.time() - started:.1f}s")

    out = data_dir / "italy_boundary.parquet"
    con.execute(f"COPY italy_boundary TO '{out.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    print(f"Saved {out}")


def download_type(
    con: duckdb.DuckDBPyConnection,
    release: str,
    feature_type: str,
    data_dir: Path,
    skip_existing: bool = True,
) -> None:
    """Download one feature type clipped to the Italy boundary."""
    out = data_dir / f"italy_{feature_type}.parquet"
    if skip_existing and out.exists():
        print(f"[{feature_type}] already exists at {out}, skipping (use --force to redo).")
        return

    print(f"[{feature_type}] downloading from {source_path(release, feature_type)} ...")
    started = time.time()
    con.execute(
        f"""
        COPY (
            SELECT src.*
            FROM read_parquet('{source_path(release, feature_type)}', hive_partitioning = true) AS src
            CROSS JOIN italy_boundary AS italy
            WHERE src.bbox.xmin <= italy.bbox.xmax
              AND src.bbox.xmax >= italy.bbox.xmin
              AND src.bbox.ymin <= italy.bbox.ymax
              AND src.bbox.ymax >= italy.bbox.ymin
              AND ST_Intersects(src.geometry, italy.geometry)
        )
        TO '{out.as_posix()}'
        (FORMAT PARQUET, COMPRESSION ZSTD)
        """
    )
    rows = con.execute(f"SELECT count(*) FROM read_parquet('{out.as_posix()}')").fetchone()[0]
    size_mb = out.stat().st_size / 1024 / 1024
    print(
        f"[{feature_type}] done: {rows:,} features, {size_mb:,.1f} MB, "
        f"{time.time() - started:,.0f}s -> {out}"
    )


def rome_test(con: duckdb.DuckDBPyConnection, release: str, data_dir: Path) -> None:
    """Small end-to-end check: download places in central Rome."""
    out = data_dir / "rome_places.parquet"
    print("Running Rome smoke test (places in central Rome) ...")
    con.execute(
        f"""
        COPY (
            SELECT *
            FROM read_parquet('{source_path(release, "place")}', hive_partitioning = true)
            WHERE bbox.xmin BETWEEN 12.45 AND 12.55
              AND bbox.ymin BETWEEN 41.87 AND 41.95
        )
        TO '{out.as_posix()}'
        (FORMAT PARQUET, COMPRESSION ZSTD)
        """
    )
    rows = con.execute(f"SELECT count(*) FROM read_parquet('{out.as_posix()}')").fetchone()[0]
    print(f"Rome test OK: {rows:,} places written to {out}")


def parse_types(raw: list[str]) -> list[str]:
    if raw == ["all"]:
        return DOWNLOAD_ORDER
    if raw == ["core"]:
        return CORE_TYPES
    unknown = [t for t in raw if t not in FEATURE_TYPES]
    if unknown:
        valid = ", ".join(FEATURE_TYPES)
        sys.exit(f"Unknown feature type(s): {', '.join(unknown)}. Valid: all, core, {valid}")
    # Preserve the recommended order regardless of how the user listed them.
    return [t for t in DOWNLOAD_ORDER if t in raw]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", default=DEFAULT_RELEASE, help=f"Overture release (default {DEFAULT_RELEASE})")
    parser.add_argument("--data-dir", default="data", help="Output directory (default ./data)")
    parser.add_argument(
        "--types",
        nargs="+",
        default=[],
        metavar="TYPE",
        help="Feature types to download, or 'all' / 'core'. E.g. --types place segment",
    )
    parser.add_argument("--rome-test", action="store_true", help="Only run the small Rome smoke test")
    parser.add_argument("--refresh-boundary", action="store_true", help="Refetch the Italy boundary")
    parser.add_argument("--force", action="store_true", help="Re-download types even if the file exists")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    con = connect(data_dir)

    if args.rome_test:
        rome_test(con, args.release, data_dir)
        return

    types = parse_types(args.types)
    if not types and not args.refresh_boundary:
        parser.error("Nothing to do: pass --types (e.g. --types place, --types core, --types all) or --rome-test")

    ensure_italy_boundary(con, args.release, data_dir, refresh=args.refresh_boundary)
    for feature_type in types:
        download_type(con, args.release, feature_type, data_dir, skip_existing=not args.force)

    print("All done. Start the viewer with:  python -m server")


if __name__ == "__main__":
    main()

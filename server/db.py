"""DuckDB access layer for the local Overture Italy GeoParquet files.

One shared in-memory DuckDB connection (spatial extension loaded) queries the
GeoParquet files in the data directory directly - nothing is imported into a
database. Each dataset is also registered as a SQL view named after its
feature type (e.g. ``place``, ``building``) so the SQL console can use
friendly table names.
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

import duckdb

# Top-level column types we expose as feature properties on the map.
_SCALAR_TYPES = re.compile(
    r"^(VARCHAR|BIGINT|INTEGER|SMALLINT|TINYINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|"
    r"DOUBLE|FLOAT|DECIMAL.*|BOOLEAN|DATE|TIMESTAMP.*)$"
)

_VALID_NAME = re.compile(r"^[a-z0-9_]+$")

# Statements allowed in the read-only SQL console.
_READONLY_PREFIXES = ("select", "with", "describe", "show", "explain", "from", "pivot", "summarize")


@dataclass
class Dataset:
    name: str  # e.g. "place"
    path: Path
    columns: dict[str, str] = field(default_factory=dict)  # column -> duckdb type
    row_count: int = 0

    @property
    def has_bbox(self) -> bool:
        return "bbox" in self.columns and self.columns["bbox"].startswith("STRUCT")

    @property
    def geometry_is_native(self) -> bool:
        """True when DuckDB reads the geometry column as GEOMETRY (GeoParquet metadata present)."""
        # DuckDB may report a CRS-annotated type such as GEOMETRY('OGC:CRS84').
        return self.columns.get("geometry", "").startswith("GEOMETRY")

    def geometry_expr(self, alias: str = "") -> str:
        prefix = f"{alias}." if alias else ""
        col = f'{prefix}"geometry"'
        return col if self.geometry_is_native else f"ST_GeomFromWKB({col})"

    def property_columns(self) -> dict[str, str]:
        """Map of result alias -> SQL expression for displayable properties."""
        props: dict[str, str] = {}
        for col, coltype in self.columns.items():
            if col in ("geometry", "bbox"):
                continue
            if _SCALAR_TYPES.match(coltype):
                props[col] = f'"{col}"'
        # Pull the most useful values out of Overture's nested structs.
        if self.columns.get("names", "").startswith("STRUCT"):
            props["name"] = 'names."primary"'
        if self.columns.get("categories", "").startswith("STRUCT"):
            props["category"] = 'categories."primary"'
        return props


class Database:
    def __init__(self, data_dir: str | os.PathLike | None = None):
        self.data_dir = Path(data_dir or os.environ.get("DATA_DIR", "data"))
        self._lock = threading.Lock()
        self._con = duckdb.connect(":memory:")
        self._con.execute("INSTALL spatial; LOAD spatial;")
        self._datasets: dict[str, Dataset] = {}
        self.refresh()

    # ------------------------------------------------------------- registry

    def refresh(self) -> None:
        """Rescan the data directory and (re)register one view per dataset."""
        with self._lock:
            found: dict[str, Dataset] = {}
            for path in sorted(self.data_dir.glob("*.parquet")):
                name = path.stem
                if name.startswith("italy_"):
                    name = name[len("italy_"):]
                if not _VALID_NAME.match(name):
                    continue
                ds = self._datasets.get(name)
                if ds is None or ds.path != path:
                    ds = self._describe(name, path)
                found[name] = ds
                self._con.execute(
                    f'CREATE OR REPLACE VIEW "{name}" AS '
                    f"SELECT * FROM read_parquet('{path.as_posix()}')"
                )
            for stale in set(self._datasets) - set(found):
                self._con.execute(f'DROP VIEW IF EXISTS "{stale}"')
            self._datasets = found

    def _describe(self, name: str, path: Path) -> Dataset:
        rows = self._con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{path.as_posix()}')"
        ).fetchall()
        columns = {r[0]: r[1] for r in rows}
        count = self._con.execute(
            f"SELECT count(*) FROM read_parquet('{path.as_posix()}')"
        ).fetchone()[0]
        return Dataset(name=name, path=path, columns=columns, row_count=count)

    def datasets(self) -> list[Dataset]:
        self.refresh()
        return list(self._datasets.values())

    def get(self, name: str) -> Dataset | None:
        if name not in self._datasets:
            self.refresh()
        return self._datasets.get(name)

    # -------------------------------------------------------------- queries

    def _execute(self, sql: str, params: list | None = None) -> tuple[list[str], list[tuple]]:
        with self._lock:
            cur = self._con.execute(sql, params or [])
            cols = [d[0] for d in cur.description]
            return cols, cur.fetchall()

    def features(
        self,
        dataset: Dataset,
        bbox: tuple[float, float, float, float] | None,
        limit: int,
        search: str | None = None,
    ) -> dict:
        """Return a GeoJSON FeatureCollection for a dataset, filtered by bbox."""
        props = dataset.property_columns()
        select = [f"{expr} AS \"{alias}\"" for alias, expr in props.items()]
        select.append(f"ST_AsGeoJSON({dataset.geometry_expr()}) AS __geojson")

        where: list[str] = []
        params: list = []
        if bbox is not None:
            xmin, ymin, xmax, ymax = bbox
            if dataset.has_bbox:
                where.append("bbox.xmin <= ? AND bbox.xmax >= ? AND bbox.ymin <= ? AND bbox.ymax >= ?")
                params += [xmax, xmin, ymax, ymin]
            else:
                where.append(
                    f"ST_Intersects({dataset.geometry_expr()}, ST_MakeEnvelope(?, ?, ?, ?))"
                )
                params += [xmin, ymin, xmax, ymax]
        if search and "name" in props:
            where.append(f"{props['name']} ILIKE ?")
            params.append(f"%{search}%")

        sql = f"SELECT {', '.join(select)} FROM read_parquet('{dataset.path.as_posix()}')"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" LIMIT {int(limit)}"

        cols, rows = self._execute(sql, params)
        geo_idx = cols.index("__geojson")
        features = []
        for row in rows:
            geometry = json.loads(row[geo_idx]) if row[geo_idx] else None
            properties = {
                cols[i]: _jsonable(v)
                for i, v in enumerate(row)
                if i != geo_idx and v is not None
            }
            features.append({"type": "Feature", "geometry": geometry, "properties": properties})
        return {
            "type": "FeatureCollection",
            "features": features,
            "truncated": len(features) >= limit,
        }

    def search_places(self, q: str, limit: int = 20) -> list[dict]:
        """Name search over every dataset that has names.primary, best-first."""
        results: list[dict] = []
        preferred = [d for d in self.datasets() if "names" in d.columns]
        # Places first: it is the most useful search target.
        preferred.sort(key=lambda d: (d.name != "place", d.name))
        for ds in preferred:
            if len(results) >= limit:
                break
            center = (
                "(bbox.xmin + bbox.xmax) / 2 AS lon, (bbox.ymin + bbox.ymax) / 2 AS lat"
                if ds.has_bbox
                else f"ST_X(ST_Centroid({ds.geometry_expr()})) AS lon, ST_Y(ST_Centroid({ds.geometry_expr()})) AS lat"
            )
            category = (
                'categories."primary"' if ds.columns.get("categories", "").startswith("STRUCT") else "NULL"
            )
            sql = f"""
                SELECT id, names."primary" AS name, {category} AS category, {center}
                FROM read_parquet('{ds.path.as_posix()}')
                WHERE names."primary" ILIKE ?
                LIMIT {limit - len(results)}
            """
            _, rows = self._execute(sql, [f"%{q}%"])
            for r in rows:
                results.append(
                    {"dataset": ds.name, "id": r[0], "name": r[1], "category": r[2], "lon": r[3], "lat": r[4]}
                )
        return results

    def run_sql(self, sql: str, max_rows: int = 500) -> dict:
        """Run a read-only SQL statement and return rows as JSON-friendly data."""
        cleaned = _strip_comments(sql).strip().rstrip(";").strip()
        if not cleaned:
            raise ValueError("Empty query.")
        if ";" in cleaned:
            raise ValueError("Only a single statement is allowed.")
        if not cleaned.lower().startswith(_READONLY_PREFIXES):
            allowed = ", ".join(p.upper() for p in _READONLY_PREFIXES)
            raise ValueError(f"Only read-only queries are allowed ({allowed} ...).")

        self.refresh()  # make sure views cover newly downloaded files

        # Convert GEOMETRY columns to GeoJSON so the UI can plot results.
        described = self._execute(f"DESCRIBE SELECT * FROM ({cleaned})")[1]
        geom_cols = [
            i for i, (name, coltype, *_rest) in enumerate(described) if coltype.startswith("GEOMETRY")
        ]
        if geom_cols:
            inner = ", ".join(
                f'ST_AsGeoJSON("{name}") AS "{name}"' if i in geom_cols else f'"{name}"'
                for i, (name, *_r) in enumerate(described)
            )
            cols, rows = self._execute(f"SELECT {inner} FROM ({cleaned}) LIMIT {max_rows + 1}")
        else:
            cols, rows = self._execute(f"SELECT * FROM ({cleaned}) LIMIT {max_rows + 1}")

        truncated = len(rows) > max_rows
        rows = rows[:max_rows]
        return {
            "columns": cols,
            "rows": [[_jsonable(v) for v in row] for row in rows],
            "geometry_columns": [cols[i] for i in geom_cols],
            "truncated": truncated,
        }


def _strip_comments(sql: str) -> str:
    sql = re.sub(r"--[^\n]*", " ", sql)
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return sql


def _jsonable(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return f"<binary {len(value)} bytes>"
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, (list, dict, str, int, float, bool)) or value is None:
        return value
    return str(value)

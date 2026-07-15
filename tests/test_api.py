"""API tests against a small generated GeoParquet fixture (no network needed)."""

import importlib
import os

import duckdb
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="session")
def data_dir(tmp_path_factory):
    """Build tiny GeoParquet files shaped like Overture data."""
    d = tmp_path_factory.mktemp("data")
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    con.execute(
        f"""
        COPY (
            SELECT * FROM (VALUES
                ('p1', {{'primary': 'Colosseo'}},        {{'primary': 'landmark'}},   0.95,
                 {{'xmin': 12.4922, 'xmax': 12.4922, 'ymin': 41.8902, 'ymax': 41.8902}},
                 ST_Point(12.4922, 41.8902)),
                ('p2', {{'primary': 'Duomo di Milano'}}, {{'primary': 'church'}},     0.97,
                 {{'xmin': 9.1919, 'xmax': 9.1919, 'ymin': 45.4642, 'ymax': 45.4642}},
                 ST_Point(9.1919, 45.4642)),
                ('p3', {{'primary': 'Ponte Vecchio'}},   {{'primary': 'bridge'}},     0.90,
                 {{'xmin': 11.2531, 'xmax': 11.2531, 'ymin': 43.7679, 'ymax': 43.7679}},
                 ST_Point(11.2531, 43.7679))
            ) AS t(id, names, categories, confidence, bbox, geometry)
        ) TO '{(d / "italy_place.parquet").as_posix()}' (FORMAT PARQUET)
        """
    )
    con.execute(
        f"""
        COPY (
            SELECT
                'w1' AS id,
                {{'primary': 'Lago di Test'}} AS names,
                {{'xmin': 12.0, 'xmax': 12.1, 'ymin': 42.0, 'ymax': 42.1}} AS bbox,
                ST_GeomFromText('POLYGON((12 42, 12.1 42, 12.1 42.1, 12 42.1, 12 42))') AS geometry
        ) TO '{(d / "italy_water.parquet").as_posix()}' (FORMAT PARQUET)
        """
    )
    return d


@pytest.fixture(scope="session")
def client(data_dir):
    os.environ["DATA_DIR"] = str(data_dir)
    import server.main
    importlib.reload(server.main)
    return TestClient(server.main.app)


def test_list_datasets(client):
    data = client.get("/api/datasets").json()
    names = {d["name"]: d for d in data["datasets"]}
    assert set(names) == {"place", "water"}
    assert names["place"]["rows"] == 3
    assert "geometry" in names["place"]["columns"]


def test_features_bbox_filtering(client):
    # bbox around Rome only
    res = client.get("/api/datasets/place/features", params={"bbox": "12.4,41.8,12.6,42.0"})
    assert res.status_code == 200
    fc = res.json()
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 1
    feat = fc["features"][0]
    assert feat["properties"]["name"] == "Colosseo"
    assert feat["properties"]["category"] == "landmark"
    assert feat["geometry"]["type"] == "Point"


def test_features_no_bbox_returns_all(client):
    fc = client.get("/api/datasets/place/features").json()
    assert len(fc["features"]) == 3


def test_features_polygon_dataset(client):
    fc = client.get("/api/datasets/water/features", params={"bbox": "11.9,41.9,12.2,42.2"}).json()
    assert len(fc["features"]) == 1
    assert fc["features"][0]["geometry"]["type"] == "Polygon"


def test_features_unknown_dataset(client):
    assert client.get("/api/datasets/nope/features").status_code == 404


def test_search(client):
    data = client.get("/api/search", params={"q": "colosseo"}).json()
    assert data["results"][0]["name"] == "Colosseo"
    assert abs(data["results"][0]["lon"] - 12.4922) < 1e-4


def test_sql_select(client):
    res = client.post("/api/sql", json={"sql": "SELECT id, names.primary AS name FROM place ORDER BY id"})
    assert res.status_code == 200
    data = res.json()
    assert data["columns"] == ["id", "name"]
    assert data["rows"][0] == ["p1", "Colosseo"]


def test_sql_geometry_converted_to_geojson(client):
    res = client.post("/api/sql", json={"sql": "SELECT id, geometry FROM water"})
    data = res.json()
    assert data["geometry_columns"] == ["geometry"]
    import json
    geom = json.loads(data["rows"][0][data["columns"].index("geometry")])
    assert geom["type"] == "Polygon"


def test_sql_rejects_writes(client):
    for bad in [
        "DROP TABLE place",
        "CREATE TABLE x (i INT)",
        "SELECT 1; SELECT 2",
        "INSERT INTO place VALUES (1)",
    ]:
        res = client.post("/api/sql", json={"sql": bad})
        assert res.status_code == 400, bad


def test_index_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "Overture Italy" in res.text

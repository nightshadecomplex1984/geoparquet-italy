/* Overture Italy — browser-only GeoParquet explorer.
 *
 * DuckDB-WASM runs in a web worker and queries Overture's cloud-hosted
 * GeoParquet directly from S3 via HTTP range requests. Nothing is installed
 * and no backend is involved; local .parquet files can also be opened.
 */

import * as duckdb from "./vendor/duckdb/duckdb-wasm.mjs";

const S3_BASE = "s3://overturemaps-us-west-2/release";

// type -> theme for every Overture core feature type.
const OVERTURE_TYPES = {
  place: "places",
  division: "divisions",
  division_area: "divisions",
  division_boundary: "divisions",
  segment: "transportation",
  connector: "transportation",
  building: "buildings",
  building_part: "buildings",
  address: "addresses",
  infrastructure: "base",
  land: "base",
  land_use: "base",
  land_cover: "base",
  water: "base",
  bathymetry: "base",
};

// Remote queries are network-bound: gate heavy types behind higher zooms.
const MIN_ZOOM = {
  place: 12, division: 4, division_area: 4, division_boundary: 4,
  segment: 13, connector: 14, building: 15, building_part: 15, address: 15,
  infrastructure: 12, land: 10, land_use: 12, land_cover: 10, water: 10,
  bathymetry: 4,
};
const LOCAL_MIN_ZOOM_DISCOUNT = 3; // local files are fast; allow earlier loading

const PALETTE = [
  "#4c8dff", "#f0883e", "#3fb950", "#db61a2", "#e3b341",
  "#bc8cff", "#39c5cf", "#f85149", "#7ee787", "#ffa198",
  "#79c0ff", "#d2a8ff", "#56d364", "#ffab70", "#a5d6ff", "#eac54f",
];

/* ------------------------------------------------------------------ state */

const state = {
  conn: null,
  release: document.getElementById("release-input").value.trim(),
  datasets: new Map(), // name -> {name, kind:'remote'|'local', relation, columns, viewReady, data, generation}
  active: new Set(),
  colors: {},
  notes: {},
  queryChain: Promise.resolve(), // serialize queries (wasm is single-threaded anyway)
};

/* ------------------------------------------------------------------- map */

const map = new maplibregl.Map({
  container: "map",
  center: [12.5, 42.0],
  zoom: 5.4,
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
});
map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl(), "bottom-right");
window.map = map;

function whenStyleReady(fn) {
  if (map.isStyleLoaded()) { fn(); return; }
  setTimeout(() => whenStyleReady(fn), 150);
}

/* ------------------------------------------------------------ WKB parser */

// Minimal WKB -> GeoJSON geometry converter (2D output; Z/M values skipped).
// Handles (E)WKB byte order, SRID flags and ISO 1000/2000/3000 type offsets.
function wkbToGeoJSON(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  function geom() {
    const little = view.getUint8(offset) === 1;
    offset += 1;
    let type = view.getUint32(offset, little);
    offset += 4;
    let extraDims = 0;
    if (type & 0x80000000) extraDims += 1; // EWKB Z
    if (type & 0x40000000) extraDims += 1; // EWKB M
    if (type & 0x20000000) offset += 4;    // EWKB SRID: skip
    type &= 0x0fffffff;
    if (type >= 3000) { extraDims += 2; type -= 3000; }
    else if (type >= 2000) { extraDims += 1; type -= 2000; }
    else if (type >= 1000) { extraDims += 1; type -= 1000; }

    const u32 = () => { const v = view.getUint32(offset, little); offset += 4; return v; };
    const point = () => {
      const c = [view.getFloat64(offset, little), view.getFloat64(offset + 8, little)];
      offset += (2 + extraDims) * 8;
      return c;
    };
    const ring = () => Array.from({ length: u32() }, point);

    switch (type) {
      case 1: return { type: "Point", coordinates: point() };
      case 2: return { type: "LineString", coordinates: ring() };
      case 3: return { type: "Polygon", coordinates: Array.from({ length: u32() }, ring) };
      case 4: return { type: "MultiPoint", coordinates: Array.from({ length: u32() }, () => geom().coordinates) };
      case 5: return { type: "MultiLineString", coordinates: Array.from({ length: u32() }, () => geom().coordinates) };
      case 6: return { type: "MultiPolygon", coordinates: Array.from({ length: u32() }, () => geom().coordinates) };
      case 7: return { type: "GeometryCollection", geometries: Array.from({ length: u32() }, geom) };
      default: throw new Error("Unsupported WKB geometry type " + type);
    }
  }
  return geom();
}

/* --------------------------------------------------------------- helpers */

function setStatus(text) { document.getElementById("status-line").textContent = text; }

function setEngineStatus(text, cls) {
  const el = document.getElementById("engine-status");
  el.textContent = text;
  el.className = cls || "muted";
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function jsValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v) <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && typeof v.toJSON === "function") return sanitize(v.toJSON());
  return v;
}

function sanitize(v) {
  if (typeof v === "bigint") return Number(v) <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = sanitize(v[k]);
    return out;
  }
  return v;
}

// Serialize all DuckDB work through one chain: predictable, and the engine is
// single-threaded regardless.
function query(sql) {
  const run = async () => {
    const table = await state.conn.query(sql);
    const columns = table.schema.fields.map((f) => f.name);
    const rows = table.toArray().map((r) => columns.map((c) => jsValue(r[c])));
    return { columns, rows };
  };
  const p = state.queryChain.then(run, run);
  state.queryChain = p.catch(() => {});
  return p;
}

/* ------------------------------------------------------------ engine init */

async function initEngine() {
  const bundle = {
    mainModule: new URL("./vendor/duckdb/duckdb-eh.wasm", import.meta.url).href,
    mainWorker: new URL("./vendor/duckdb/duckdb-browser-eh.worker.js", import.meta.url).href,
  };
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule);
  state.db = db;
  state.conn = await db.connect();
  await query("SET s3_region='us-west-2'");
  // Read GeoParquet geometry as raw WKB blobs (parsed in JS): the automatic
  // GEOMETRY conversion needs the spatial extension and crashes this build.
  await query("SET enable_geoparquet_conversion=false").catch(() => {});
  if (await loadParquetExtension()) {
    setEngineStatus("DuckDB ready — data loads straight from Overture S3", "ready");
  }
}

// duckdb-wasm ships the parquet reader as a runtime-loadable extension. Prefer
// a copy self-hosted next to the app (placed there by the deploy workflow);
// fall back to the official extension CDN. Keep the version segment in sync
// with the vendored duckdb-wasm build (see .github/workflows/pages.yml).
const DUCKDB_CORE_VERSION = "v1.4.3";

async function loadParquetExtension() {
  const localRepo = new URL("./vendor/duckdb/extensions", location.href).href;
  const localFile = `${localRepo}/${DUCKDB_CORE_VERSION}/wasm_eh/parquet.duckdb_extension.wasm`;
  try {
    const head = await fetch(localFile, { method: "HEAD" });
    if (!head.ok) throw new Error("no self-hosted extension");
    await query(`SET custom_extension_repository='${localRepo}'`);
    await query("INSTALL parquet");
    await query("LOAD parquet");
    return true;
  } catch (err) {
    await query("RESET custom_extension_repository").catch(() => {});
  }
  try {
    await query("INSTALL parquet");
    await query("LOAD parquet");
    return true;
  } catch (err) {
    console.warn("parquet extension preload failed:", err);
    setEngineStatus("DuckDB started, but the parquet extension could not be fetched — queries may fail (check network access to extensions.duckdb.org)", "error");
    return false;
  }
}

/* -------------------------------------------------------------- datasets */

function remoteSource(type) {
  return `${S3_BASE}/${state.release}/theme=${OVERTURE_TYPES[type]}/type=${type}/*.parquet`;
}

function registerRemoteDatasets() {
  Object.keys(OVERTURE_TYPES).forEach((type) => {
    if (!state.datasets.has(type)) {
      state.datasets.set(type, {
        name: type, kind: "remote", columns: null, viewReady: false,
        data: { type: "FeatureCollection", features: [] }, generation: 0,
      });
    } else {
      const ds = state.datasets.get(type);
      ds.viewReady = false; // release changed: view must be recreated
      ds.columns = null;
    }
  });
}

function datasetRelation(ds) {
  if (ds.kind === "local") return `read_parquet('${ds.file}')`;
  return `read_parquet('${remoteSource(ds.name)}', hive_partitioning=true)`;
}

async function ensureView(ds) {
  if (ds.viewReady) return;
  await query(`CREATE OR REPLACE VIEW "${ds.name}" AS SELECT * FROM ${datasetRelation(ds)}`);
  const described = await query(`DESCRIBE SELECT * FROM "${ds.name}"`);
  ds.columns = {};
  described.rows.forEach(([name, coltype]) => { ds.columns[name] = coltype; });
  ds.viewReady = true;
  updateSqlViewsHint();
}

function updateSqlViewsHint() {
  const ready = [...state.datasets.values()].filter((d) => d.viewReady).map((d) => d.name);
  document.getElementById("sql-views").textContent = ready.length ? ready.join(", ") : "—";
}

const SCALAR_TYPES = /^(VARCHAR|BIGINT|INTEGER|SMALLINT|TINYINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|DOUBLE|FLOAT|DECIMAL|BOOLEAN|DATE|TIMESTAMP)/;

function propertyColumns(ds) {
  const props = {};
  for (const [col, coltype] of Object.entries(ds.columns)) {
    if (col === "geometry" || col === "bbox") continue;
    if (SCALAR_TYPES.test(coltype)) props[col] = `"${col}"`;
  }
  if ((ds.columns.names || "").startsWith("STRUCT")) props.name = 'names."primary"';
  if ((ds.columns.categories || "").startsWith("STRUCT")) props.category = 'categories."primary"';
  return props;
}

function geometrySelect(ds) {
  // Without the spatial extension GeoParquet geometry arrives as WKB BLOB,
  // which is exactly what our JS parser wants. If a build ever surfaces it as
  // GEOMETRY (spatial autoloaded), convert back to WKB.
  const t = ds.columns.geometry || "";
  return t.startsWith("GEOMETRY") ? 'ST_AsWKB("geometry")' : '"geometry"';
}

function minZoom(ds) {
  const base = MIN_ZOOM[ds.name] !== undefined ? MIN_ZOOM[ds.name] : 10;
  return ds.kind === "local" ? Math.max(0, base - LOCAL_MIN_ZOOM_DISCOUNT) : base;
}

/* ----------------------------------------------------------- layer panel */

function renderLayerList() {
  const listEl = document.getElementById("layer-list");
  listEl.innerHTML = "";
  let i = 0;
  for (const ds of state.datasets.values()) {
    state.colors[ds.name] = state.colors[ds.name] || PALETTE[i % PALETTE.length];
    listEl.appendChild(layerRow(ds));
    i += 1;
  }
}

function layerRow(ds) {
  const row = document.createElement("div");
  row.className = "layer-row";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.active.has(ds.name);
  cb.addEventListener("change", () => toggleLayer(ds.name, cb.checked));

  const swatch = document.createElement("span");
  swatch.className = "layer-swatch";
  swatch.style.background = state.colors[ds.name];

  const name = document.createElement("span");
  name.className = "layer-name";
  name.textContent = ds.name;
  name.title = ds.kind === "remote" ? remoteSource(ds.name) : ds.file;

  const badge = document.createElement("span");
  badge.className = "layer-badge";
  badge.textContent = ds.kind === "remote" ? "s3" : "local";

  const exportBtn = document.createElement("button");
  exportBtn.className = "layer-export";
  exportBtn.title = "Download currently loaded features as GeoJSON";
  exportBtn.textContent = "⬇";
  exportBtn.addEventListener("click", () => exportGeoJSON(ds));

  const note = document.createElement("span");
  note.className = "layer-note";
  state.notes[ds.name] = note;

  row.append(cb, swatch, name, badge, note, exportBtn);
  return row;
}

function toggleLayer(name, on) {
  const ds = state.datasets.get(name);
  if (on) {
    state.active.add(name);
    whenStyleReady(() => {
      ensureMapLayers(name);
      refreshLayer(ds);
    });
  } else {
    state.active.delete(name);
    ds.generation += 1; // invalidate any in-flight load
    state.notes[name].textContent = "";
    const src = map.getSource("src-" + name);
    if (src) src.setData({ type: "FeatureCollection", features: [] });
  }
}

function ensureMapLayers(name) {
  const srcId = "src-" + name;
  if (map.getSource(srcId)) return;
  const color = state.colors[name];
  map.addSource(srcId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "fill-" + name, type: "fill", source: srcId,
    filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "MultiPolygon"]],
    paint: { "fill-color": color, "fill-opacity": 0.25 },
  });
  map.addLayer({
    id: "line-" + name, type: "line", source: srcId,
    filter: ["any",
      ["==", ["geometry-type"], "LineString"], ["==", ["geometry-type"], "MultiLineString"],
      ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "MultiPolygon"]],
    paint: { "line-color": color, "line-width": 1.4 },
  });
  map.addLayer({
    id: "circle-" + name, type: "circle", source: srcId,
    filter: ["any", ["==", ["geometry-type"], "Point"], ["==", ["geometry-type"], "MultiPoint"]],
    paint: {
      "circle-color": color, "circle-radius": 4.5,
      "circle-stroke-color": "#ffffff", "circle-stroke-width": 1,
    },
  });
  ["fill-" + name, "line-" + name, "circle-" + name].forEach((layerId) => {
    map.on("click", layerId, (e) => showFeaturePopup(e, name));
    map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
  });
}

async function fetchFeatures(ds, bbox, limit, search) {
  await ensureView(ds);
  const props = propertyColumns(ds);
  const select = Object.entries(props).map(([alias, expr]) => `${expr} AS "${alias}"`);
  select.push(`${geometrySelect(ds)} AS __wkb`);

  const where = [];
  if (bbox) {
    const [xmin, ymin, xmax, ymax] = bbox;
    if ((ds.columns.bbox || "").startsWith("STRUCT")) {
      where.push(`bbox.xmin <= ${xmax} AND bbox.xmax >= ${xmin} AND bbox.ymin <= ${ymax} AND bbox.ymax >= ${ymin}`);
    }
  }
  if (search && props.name) {
    where.push(`${props.name} ILIKE '%${search.replace(/'/g, "''")}%'`);
  }
  let sql = `SELECT ${select.join(", ")} FROM "${ds.name}"`;
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += ` LIMIT ${Math.floor(limit)}`;

  const { columns, rows } = await query(sql);
  const wkbIdx = columns.indexOf("__wkb");
  const features = [];
  for (const row of rows) {
    let geometry = null;
    try { if (row[wkbIdx]) geometry = wkbToGeoJSON(row[wkbIdx]); } catch (e) { /* skip bad geometry */ }
    if (!geometry) continue;
    const properties = {};
    columns.forEach((c, i) => {
      if (i !== wkbIdx && row[i] !== null && !(row[i] instanceof Uint8Array)) properties[c] = row[i];
    });
    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features, truncated: rows.length >= limit };
}

async function refreshLayer(ds) {
  const note = state.notes[ds.name];
  const src = map.getSource("src-" + ds.name);
  if (!src || !state.conn) return;

  const zoom = map.getZoom();
  if (zoom < minZoom(ds)) {
    note.textContent = "zoom ≥ " + minZoom(ds);
    src.setData({ type: "FeatureCollection", features: [] });
    return;
  }

  const generation = ++ds.generation;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const limit = Number(document.getElementById("limit-input").value) || 1000;

  note.innerHTML = "<span class='spinner'>⏳</span>";
  try {
    const fc = await fetchFeatures(ds, bbox, limit);
    if (generation !== ds.generation || !state.active.has(ds.name)) return; // stale
    ds.data = fc;
    src.setData(fc);
    note.textContent = fc.truncated ? "⚠ " + fc.features.length + " (truncated)" : String(fc.features.length);
  } catch (err) {
    if (generation !== ds.generation) return;
    note.textContent = "error";
    note.title = String(err);
    console.error(ds.name, err);
  }
}

function refreshActiveLayers() {
  state.active.forEach((name) => refreshLayer(state.datasets.get(name)));
}

let moveTimer = null;
map.on("moveend", () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(refreshActiveLayers, 300);
});

document.getElementById("limit-input").addEventListener("change", refreshActiveLayers);

document.getElementById("release-input").addEventListener("change", (e) => {
  state.release = e.target.value.trim();
  registerRemoteDatasets();
  renderLayerList();
  refreshActiveLayers();
});

/* ------------------------------------------------------------ local files */

document.getElementById("local-file-btn").addEventListener("click", () =>
  document.getElementById("local-file-input").click());

document.getElementById("local-file-input").addEventListener("change", async (e) => {
  for (const file of e.target.files) {
    let name = file.name.replace(/\.(geo)?parquet$/i, "").replace(/^italy_/, "");
    name = name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() || "local";
    if (state.datasets.has(name) && state.datasets.get(name).kind === "remote") name += "_local";
    try {
      await registerLocalFile(file);
      const ds = {
        name, kind: "local", file: file.name, columns: null, viewReady: false,
        data: { type: "FeatureCollection", features: [] }, generation: 0,
      };
      state.datasets.set(name, ds);
      await ensureView(ds);
      setStatus(`Opened ${file.name} as '${name}'`);
    } catch (err) {
      setStatus(`Failed to open ${file.name}: ${err}`);
      console.error(err);
    }
  }
  renderLayerList();
  e.target.value = "";
});

// Load the file into wasm memory. (Streaming BROWSER_FILEREADER handles crash
// the engine in duckdb-wasm 1.32, so buffer the bytes instead — fine for the
// per-type Italy extracts, but keep multi-GB files in the desktop tools.)
async function registerLocalFile(file) {
  if (file.size > 1_500_000_000) {
    throw new Error("File too large to load in browser memory (~1.5 GB max)");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await state.db.registerFileBuffer(file.name, bytes);
}

/* -------------------------------------------------------------- exports */

function exportGeoJSON(ds) {
  const fc = { type: "FeatureCollection", features: ds.data.features };
  if (!fc.features.length) {
    setStatus(`No loaded features to export for '${ds.name}' — enable the layer first.`);
    return;
  }
  const blob = new Blob([JSON.stringify(fc)], { type: "application/geo+json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `overture_${ds.name}.geojson`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* --------------------------------------------------------------- popups */

function showFeaturePopup(e, datasetName) {
  const f = e.features && e.features[0];
  if (!f) return;
  const props = f.properties || {};
  const title = props.name || props.id || datasetName;
  let html = "<div class='popup-title'>" + escapeHtml(String(title)) + "</div>";
  html += "<table class='popup-table'>";
  html += "<tr><td>dataset</td><td>" + escapeHtml(datasetName) + "</td></tr>";
  Object.keys(props).forEach((k) => {
    html += "<tr><td>" + escapeHtml(k) + "</td><td>" + escapeHtml(String(props[k])) + "</td></tr>";
  });
  html += "</table>";
  new maplibregl.Popup({ maxWidth: "340px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
}

/* --------------------------------------------------------------- search */

let searchTimer = null;
document.getElementById("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) {
    document.getElementById("search-results").innerHTML = "";
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 350);
});

async function runSearch(q) {
  const out = document.getElementById("search-results");
  out.innerHTML = "<p class='muted'>Searching current view…</p>";
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

  // Prefer local datasets (fast), then remote place.
  const candidates = [...state.datasets.values()]
    .filter((d) => d.kind === "local" || d.name === "place")
    .sort((a, b2) => (a.kind === "local" ? -1 : 1) - (b2.kind === "local" ? -1 : 1));

  const hits = [];
  for (const ds of candidates) {
    if (hits.length >= 20) break;
    try {
      const fc = await fetchFeatures(ds, bbox, 20 - hits.length, q);
      fc.features.forEach((f) => hits.push({ ds: ds.name, f }));
    } catch (err) { /* dataset may not have names or be unreachable */ }
  }

  if (!hits.length) {
    out.innerHTML = "<p class='muted'>No matches in the current view.</p>";
    return;
  }
  out.innerHTML = "";
  hits.forEach(({ ds, f }) => {
    const div = document.createElement("div");
    div.className = "search-hit";
    const meta = [ds, f.properties.category].filter(Boolean).join(" · ");
    div.innerHTML =
      "<span class='hit-name'>" + escapeHtml(f.properties.name || "(unnamed)") + "</span>" +
      "<span class='hit-meta'>" + escapeHtml(meta) + "</span>";
    div.addEventListener("click", () => {
      const c = centroid(f.geometry);
      map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 15) });
      new maplibregl.Popup().setLngLat(c)
        .setHTML("<div class='popup-title'>" + escapeHtml(f.properties.name || "") + "</div>")
        .addTo(map);
    });
    out.appendChild(div);
  });
}

function centroid(geometry) {
  const coords = [];
  (function collect(c) {
    if (typeof c[0] === "number") coords.push(c);
    else c.forEach(collect);
  })(geometry.type === "GeometryCollection" ? geometry.geometries.map((g) => g.coordinates) : geometry.coordinates);
  const sum = coords.reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1]], [0, 0]);
  return [sum[0] / coords.length, sum[1] / coords.length];
}

/* ------------------------------------------------------------------- SQL */

const SQL_SOURCE = "sql-result";

function ensureSqlLayers() {
  if (map.getSource(SQL_SOURCE)) return;
  map.addSource(SQL_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "sql-fill", type: "fill", source: SQL_SOURCE,
    filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "MultiPolygon"]],
    paint: { "fill-color": "#ff3ba7", "fill-opacity": 0.3 },
  });
  map.addLayer({
    id: "sql-line", type: "line", source: SQL_SOURCE,
    paint: { "line-color": "#ff3ba7", "line-width": 2 },
  });
  map.addLayer({
    id: "sql-circle", type: "circle", source: SQL_SOURCE,
    filter: ["any", ["==", ["geometry-type"], "Point"], ["==", ["geometry-type"], "MultiPoint"]],
    paint: { "circle-color": "#ff3ba7", "circle-radius": 5, "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
  });
}

async function runSql() {
  const sql = document.getElementById("sql-input").value.trim().replace(/;\s*$/, "");
  const statusEl = document.getElementById("sql-status");
  const resultsEl = document.getElementById("sql-results");
  statusEl.className = "muted";
  statusEl.textContent = "Running…";
  resultsEl.innerHTML = "";
  const started = performance.now();
  try {
    // Make sure views referenced by name exist before the query runs.
    for (const ds of state.datasets.values()) {
      if (!ds.viewReady && new RegExp(`\\b${ds.name}\\b`, "i").test(sql)) {
        try { await ensureView(ds); } catch (e) { /* let the query surface the error */ }
      }
    }
    const { columns, rows } = await query(sql);
    const ms = Math.round(performance.now() - started);
    const shown = rows.slice(0, 500);
    statusEl.textContent = rows.length + " row(s) in " + ms + " ms" +
      (rows.length > 500 ? " (showing first 500)" : "");
    renderSqlTable(columns, shown, resultsEl);
    plotSqlGeometries(columns, shown);
  } catch (err) {
    statusEl.className = "error";
    statusEl.textContent = String(err.message || err);
  }
}

function renderSqlTable(columns, rows, el) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((v) => {
      const td = document.createElement("td");
      let text;
      if (v === null || v === undefined) text = "";
      else if (v instanceof Uint8Array) text = "<wkb " + v.length + " bytes>";
      else if (typeof v === "object") text = JSON.stringify(v);
      else text = String(v);
      td.textContent = text.length > 300 ? text.slice(0, 300) + "…" : text;
      td.title = text.slice(0, 1000);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  el.appendChild(table);
}

function plotSqlGeometries(columns, rows) {
  if (!rows.length) return;
  // Find the first column whose binary values parse as WKB.
  let geomIdx = -1;
  for (let i = 0; i < columns.length; i++) {
    const sample = rows.find((r) => r[i] instanceof Uint8Array);
    if (!sample) continue;
    try { wkbToGeoJSON(sample[i]); geomIdx = i; break; } catch (e) { /* not WKB */ }
  }
  if (geomIdx === -1) return;

  const features = [];
  rows.forEach((row) => {
    if (!(row[geomIdx] instanceof Uint8Array)) return;
    try {
      const geometry = wkbToGeoJSON(row[geomIdx]);
      const properties = {};
      columns.forEach((c, i) => {
        if (i !== geomIdx && row[i] !== null && typeof row[i] !== "object") properties[c] = row[i];
      });
      features.push({ type: "Feature", geometry, properties });
    } catch (e) { /* skip */ }
  });
  if (!features.length) return;
  whenStyleReady(() => {
    ensureSqlLayers();
    map.getSource(SQL_SOURCE).setData({ type: "FeatureCollection", features });
  });
  document.getElementById("sql-status").textContent += " — " + features.length + " geometry(ies) on map";
}

document.getElementById("sql-run").addEventListener("click", runSql);
document.getElementById("sql-input").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runSql();
});
document.getElementById("sql-clear-map").addEventListener("click", () => {
  const src = map.getSource(SQL_SOURCE);
  if (src) src.setData({ type: "FeatureCollection", features: [] });
});

/* ------------------------------------------------------------------ tabs */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
  });
});

/* ------------------------------------------------------------------ init */

registerRemoteDatasets();
renderLayerList();
setStatus(Object.keys(OVERTURE_TYPES).length + " Overture feature types available");

initEngine().catch((err) => {
  setEngineStatus("DuckDB failed to start: " + err, "error");
  console.error(err);
});

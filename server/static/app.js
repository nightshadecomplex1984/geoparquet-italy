/* Overture Italy GeoParquet explorer — map + layer control + search + SQL console. */

"use strict";

// Datasets that are heavy get a minimum zoom before we query them.
const MIN_ZOOM = {
  building: 14, building_part: 14, address: 14,
  segment: 11, connector: 12, land_use: 11, infrastructure: 10,
  land_cover: 9, land: 9, water: 8, place: 10,
  bathymetry: 5, division: 0, division_area: 0, division_boundary: 0, boundary: 0,
};
const DEFAULT_MIN_ZOOM = 8;

const PALETTE = [
  "#4c8dff", "#f0883e", "#3fb950", "#db61a2", "#e3b341",
  "#bc8cff", "#39c5cf", "#f85149", "#7ee787", "#ffa198",
  "#79c0ff", "#d2a8ff", "#56d364", "#ffab70", "#a5d6ff", "#eac54f",
];

const state = {
  datasets: [],           // from /api/datasets
  active: new Set(),      // enabled dataset names
  colors: {},             // dataset -> color
  notes: {},              // dataset -> status note element
  controllers: {},        // dataset -> AbortController
};

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
window.map = map; // handy for debugging in the console

// Run fn once the style is usable. The map 'load' event can stall when basemap
// tiles are unreachable (offline use), so don't gate app startup on it.
function whenStyleReady(fn) {
  if (map.isStyleLoaded()) { fn(); return; }
  setTimeout(() => whenStyleReady(fn), 150);
}

/* ---------------------------------------------------------------- tabs */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
  });
});

/* ------------------------------------------------------------- helpers */

function setStatus(text) {
  document.getElementById("status-line").textContent = text;
}

function fmtCount(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
}

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
  return (b / 1e3).toFixed(0) + " kB";
}

function minZoom(name) {
  return MIN_ZOOM[name] !== undefined ? MIN_ZOOM[name] : DEFAULT_MIN_ZOOM;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (e) { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

/* -------------------------------------------------------- layer panel */

async function loadDatasets() {
  const listEl = document.getElementById("layer-list");
  try {
    const data = await api("/api/datasets");
    state.datasets = data.datasets;
    if (!state.datasets.length) {
      listEl.innerHTML =
        "<p class='muted'>No GeoParquet files found in <code>" + data.data_dir +
        "</code>.<br><br>Download some first, e.g.:<br>" +
        "<code>python scripts/download_italy.py --types place</code></p>";
      return;
    }
    listEl.innerHTML = "";
    state.datasets.forEach((ds, i) => {
      state.colors[ds.name] = state.colors[ds.name] || PALETTE[i % PALETTE.length];
      listEl.appendChild(layerRow(ds));
    });
    document.getElementById("sql-views").textContent =
      state.datasets.map((d) => d.name).join(", ");
    setStatus(state.datasets.length + " dataset(s) in " + data.data_dir);
  } catch (err) {
    listEl.innerHTML = "<p class='muted'>Failed to load datasets: " + err.message + "</p>";
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
  name.title = ds.file;

  const meta = document.createElement("span");
  meta.className = "layer-meta";
  meta.textContent = fmtCount(ds.rows) + " · " + fmtBytes(ds.size_bytes);

  const note = document.createElement("span");
  note.className = "layer-note";
  state.notes[ds.name] = note;

  row.append(cb, swatch, name, meta, note);
  return row;
}

function toggleLayer(name, on) {
  if (on) {
    state.active.add(name);
    whenStyleReady(() => {
      ensureMapLayers(name);
      refreshLayer(name);
    });
  } else {
    state.active.delete(name);
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

async function refreshLayer(name) {
  const note = state.notes[name];
  const zoom = map.getZoom();
  const src = map.getSource("src-" + name);
  if (!src) return;

  if (zoom < minZoom(name)) {
    note.textContent = "zoom ≥ " + minZoom(name);
    src.setData({ type: "FeatureCollection", features: [] });
    return;
  }

  if (state.controllers[name]) state.controllers[name].abort();
  const controller = new AbortController();
  state.controllers[name] = controller;

  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    .map((v) => v.toFixed(5)).join(",");
  const limit = document.getElementById("limit-input").value || 4000;

  note.textContent = "…";
  try {
    const fc = await api(
      "/api/datasets/" + name + "/features?bbox=" + bbox + "&limit=" + limit,
      { signal: controller.signal }
    );
    src.setData(fc);
    note.textContent = fc.truncated
      ? "⚠ " + fc.features.length + " (truncated)"
      : String(fc.features.length);
  } catch (err) {
    if (err.name !== "AbortError") note.textContent = "error";
  }
}

function refreshActiveLayers() {
  state.active.forEach((name) => refreshLayer(name));
}

let moveTimer = null;
map.on("moveend", () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(refreshActiveLayers, 250);
});

document.getElementById("limit-input").addEventListener("change", refreshActiveLayers);
document.getElementById("refresh-btn").addEventListener("click", loadDatasets);

/* ---------------------------------------------------------- popups */

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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------------------------------------------------------- search */

let searchTimer = null;
document.getElementById("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) {
    document.getElementById("search-results").innerHTML = "";
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 300);
});

async function runSearch(q) {
  const out = document.getElementById("search-results");
  out.innerHTML = "<p class='muted'>Searching…</p>";
  try {
    const data = await api("/api/search?q=" + encodeURIComponent(q));
    if (!data.results.length) {
      out.innerHTML = "<p class='muted'>No matches.</p>";
      return;
    }
    out.innerHTML = "";
    data.results.forEach((hit) => {
      const div = document.createElement("div");
      div.className = "search-hit";
      const meta = [hit.dataset, hit.category].filter(Boolean).join(" · ");
      div.innerHTML =
        "<span class='hit-name'>" + escapeHtml(hit.name || "(unnamed)") + "</span>" +
        "<span class='hit-meta'>" + escapeHtml(meta) + "</span>";
      div.addEventListener("click", () => {
        map.flyTo({ center: [hit.lon, hit.lat], zoom: Math.max(map.getZoom(), 15) });
        new maplibregl.Popup()
          .setLngLat([hit.lon, hit.lat])
          .setHTML("<div class='popup-title'>" + escapeHtml(hit.name || "") + "</div>")
          .addTo(map);
      });
      out.appendChild(div);
    });
  } catch (err) {
    out.innerHTML = "<p class='muted'>Search failed: " + escapeHtml(err.message) + "</p>";
  }
}

/* ------------------------------------------------------------- SQL */

const SQL_SOURCE = "sql-result";

function plotSqlFeatures(features) {
  whenStyleReady(() => {
    ensureSqlLayers();
    map.getSource(SQL_SOURCE).setData({ type: "FeatureCollection", features });
  });
}

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
  const sql = document.getElementById("sql-input").value;
  const statusEl = document.getElementById("sql-status");
  const resultsEl = document.getElementById("sql-results");
  statusEl.className = "muted";
  statusEl.textContent = "Running…";
  resultsEl.innerHTML = "";
  const started = performance.now();
  try {
    const data = await api("/api/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const ms = Math.round(performance.now() - started);
    statusEl.textContent =
      data.rows.length + " row(s) in " + ms + " ms" + (data.truncated ? " (truncated)" : "");
    renderSqlTable(data, resultsEl);
    plotSqlGeometries(data);
  } catch (err) {
    statusEl.className = "error";
    statusEl.textContent = err.message;
  }
}

function renderSqlTable(data, el) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  data.columns.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  data.rows.forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((v) => {
      const td = document.createElement("td");
      const text = v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      td.textContent = text.length > 300 ? text.slice(0, 300) + "…" : text;
      td.title = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  el.appendChild(table);
}

function plotSqlGeometries(data) {
  if (!data.geometry_columns.length) return;
  const geomIdx = data.columns.indexOf(data.geometry_columns[0]);
  const features = [];
  data.rows.forEach((row) => {
    const raw = row[geomIdx];
    if (!raw) return;
    try {
      const geometry = typeof raw === "string" ? JSON.parse(raw) : raw;
      const properties = {};
      data.columns.forEach((c, i) => {
        if (i !== geomIdx && row[i] !== null && typeof row[i] !== "object") properties[c] = row[i];
      });
      features.push({ type: "Feature", geometry, properties });
    } catch (e) { /* skip unparsable geometry */ }
  });
  plotSqlFeatures(features);
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

/* ------------------------------------------------------------- init */

loadDatasets();

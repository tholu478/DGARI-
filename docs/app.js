// DGARI flood prototype: dashboard logic.
// The page reads three files made by pipeline/run_pipeline.py:
//   summary.json   - period, data sources, thresholds, counts
//   states.geojson - state shapes with results attached
// and draws the map, the cards, the detail panel and the table.

// The periods the viewer can choose. The historical example is optional: if
// its files are missing, the option is simply not shown.
const PERIODS = [
  { dir: "data", label: "Latest available CHIRPS data" },
  { dir: "data/example-2022-09", label: "Historical example: Jul–Sep 2022", example: true },
];

const FLAG_LABEL = { warning: "Warning", watch: "Watch", normal: "Normal" };
const FLAG_FILL = { warning: "#dc2626", watch: "#f08c00", normal: "#9db8f5" };
const fmt = (n, d = 0) => (n == null ? "–" : Number(n).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let map, layer, summary, features = [], selectedIso = null;

// ---------- Map setup: no background tiles, so it loads on slow connections ----------
function initMap() {
  map = L.map("map", { zoomSnap: 0.25, attributionControl: true, scrollWheelZoom: false });
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution("Rainfall: CHIRPS v3.0 (UCSB CHC) · Boundaries: geoBoundaries / GRID3");
  map.setView([9.1, 8.7], 6);
}

function styleFor(f) {
  const selected = f.properties.shapeISO === selectedIso;
  return {
    fillColor: FLAG_FILL[f.properties.flag] || "#d1d5db",
    fillOpacity: f.properties.flag === "normal" ? 0.55 : 0.8,
    color: selected ? "#111827" : "#ffffff",
    weight: selected ? 3 : 1.2,
  };
}

function drawMap(geojson) {
  if (layer) layer.remove();
  layer = L.geoJSON(geojson, {
    style: styleFor,
    onEachFeature: (f, lyr) => {
      const p = f.properties;
      lyr.bindTooltip(`<b>${esc(p.state)}</b><br>${FLAG_LABEL[p.flag]} · ${fmt(p.percent_of_normal)}% of normal`, { sticky: true });
      lyr.on("click", () => select(p.shapeISO));
    },
  }).addTo(map);
  map.fitBounds(layer.getBounds(), { padding: [12, 12] });
}

// ---------- Cards ----------
function fillCards() {
  const c = summary.counts;
  document.getElementById("m-warning").textContent = c.warning;
  document.getElementById("m-watch").textContent = c.watch;
  document.getElementById("m-normal").textContent = c.normal;
  document.getElementById("review-count").textContent = c.warning + c.watch;

  const d0 = new Date(summary.period_start + "T00:00Z"), d1 = new Date(summary.period_end + "T00:00Z");
  const opt = { day: "numeric", month: "short", timeZone: "UTC" };
  document.getElementById("m-period").textContent =
    `${d0.toLocaleDateString("en-GB", opt)} – ${d1.toLocaleDateString("en-GB", { ...opt, year: "numeric" })}`;
  const products = [...new Set(summary.dekads.map((d) => d.product))];
  document.getElementById("m-period-detail").textContent =
    `${summary.dekads.length} dekads · vs ${summary.baseline} average`;

  const chip = document.getElementById("product-chip");
  const period = PERIODS.find((p) => p.dir === currentDir);
  if (period.example) {
    chip.className = "chip example"; chip.textContent = "Historical example";
  } else if (products.includes("preliminary")) {
    chip.className = "chip prelim"; chip.textContent = "CHIRPS v3.0 · includes preliminary";
  } else {
    chip.className = "chip"; chip.textContent = "CHIRPS v3.0 · final";
  }
  document.getElementById("generated").textContent = summary.generated_utc;

  // Rules table, built from the same thresholds the pipeline used.
  const t = summary.thresholds;
  document.getElementById("rules-body").innerHTML = `
    <tr><td><span class="pill warning">Warning</span></td><td>≥ ${t.warning.min_percent_of_normal}%</td><td>≥ ${t.warning.min_anomaly_mm} mm above normal</td></tr>
    <tr><td><span class="pill watch">Watch</span></td><td>≥ ${t.watch.min_percent_of_normal}%</td><td>≥ ${t.watch.min_anomaly_mm} mm above normal</td></tr>
    <tr><td><span class="pill normal">Normal</span></td><td colspan="2">Everything else, including below-normal rainfall</td></tr>`;

  document.getElementById("dekad-sources").innerHTML = "Dekads used: " + summary.dekads
    .map((d) => `<a href="${esc(d.url)}">${esc(d.label)}</a> (${esc(d.product)})`).join(", ") + ".";
  const b = summary.boundary_source || {};
  if (b.boundarySource) document.getElementById("bnd-source").textContent = `${b.boundarySource}, ${b.boundaryYearRepresented}`;
  if (b.boundaryLicense) document.getElementById("bnd-license").textContent = b.boundaryLicense;
}

// ---------- Table ----------
function pctBar(p) {
  const pct = p.percent_of_normal;
  const width = pct == null ? 0 : Math.min(pct, 200) / 2; // 0-200% shown; centre line = normal
  return `<div class="pct"><span>${fmt(pct)}%</span><div class="track"><div class="fill" style="width:${width}%;background:${FLAG_FILL[p.flag]}"></div></div></div>`;
}

function fillTable() {
  const sorted = [...features].sort((a, b) => (b.properties.percent_of_normal ?? -1) - (a.properties.percent_of_normal ?? -1));
  document.getElementById("rows").innerHTML = sorted.map(({ properties: p }) => `
    <tr data-iso="${esc(p.shapeISO)}" class="${p.shapeISO === selectedIso ? "selected" : ""}" tabindex="0">
      <td>${esc(p.state)}</td>
      <td><span class="pill ${p.flag}">${FLAG_LABEL[p.flag]}</span></td>
      <td class="num">${fmt(p.recent_mm)}</td>
      <td class="num">${fmt(p.normal_mm)}</td>
      <td>${pctBar(p)}</td>
    </tr>`).join("");
}

document.getElementById("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-iso]");
  if (tr) { select(tr.dataset.iso); document.getElementById("map-section").scrollIntoView({ behavior: "smooth" }); }
});
document.getElementById("rows").addEventListener("keydown", (e) => {
  const tr = e.target.closest("tr[data-iso]");
  if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(tr.dataset.iso); }
});

// ---------- Detail panel: explain the flag in words ----------
function explain(p) {
  const t = summary.thresholds;
  const pct = p.percent_of_normal, an = p.anomaly_mm;
  if (p.flag === "warning")
    return `Rainfall was ${fmt(pct)}% of normal and ${fmt(an)} mm above it, so it meets both Warning conditions (≥${t.warning.min_percent_of_normal}% and ≥${t.warning.min_anomaly_mm} mm).`;
  if (p.flag === "watch")
    return `Rainfall was ${fmt(pct)}% of normal and ${fmt(an)} mm above it, so it meets both Watch conditions (≥${t.watch.min_percent_of_normal}% and ≥${t.watch.min_anomaly_mm} mm) but not both Warning conditions.`;
  if (pct != null && pct >= t.watch.min_percent_of_normal)
    return `Rainfall was ${fmt(pct)}% of normal, but only ${fmt(an)} mm above it. That is below the ${t.watch.min_anomaly_mm} mm minimum, so it stays Normal (common in the dry season).`;
  if (an < 0)
    return `Rainfall was below normal: ${fmt(pct)}% of the ${summary.baseline} average, ${fmt(-an)} mm less.`;
  return `Rainfall was close to normal (${fmt(pct)}% of the ${summary.baseline} average).`;
}

function select(iso) {
  selectedIso = iso;
  const f = features.find((x) => x.properties.shapeISO === iso);
  if (!f) return;
  const p = f.properties;
  layer.setStyle(styleFor);
  layer.eachLayer((l) => { if (l.feature.properties.shapeISO === iso) l.bringToFront(); });
  document.querySelectorAll("#rows tr").forEach((tr) => tr.classList.toggle("selected", tr.dataset.iso === iso));

  const max = Math.max(p.recent_mm, p.normal_mm, 1);
  const rank = p.baseline_years_drier === p.baseline_years ? `wetter than all ${p.baseline_years}`
    : p.baseline_years_drier === 0 ? `drier than all ${p.baseline_years}`
    : `wetter than ${p.baseline_years_drier} of ${p.baseline_years}`;

  document.getElementById("detail-sub").textContent = document.getElementById("m-period").textContent + " · total rainfall";
  document.getElementById("detail").innerHTML = `
    <div class="detail-name">${esc(p.state)}</div>
    <span class="pill ${p.flag}">${FLAG_LABEL[p.flag]}</span>
    <span class="muted small">&nbsp;Hazard: flood (rainfall signal only)</span>
    <div class="stat-grid">
      <div class="stat"><div class="k">Recent rainfall</div><div class="v">${fmt(p.recent_mm)} mm</div></div>
      <div class="stat"><div class="k">Normal (${esc(summary.baseline)})</div><div class="v">${fmt(p.normal_mm)} mm</div></div>
      <div class="stat"><div class="k">% of normal</div><div class="v">${fmt(p.percent_of_normal)}%</div></div>
      <div class="stat"><div class="k">Difference</div><div class="v">${p.anomaly_mm > 0 ? "+" : ""}${fmt(p.anomaly_mm)} mm</div></div>
    </div>
    <div class="compare">
      <div class="compare-row"><span>Recent</span><div class="track"><div class="fill" style="width:${(p.recent_mm / max) * 100}%;background:${FLAG_FILL[p.flag]}"></div></div></div>
      <div class="compare-row"><span>Normal</span><div class="track"><div class="fill" style="width:${(p.normal_mm / max) * 100}%;background:#9ca3af"></div></div></div>
    </div>
    <div class="why">${explain(p)}</div>
    <p class="small muted" style="margin-top:12px">Context: ${rank} baseline years for these dekads
      (range ${fmt(p.baseline_min_mm)}–${fmt(p.baseline_max_mm)} mm).</p>
    <div class="review-flag">Status: <b>not reviewed</b>. Rainfall signal only; does not
      include river levels, dam releases or local reports.</div>`;
}

// ---------- Loading a period ----------
let currentDir = PERIODS[0].dir;

async function loadPeriod(dir) {
  currentDir = dir;
  const [s, g] = await Promise.all([
    fetch(`${dir}/summary.json`).then((r) => r.json()),
    fetch(`${dir}/states.geojson`).then((r) => r.json()),
  ]);
  summary = s;
  features = g.features;
  fillCards();
  drawMap(g);
  fillTable();
  // Show the state with the highest % of normal by default, so the panel is never empty.
  const top = [...features].sort((a, b) => (b.properties.percent_of_normal ?? -1) - (a.properties.percent_of_normal ?? -1))[0];
  const keep = features.some((f) => f.properties.shapeISO === selectedIso);
  select(keep ? selectedIso : top.properties.shapeISO);
}

async function init() {
  initMap();
  const sel = document.getElementById("period");
  // Only offer periods whose data files exist.
  for (const p of PERIODS) {
    const ok = await fetch(`${p.dir}/summary.json`, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
    if (ok) sel.add(new Option(p.label, p.dir));
  }
  sel.addEventListener("change", () => loadPeriod(sel.value));
  if (sel.options.length < 2) sel.style.display = "none";
  await loadPeriod(sel.value || PERIODS[0].dir);
}

// Highlight the sidebar item for the section you jumped to.
document.querySelectorAll(".nav-item").forEach((a) => a.addEventListener("click", () => {
  document.querySelectorAll(".nav-item").forEach((x) => x.classList.toggle("active", x === a));
}));

init().catch((err) => {
  document.getElementById("detail").innerHTML =
    `<p class="muted">Could not load the data files (${esc(err.message)}). If you opened index.html directly from your computer, run a local web server instead (see README).</p>`;
});

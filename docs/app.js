// DGARI Disaster Risk Interface: screen logic.
//
// Each view follows one screen of the Figma specification (Appendix A):
//   #overview    Overview screen
//   #monitoring  Monitoring screen ("Disaster Early Warning Overview")
//   #risk        Risk Assessment screen
//   #warnings    Warning screen (public-facing view)
//   #map         Map screen
//   #settings    Settings (sidebar link; not a separate Figma screen)
//
// Data comes from files made by pipeline/run_pipeline.py:
//   data/summary.json, data/states.geojson, data/rivers.geojson

"use strict";

// ---------------------------------------------------------------- settings
const PERIODS = [
  { dir: "data", label: "Latest CHIRPS data" },
  { dir: "data/example-2022-09", label: "Sept 2022 (historical example)", example: true },
];

// DGARI readiness ratings for Nigeria, from dissertation Section 4.3.
// Used on the Risk Assessment "Governance Check" card.
const GOVERNANCE = [
  { item: "Policy & legal process", status: "Medium", dim: "Policy and Legal Framework" },
  { item: "Institutional responsibility", status: "Low–Medium", dim: "Institutional Coordination" },
  { item: "Data availability", status: "Low–Medium", dim: "Data Infrastructure" },
  { item: "Human oversight", status: "Required", dim: "Design requirement" },
  { item: "Warning communication", status: "Low", dim: "Community Alert Systems" },
];

// Signal levels shown in the interface. The pipeline gives each state a flag
// (warning / watch / normal); "normal" is split into Monitoring (rainfall at or
// above the 1991-2020 average) and Normal (below average), as in the Figma legend.
const LEVELS = {
  warning:    { key: "warning",    color: "red",   hex: "#d92d20", soft: "#fef3f2", rank: 3,
                signal: "ELEVATED", word: "Elevated", map: "Elevated / Warning", health: "Action", sev: "HIGH",
                risk: "High", banner: "FLOOD WARNING", chip: "HIGH RISK" },
  watch:      { key: "watch",      color: "amber", hex: "#f79009", soft: "#fff7e8", rank: 2,
                signal: "Elevated", word: "Watch", map: "Elevated / Advisory", health: "Watch", sev: "WATCH",
                risk: "Elevated", banner: "FLOOD WATCH", chip: "ELEVATED RISK" },
  monitoring: { key: "monitoring", color: "blue",  hex: "#155eef", soft: "#eaf2ff", rank: 1,
                signal: "Monitoring", word: "Monitoring", map: "Monitoring", health: "Stable", sev: "ADVISORY",
                risk: "Low", banner: "NO FLOOD WARNING", chip: "LOW RISK" },
  normal:     { key: "normal",     color: "green", hex: "#12b76a", soft: "#ecfdf3", rank: 0,
                signal: "Normal", word: "Normal", map: "Normal", health: "Stable", sev: "NORMAL",
                risk: "Low", banner: "NO FLOOD WARNING", chip: "LOW RISK" },
};

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }));
const icon = (name, cls = "") => `<i class="ic ${cls}" style="--i:url(assets/icons/${name}.svg)" aria-hidden="true"></i>`;
const dateGB = (iso, opts = { day: "numeric", month: "short", year: "numeric" }) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });

function levelOf(p) {
  if (p.flag === "warning") return LEVELS.warning;
  if (p.flag === "watch") return LEVELS.watch;
  return (p.percent_of_normal ?? 0) >= 100 ? LEVELS.monitoring : LEVELS.normal;
}
const byConcern = (a, b) => levelOf(b).rank - levelOf(a).rank || (b.percent_of_normal ?? -1) - (a.percent_of_normal ?? -1);

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------------------------------------------------------------- state
const store = {
  dir: localGet("period") || "data",
  periods: [],
  summary: null,
  states: [],          // list of feature.properties
  geo: null,           // states.geojson
  rivers: null,
  selected: null,      // shapeISO
  pub: { large: false, contrast: false },
};
function localGet(k) { try { return localStorage.getItem("dgari." + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem("dgari." + k, v); } catch { /* storage unavailable */ } }

const period = () => store.periods.find((p) => p.dir === store.dir) || PERIODS[0];
const stateOf = (iso) => store.states.find((s) => s.shapeISO === iso);
const ranked = () => [...store.states].sort(byConcern);
const selectedState = () => stateOf(store.selected) || ranked()[0];
const counts = () => {
  const c = { warning: 0, watch: 0, monitoring: 0, normal: 0 };
  store.states.forEach((s) => c[levelOf(s).key]++);
  return c;
};
const periodText = () => `${dateGB(store.summary.period_start, { day: "numeric", month: "short" })} – ${dateGB(store.summary.period_end)}`;

async function loadPeriod(dir) {
  const [summary, geo] = await Promise.all([
    fetch(`${dir}/summary.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch(`${dir}/states.geojson`).then((r) => r.json()),
  ]);
  store.dir = dir; store.summary = summary; store.geo = geo;
  store.states = geo.features.map((f) => f.properties);
  if (!stateOf(store.selected)) store.selected = ranked()[0].shapeISO;
  localSet("period", dir);
}

// ---------------------------------------------------------------- routing
function parseHash() {
  const [view, query] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query || "");
  return { view: view || "overview", state: params.get("s") };
}
const link = (view, iso) => `#${view}${iso ? `?s=${encodeURIComponent(iso)}` : ""}`;

let activeMaps = [];
function render() {
  const { view, state } = parseHash();
  if (state && stateOf(state)) store.selected = state;
  activeMaps.forEach((m) => { try { m.remove(); } catch { /* already gone */ } }); activeMaps = [];
  if ("speechSynthesis" in window) speechSynthesis.cancel();

  const views = { overview: viewOverview, monitoring: viewMonitoring, risk: viewRisk, map: viewMap, settings: viewSettings };
  const app = $("#app");
  if (view === "warnings") {
    app.innerHTML = viewWarnings();
    bindWarnings();
  } else {
    const v = views[view] ? view : "overview";
    app.innerHTML = officerShell(v, views[v]());
    afterRender[v]?.();
  }
  window.scrollTo(0, 0);
  document.title = `${{ overview: "Overview", monitoring: "Monitoring", risk: "Risk Assessment", warnings: "Warnings", map: "Map", settings: "Settings" }[view] || "Overview"} · DGARI`;
}
const afterRender = {};

// ---------------------------------------------------------------- officer shell
function officerShell(view, body) {
  const c = counts();
  const nav = [
    ["overview", "Overview", "diamond-percent"],
    ["monitoring", "Monitoring", "radar"],
    ["risk", "Risk Assessment", "triangle-alert"],
    ["warnings", "Warnings", "bell"],
    ["map", "Map", "hexagon"],
  ];
  const s = store.summary;
  const live = !period().example;
  return `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-name">DGARI</div><div class="brand-sub">Disaster Risk Interface</div></div>
      <nav class="side-nav" aria-label="Main">
        <div class="side-label">Navigation</div>
        <div class="nav-items">
          ${nav.map(([v, label, ic]) => `<a class="nav-item ${v === view ? "active" : ""}" href="${link(v, v === "risk" || v === "warnings" ? store.selected : null)}" ${v === view ? 'aria-current="page"' : ""}>${icon(ic)}${label}</a>`).join("")}
        </div>
        <div class="divider"></div>
        <div class="sources">
          <div class="side-label">Data sources</div>
          <div class="source" title="Not connected in this prototype"><span class="dot off"></span>NDVI<span class="note">Not connected</span></div>
          <div class="source"><span class="dot"></span>CHIRPS</div>
        </div>
        <div class="divider"></div>
        <a class="settings-link ${view === "settings" ? "active" : ""}" href="#settings">${icon("settings")}Settings</a>
      </nav>
      <div class="freshness">
        <div class="side-label">${live ? "Last sync" : "Showing"}</div>
        <div class="v">${live ? esc(syncText(s.generated_utc)) : "Sept 2022 example"}</div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="topbar-title">DGARI</div>
        <div class="officer">
          <a class="bell-btn" href="${link("warnings", store.selected)}" aria-label="Warnings (${c.warning + c.watch} flagged)">${icon("bell", "s18")}${c.warning + c.watch ? `<span class="badge">${c.warning + c.watch}</span>` : ""}</a>
          <span class="officer-name">Disaster Officer</span>
          <span class="avatar" aria-hidden="true">D</span>
        </div>
      </header>
      ${body}
    </div>
  </div>`;
}

function syncText(generated) {
  // "2026-11-05 20:17 UTC" -> "Today, 20:17 UTC" / "5 Nov, 20:17 UTC"
  const [d, t] = generated.split(" ");
  const today = new Date().toISOString().slice(0, 10);
  return `${d === today ? "Today" : dateGB(d, { day: "numeric", month: "short" })}, ${t} UTC`;
}

function liveChip() {
  if (period().example) return `<div class="live-chip archive"><span class="dot"></span>HISTORICAL DATA · SEPT 2022</div>`;
  return `<div class="live-chip"><span class="dot"></span>LIVE DATA · 1/2 SOURCES</div>`;
}

// ---------------------------------------------------------------- OVERVIEW
function viewOverview() {
  const c = counts();
  const top = ranked();
  const flagged = c.warning + c.watch;
  const fresh = !period().example && (Date.now() - new Date(store.summary.period_end + "T00:00:00Z")) / 864e5 < 30;
  const updated = `Data to ${dateGB(store.summary.period_end, { day: "numeric", month: "short" })}`;
  return `
  <main class="content">
    <div class="page-head">
      <div>
        <h1 class="h1">Overview</h1>
        <p class="lede">Summary of all monitored areas, active warnings, and system status.</p>
      </div>
      ${liveChip()}
    </div>

    <section class="metrics" aria-label="Key figures">
      <div class="card metric">
        <div class="metric-head">Active Warnings <span class="c-red">${icon("triangle-alert", "s18")}</span></div>
        <div class="metric-value c-red">${c.warning}</div>
        <div class="metric-detail">${c.warning ? "Flood — HIGH" : "No flood warning signals"}</div>
      </div>
      <div class="card metric">
        <div class="metric-head">Areas Monitored <span class="c-blue">${icon("map-pin", "s18")}</span></div>
        <div class="metric-value c-blue">${store.states.length}</div>
        <div class="metric-detail">36 states + FCT</div>
      </div>
      <div class="card metric">
        <div class="metric-head">Pending Reviews <span class="c-amber">${icon("clipboard-check", "s18")}</span></div>
        <div class="metric-value c-amber">${flagged}</div>
        <div class="metric-detail">Require human action</div>
      </div>
      <div class="card metric">
        <div class="metric-head">System Status <span class="c-green">${icon("server", "s18")}</span></div>
        <div class="metric-value ${fresh ? "c-green" : "c-amber"}">${period().example ? "Archive" : fresh ? "Online" : "Delayed"}</div>
        <div class="metric-detail">CHIRPS active · NDVI not connected</div>
      </div>
    </section>

    <section class="row">
      <div class="card alerts grow">
        <div><div class="card-title">Recent Alerts</div><div class="card-sub">All monitored areas</div></div>
        <div class="atable" role="table" aria-label="Recent alerts">
          <div class="atr head" role="row"><span>Area</span><span>Hazard</span><span>Signal</span><span>Updated</span></div>
          ${top.slice(0, 4).map((s) => { const L = levelOf(s); return `
          <a class="atr" role="row" href="${link("risk", s.shapeISO)}">
            <span class="area">${esc(s.state)}</span><span>Flood</span>
            <span class="sig c-${L.color}">${L.signal}</span><span>${updated}</span>
          </a>`; }).join("")}
        </div>
      </div>

      <div class="card quick w340">
        <div><div class="card-title">Quick Access</div><div class="card-sub">Navigate to key screens</div></div>
        <div class="qlinks">
          <a class="qlink" href="#monitoring"><div><b>Environmental Monitoring</b><span>CHIRPS rainfall signals</span></div><span class="arrow c-blue">→</span></a>
          <a class="qlink" href="${link("risk", store.selected)}"><div><b>Risk Assessment</b><span>Assisted interpretation</span></div><span class="arrow c-amber">→</span></a>
          <a class="qlink" href="${link("warnings", store.selected)}"><div><b>Issue Warning</b><span>Public notification</span></div><span class="arrow c-red">→</span></a>
        </div>
      </div>
    </section>

    <section class="row">
      <div class="card health grow">
        <div><div class="card-title">Monitored Area Health</div><div class="card-sub">Latest rainfall signal (% of normal)</div></div>
        <div class="hlist">
          ${top.slice(0, 3).map((s) => { const L = levelOf(s); const w = Math.min(s.percent_of_normal ?? 0, 200) / 2; return `
          <div class="hrow">
            <div class="hlabel"><span class="n">${esc(s.state)} · ${fmt(s.percent_of_normal)}%</span><span class="s c-${L.color}">${L.health}</span></div>
            <div class="track"><div style="width:${w}%;background:${L.hex}"></div></div>
          </div>`; }).join("")}
        </div>
      </div>

      <div class="card queue w340">
        <div><div class="card-title">Review Queue</div><div class="card-sub">Human verification required</div></div>
        <a class="qitem" href="${link("risk", top[0].shapeISO)}">
          <div class="qcount">${flagged}</div>
          <div class="qcopy"><div class="t">Signal confirmations</div>
            <div class="d">${flagged ? `Rainfall data to ${dateGB(store.summary.period_end, { day: "numeric", month: "short" })}` : "No signals waiting"}</div></div>
          <span class="arrow c-blue">→</span>
        </a>
      </div>
    </section>
  </main>`;
}

// ---------------------------------------------------------------- MONITORING
function viewMonitoring() {
  const c = counts();
  const s = store.summary;
  const withData = store.states.filter((x) => x.recent_mm != null);
  const natRecent = withData.reduce((a, x) => a + x.recent_mm, 0) / withData.length;
  const natNormal = withData.reduce((a, x) => a + x.normal_mm, 0) / withData.length;
  const natPct = (natRecent / natNormal - 1) * 100;
  const alerts = ranked().filter((x) => levelOf(x).rank >= 1);
  const trend = s.trend || [];
  const maxMm = Math.max(1, ...trend.map((t) => Math.max(t.nigeria_mm, t.nigeria_normal_mm)));
  const trendPill = natPct >= 10 ? ["amber", "Above average"] : natPct <= -10 ? ["blue", "Below average"] : ["green", "Near average"];
  const axis = trend.length ? [trend[0], trend[Math.floor(trend.length / 2)], trend[trend.length - 1]].map((t) => dateGB(t.start, { day: "numeric", month: "short" })) : [];

  return `
  <main class="content tight">
    <div class="page-head center">
      <div>
        <h1 class="h1">Disaster Early Warning Overview</h1>
        <p class="lede sm">Monitor hazards, rainfall signals, and emerging risk across Nigeria’s 36 states and the FCT.</p>
      </div>
      <label class="time-filter">${icon("calendar", "s14")}<span class="sr-only">Period</span>
        <select id="period-select">${store.periods.map((p) => `<option value="${p.dir}" ${p.dir === store.dir ? "selected" : ""}>${p.example ? p.label : `Last 30 days · ${periodText()}`}</option>`).join("")}</select>
      </label>
    </div>

    <section class="kmetrics" aria-label="Key figures">
      <div class="card kmetric">
        <div class="metric-head">Active warnings <span class="ibadge c-red" style="background:var(--red-soft)">${icon("triangle-alert")}</span></div>
        <div class="v">${c.warning}</div><div class="d c-red">${c.watch} more state${c.watch === 1 ? "" : "s"} on watch</div>
      </div>
      <div class="card kmetric">
        <div class="metric-head">States at risk <span class="ibadge c-amber" style="background:var(--amber-soft-2)">${icon("users")}</span></div>
        <div class="v">${c.warning + c.watch}</div><div class="d c-amber">${c.warning} high-priority area${c.warning === 1 ? "" : "s"}</div>
      </div>
      <div class="card kmetric">
        <div class="metric-head">Rainfall intensity <span class="ibadge c-blue" style="background:var(--blue-soft)">${icon("cloud-rain")}</span></div>
        <div class="v">${fmt(natRecent)} mm</div><div class="d c-blue">${natPct >= 0 ? "+" : "−"}${fmt(Math.abs(natPct))}% ${natPct >= 0 ? "above" : "below"} baseline</div>
      </div>
      <div class="card kmetric">
        <div class="metric-head">Data coverage <span class="ibadge c-green" style="background:var(--green-soft)">${icon("antenna")}</span></div>
        <div class="v">${s.states_with_data ?? withData.length} / ${s.states_total ?? store.states.length}</div><div class="d c-green">${fmt(((s.states_with_data ?? withData.length) / (s.states_total ?? store.states.length)) * 100)}% of states reporting</div>
      </div>
    </section>

    <section class="row">
      <div class="card mapcard grow">
        <div><div class="card-title">Regional Risk Map</div><div class="card-sub sm">State rainfall signal · ${periodText()}</div></div>
        <div id="minimap" class="minimap" role="img" aria-label="Map of Nigerian states coloured by rainfall signal"></div>
        <div class="legend-row"><span><i class="mk" style="background:var(--red)"></i>Elevated risk zone</span><span><i class="mk" style="background:var(--amber)"></i>Watch</span><span><i class="mk" style="background:#5b8def"></i>Monitoring</span></div>
      </div>

      <div class="card active-alerts w376" id="active-alerts">
        <div class="aa-head">
          <div><div class="card-title">Active Alerts</div><div class="card-sub sm">${c.warning + c.watch} event${c.warning + c.watch === 1 ? "" : "s"} require${c.warning + c.watch === 1 ? "s" : ""} attention</div></div>
          ${alerts.length > 3 ? `<button class="view-all" id="view-all" aria-expanded="false">View all →</button>` : ""}
        </div>
        <div class="aa-list">
          ${alerts.length ? alerts.map((x, i) => alertItem(x, i >= 3)).join("") : `<p class="card-sub sm">No state has rainfall above its 1991–2020 average for this period.</p>`}
        </div>
      </div>
    </section>

    <section class="card trend">
      <div class="trend-head">
        <div><div class="card-title">Rainfall Trend</div><div class="card-sub sm">Last ${trend.length || 12} dekads (10-day periods) · CHIRPS estimates · Nigeria average</div></div>
        <span class="pill ${trendPill[0]}">${trendPill[1]}</span>
      </div>
      ${trend.length ? "" : `<p class="card-sub sm">Trend data is still being prepared by the automatic data refresh.</p>`}
      <div class="chart" role="img" aria-label="Bar chart of rainfall per 10-day period">
        ${trend.map((t) => { const hi = t.nigeria_mm >= 1.25 * t.nigeria_normal_mm && t.nigeria_mm - t.nigeria_normal_mm >= 5; return `
        <div class="bar ${hi ? "hi" : ""}" tabindex="0" style="height:${(t.nigeria_mm / maxMm) * 100}%">
          <span class="tip">${esc(t.label)}: ${fmt(t.nigeria_mm)} mm (normal ${fmt(t.nigeria_normal_mm)})${t.product === "preliminary" ? " · preliminary" : ""}</span></div>`; }).join("")}
      </div>
      <div class="axis">${axis.map((a) => `<span>${a}</span>`).join("")}</div>
    </section>
  </main>`;
}

function alertItem(x, hidden) {
  const L = levelOf(x);
  const title = { warning: "Rainfall far above normal", watch: "Rainfall well above normal", monitoring: "Rainfall above normal" }[L.key];
  return `<a class="aa-item" href="${link("risk", x.shapeISO)}" ${hidden ? 'data-extra hidden' : ""}>
    <span class="sev ${L.color}">${L.sev}</span>
    <span class="aa-copy"><span class="t">${title}</span><span class="d">${esc(x.state)} · ${fmt(x.percent_of_normal)}% of normal</span></span>
  </a>`;
}

afterRender.monitoring = () => {
  $("#period-select").addEventListener("change", async (e) => { await loadPeriod(e.target.value); render(); });
  $("#view-all")?.addEventListener("click", (e) => {
    const open = e.target.getAttribute("aria-expanded") !== "true";
    e.target.setAttribute("aria-expanded", open);
    e.target.textContent = open ? "Show less" : "View all →";
    $("#active-alerts").classList.toggle("open", open);
    document.querySelectorAll("[data-extra]").forEach((el) => (el.hidden = !open));
  });
  makeMap("minimap", { compact: true });
};

// ---------------------------------------------------------------- RISK ASSESSMENT
function viewRisk() {
  const s = selectedState();
  const L = levelOf(s);
  const flagged = L.rank >= 2;
  const t = store.summary.thresholds;
  const rank = s.baseline_years_drier === s.baseline_years ? `wetter than all ${s.baseline_years} years`
    : s.baseline_years_drier === 0 ? `drier than all ${s.baseline_years} years`
    : `wetter than ${s.baseline_years_drier} of ${s.baseline_years} years`;
  const govColor = (st) => ({ "Medium": "c-amber", "Low–Medium": "c-amber", "Low": "c-red", "Required": "c-amber", "High": "c-green" }[st] || "c-muted");

  return `
  <main class="content tight" style="padding-top:32px">
    <div class="page-head top">
      <div>
        <h1 class="h1 bold">Risk Assessment</h1>
        <p class="lede sm" style="margin-top:6px">Assisted interpretation of available environmental information.</p>
      </div>
      <label class="sel-badge"><span class="sr-only">Selected area</span>
        <select id="state-select">${[...store.states].sort((a, b) => a.state.localeCompare(b.state)).map((x) => `<option value="${x.shapeISO}" ${x.shapeISO === s.shapeISO ? "selected" : ""}>Flood • ${esc(x.state)}</option>`).join("")}</select>
      </label>
    </div>

    <section class="card signal">
      <div class="signal-sum">
        <div class="l">Environmental Risk Signal · ${esc(s.state)}</div>
        <div class="v c-${L.color}">${L.signal.toUpperCase()}</div>
        <div class="n">${flagged ? "Available environmental information requires institutional review." : "No action signal from rainfall. Continue routine monitoring."}</div>
      </div>
      <div class="signal-metrics">
        <div class="smetric"><div class="l">Rainfall</div><div class="v c-${L.color}">${L.word === "Monitoring" ? "Above normal" : L.word === "Normal" ? "Normal" : "Elevated"}</div></div>
        <div class="smetric"><div class="l">Vegetation</div><div class="v c-muted">Not connected</div></div>
        <div class="smetric"><div class="l">Location</div><div class="v c-blue">Monitored</div></div>
      </div>
    </section>

    <section class="row">
      <div class="card assess grow">
        <div><div class="card-title">Automated Assessment</div><div class="card-sub sm">Rule-based interpretation layer, not an autonomous warning</div></div>
        <p class="assess-text">${explain(s, t)}</p>
        <div class="signals">
          <div class="l">Signals considered</div>
          <div class="sigrow"><span class="check">✓</span>Rainfall conditions <span class="detail">${fmt(s.recent_mm)} mm vs ${fmt(s.normal_mm)} mm normal (${fmt(s.percent_of_normal)}%)</span></div>
          <div class="sigrow"><span class="check no">–</span>Vegetation condition <span class="detail">NDVI not connected</span></div>
          <div class="sigrow"><span class="check">✓</span>Location information <span class="detail">State boundary</span></div>
          <div class="sigrow"><span class="check">✓</span>Available environmental context <span class="detail">${rank} (1991–2020)</span></div>
        </div>
        <span class="review-badge ${flagged ? "" : "ok"}">${flagged ? "Requires human review" : "No review needed"}</span>
      </div>

      <div class="card gov w390">
        <div><div class="card-title">Governance Check</div><div class="card-sub sm">DGARI-informed design requirement · Nigeria</div></div>
        <div>
          ${GOVERNANCE.map((g) => `<div class="gov-row" title="${esc(g.dim)}"><span>${esc(g.item)}</span><span class="st ${govColor(g.status)}">${esc(g.status)}</span></div>`).join("")}
        </div>
        <p class="gov-foot">Ratings are Nigeria’s documented readiness from the DGARI assessment (dissertation Section 4.3).</p>
      </div>
    </section>

    <div class="actions">
      <a class="btn" href="#monitoring">Continue Monitoring</a>
      <a class="btn primary" id="send-review" href="${reviewMailto(s)}">Send for Institutional Review <span style="color:#fff">${icon("arrow-right", "s14")}</span></a>
    </div>
  </main>`;
}

function explain(s, t) {
  const pct = s.percent_of_normal, an = s.anomaly_mm;
  const per = periodText();
  if (s.flag === "warning")
    return `Rainfall in ${esc(s.state)} for ${per} was ${fmt(pct)}% of the 1991–2020 normal (${fmt(an)} mm above). This meets the warning rule (≥${t.warning.min_percent_of_normal}% and ≥${t.warning.min_anomaly_mm} mm). River levels, dam releases and local reports should be checked before any public warning.`;
  if (s.flag === "watch")
    return `Rainfall in ${esc(s.state)} for ${per} was ${fmt(pct)}% of normal (${fmt(an)} mm above). This meets the watch rule (≥${t.watch.min_percent_of_normal}% and ≥${t.watch.min_anomaly_mm} mm). Monitor closely and check river and local information.`;
  if (pct >= 100)
    return `Rainfall in ${esc(s.state)} for ${per} was ${fmt(pct)}% of normal (${an >= 0 ? "+" : ""}${fmt(an)} mm). Slightly above average but below the watch rule.`;
  return `Rainfall in ${esc(s.state)} for ${per} was ${fmt(pct)}% of normal (${fmt(-an)} mm below). No rainfall-related flood signal.`;
}

function reviewMailto(s) {
  const L = levelOf(s);
  const body = [
    `DGARI flood signal for institutional review`,
    ``,
    `Area: ${s.state}, Nigeria`,
    `Signal: ${L.signal.toUpperCase()} (${L.map})`,
    `Period: ${periodText()}`,
    `Rainfall: ${fmt(s.recent_mm)} mm vs ${fmt(s.normal_mm)} mm normal (${fmt(s.percent_of_normal)}% of normal, ${s.anomaly_mm >= 0 ? "+" : ""}${fmt(s.anomaly_mm)} mm)`,
    `Source: CHIRPS v3.0 (${store.summary.dekads.map((d) => d.product).includes("preliminary") ? "includes preliminary data" : "final data"})`,
    `Not included: river levels, dam releases, vegetation (NDVI), local reports.`,
    ``,
    `Link: ${location.origin}${location.pathname}${link("risk", s.shapeISO)}`,
  ].join("\n");
  return `mailto:?subject=${encodeURIComponent(`DGARI flood signal review: ${s.state}`)}&body=${encodeURIComponent(body)}`;
}

afterRender.risk = () => {
  $("#state-select").addEventListener("change", (e) => { location.hash = link("risk", e.target.value); });
};

// ---------------------------------------------------------------- MAP
function viewMap() {
  return `
  <main class="content map-page">
    <div>
      <h1 class="h1 bold">Map</h1>
      <p class="lede sm" style="margin-top:6px;line-height:21px">Geospatial view of monitored areas and active risk zones.</p>
    </div>
    <section class="card map-card">
      <div><div class="card-title">Regional Risk Map</div><div class="card-sub sm" style="line-height:18px">All monitored flood-prone areas · ${periodText()}</div></div>
      <div class="bigmap-wrap">
        <div id="bigmap" role="application" aria-label="Map of Nigerian states with risk zones"></div>
        <div class="map-legend" aria-hidden="true">
          <div class="t">RISK LEVEL</div>
          <div class="i"><i class="mk" style="background:var(--red)"></i>Elevated / Warning</div>
          <div class="i"><i class="mk" style="background:var(--amber)"></i>Elevated / Advisory</div>
          <div class="i"><i class="mk" style="background:var(--blue)"></i>Monitoring</div>
        </div>
      </div>
    </section>
  </main>`;
}
afterRender.map = () => makeMap("bigmap", { compact: false });

// Shared Leaflet map. Flat style like the Figma map: pale blue land, rivers,
// and dashed "zones" with a marker and label for states that need attention.
function makeMap(id, { compact }) {
  const el = document.getElementById(id);
  if (!el) return;
  const map = L.map(el, { zoomControl: !compact, attributionControl: !compact, scrollWheelZoom: false, zoomSnap: 0.25, dragging: !compact || !L.Browser.mobile });
  activeMaps.push(map);
  map.setView([9.1, 8.7], 6);   // a starting view; refined by fitBounds below
  if (!compact) {
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution("Rainfall: CHIRPS v3.0 · Boundaries: geoBoundaries/GRID3 · Rivers: Natural Earth");
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
  }

  const layer = L.geoJSON(store.geo, {
    style: (f) => {
      const Lv = levelOf(f.properties);
      const tint = { warning: "#f6c7c2", watch: "#fde2b8", monitoring: "#cfdcf7", normal: "#d7e3f1" }[Lv.key];
      return { fillColor: tint, fillOpacity: 1, color: "#ffffff", weight: compact ? 0.8 : 1.2 };
    },
    onEachFeature: (f, lyr) => {
      const p = f.properties, Lv = levelOf(p);
      lyr.bindTooltip(`<b>${esc(p.state)}</b><br>${Lv.map} · ${fmt(p.percent_of_normal)}% of normal`, { sticky: true });
      if (!compact) lyr.bindPopup(popupHtml(p));
      else lyr.on("click", () => (location.hash = link("risk", p.shapeISO)));
    },
  }).addTo(map);

  if (store.rivers) {
    L.geoJSON(store.rivers, { style: { color: "#9dbbe0", weight: compact ? 2 : 4, opacity: 0.9 }, interactive: false }).addTo(map);
  }

  // Zones for states that need attention (Warning, Watch, Monitoring).
  layer.eachLayer((lyr) => {
    const p = lyr.feature.properties, Lv = levelOf(p);
    if (Lv.rank < 1) return;
    const c = lyr.getBounds().getCenter();
    const radius = compact ? 50000 : 70000;
    L.circle(c, { radius, color: Lv.hex, weight: 1.5, dashArray: "5 5", fillColor: Lv.hex, fillOpacity: 0.12, interactive: false }).addTo(map);
    if (compact) {
      L.circleMarker(c, { radius: Lv.rank >= 2 ? 6 : 4, color: "#fff", weight: 2, fillColor: Lv.rank >= 2 ? Lv.hex : "#5b8def", fillOpacity: 1, interactive: false }).addTo(map);
    } else {
      const glyph = { warning: "!", watch: "▲", monitoring: "●" }[Lv.key];
      L.marker(c, { icon: L.divIcon({ className: "zone-pin", html: `<span style="background:${Lv.hex}">${glyph}</span>`, iconSize: [24, 24] }), keyboard: false })
        .bindPopup(popupHtml(p)).addTo(map);
      L.tooltip({ permanent: true, direction: "bottom", offset: [0, 16], className: "zone-label" })
        .setLatLng(c).setContent(`<span style="color:${Lv.hex}">${esc(p.state)}</span>`).addTo(map);
    }
  });

  map.fitBounds(layer.getBounds(), { padding: compact ? [6, 6] : [20, 20] });
  setTimeout(() => { if (activeMaps.includes(map)) map.invalidateSize(); }, 0);
}

function popupHtml(p) {
  const Lv = levelOf(p);
  return `<div class="popup-name">${esc(p.state)}</div>
    <div style="color:${Lv.hex};font-weight:700">${Lv.map}</div>
    <div>${fmt(p.recent_mm)} mm vs ${fmt(p.normal_mm)} mm normal · ${fmt(p.percent_of_normal)}%</div>
    <div class="popup-links"><a href="${link("risk", p.shapeISO)}">Risk assessment →</a><a href="${link("warnings", p.shapeISO)}">Public view →</a></div>`;
}

// ---------------------------------------------------------------- SETTINGS
function viewSettings() {
  const s = store.summary, t = s.thresholds;
  return `
  <main class="content tight">
    <div><h1 class="h1">Settings</h1><p class="lede sm">Data period and signal rules used across all screens.</p></div>
    <section class="card settings-card">
      <div class="field"><label for="period-select">Data period</label>
        <select id="period-select">${store.periods.map((p) => `<option value="${p.dir}" ${p.dir === store.dir ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></div>
      <dl class="kv">
        <dt>Rainfall period</dt><dd>${periodText()} (${s.dekads.map((d) => `<a href="${esc(d.url)}">${esc(d.label)}</a>`).join(", ")})</dd>
        <dt>CHIRPS product</dt><dd>${[...new Set(s.dekads.map((d) => d.product))].join(" + ")}</dd>
        <dt>Normal</dt><dd>${esc(s.baseline)} average for the same dekads</dd>
        <dt>Warning rule</dt><dd>≥ ${t.warning.min_percent_of_normal}% of normal and ≥ ${t.warning.min_anomaly_mm} mm above normal</dd>
        <dt>Watch rule</dt><dd>≥ ${t.watch.min_percent_of_normal}% of normal and ≥ ${t.watch.min_anomaly_mm} mm above normal</dd>
        <dt>Monitoring</dt><dd>At or above normal, below the watch rule</dd>
        <dt>Processed</dt><dd>${esc(s.generated_utc)}</dd>
        <dt>Download</dt><dd><a href="${store.dir}/state_results.csv">State results (CSV)</a></dd>
      </dl>
    </section>
  </main>`;
}
afterRender.settings = () => {
  $("#period-select").addEventListener("change", async (e) => { await loadPeriod(e.target.value); render(); });
};

// ---------------------------------------------------------------- WARNINGS (public view)
function viewWarnings() {
  const s = selectedState();
  const Lv = levelOf(s);
  const alert = Lv.rank >= 2;
  const sorted = [...store.states].sort((a, b) => a.state.localeCompare(b.state));
  const msg = alert
    ? `Rainfall over the past month has been far above normal for ${esc(s.state)}, so flooding is more likely. Follow official local instructions and move to a safer location if instructed by local authorities.`
    : `There is no rainfall-based flood signal for ${esc(s.state)} at the moment. Stay informed through official channels and follow local authority guidance.`;
  const steps = alert
    ? ["Move to a safer location if instructed by local authorities.",
       "Follow official emergency information and local instructions.",
       "Avoid areas identified by authorities as unsafe."]
    : ["Know where you would go if local authorities ask you to move.",
       "Follow official weather and flood information from local authorities.",
       "Never walk or drive through flood water."];
  const riskText = { warning: "Action may be needed. Check official guidance from authorities.",
                     watch: "Be prepared. Check official guidance from authorities.",
                     monitoring: "Rainfall slightly above normal. No action signal.",
                     normal: "Rainfall at or below normal. No action signal." }[Lv.key];
  const p = store.pub;

  return `
  <div class="pub ${p.large ? "large" : ""} ${p.contrast ? "contrast" : ""}" id="pub">
    <header class="pub-top">
      <div class="pub-brand"><div class="n">DGARI</div><div class="s">Disaster Early Warning Dashboard</div></div>
      <div class="pub-actions">
        <label class="pbtn lang"><span class="sr-only">Language</span>
          <select id="lang">
            <option>English</option>
            <option disabled>Hausa (soon)</option>
            <option disabled>Yorùbá (soon)</option>
            <option disabled>Igbo (soon)</option>
            <option disabled>Nigerian Pidgin (soon)</option>
          </select></label>
        <button class="pbtn soft" id="a11y-jump">Accessibility</button>
        <a class="pbtn" href="#overview">← Officer View</a>
      </div>
    </header>
    <div class="accent" style="background:${Lv.hex}"></div>
    <div class="pub-body">
      <aside class="pub-side">
        <div class="pub-intro">
          <div class="k">DGARI</div>
          <div class="h">Disaster Early Warning</div>
          <div class="d">Monitor alerts, review guidance, and keep the public informed from one desktop workspace.</div>
        </div>
        <nav class="pub-nav" aria-label="Warning sections">
          <button class="pnav active" data-go="pub-top">${`<span class="ib">${icon("triangle-alert")}</span>`}Active warnings</button>
          <button class="pnav" data-go="area">${`<span class="ib">${icon("map")}</span>`}Area overview</button>
          <button class="pnav" data-go="guidance">${`<span class="ib">${icon("shield")}</span>`}Safety guidance</button>
          <button class="pnav" data-go="notify">${`<span class="ib">${icon("bell")}</span>`}Notifications</button>
          <button class="pnav" data-go="a11y">${`<span class="ib">${icon("settings")}</span>`}Settings</button>
        </nav>
        <div class="pub-note"><b>Your area</b><p>Choose your state under “Your Area” to see the signal that applies to you.</p></div>
      </aside>

      <main class="pub-main" id="pub-top">
        <div class="pub-head">
          <div>
            <h1 class="t">Active warning dashboard</h1>
            <p class="s">${esc(s.state)}, Nigeria • ${Lv.risk} risk flood signal • Rainfall data to ${dateGB(store.summary.period_end)}</p>
          </div>
          <div class="pub-actions">
            <span class="status-chip" style="background:${Lv.soft};color:${Lv.hex}">${Lv.chip}</span>
            <button class="share" id="share">Share alert</button>
          </div>
        </div>

        <section class="banner" style="background:${Lv.soft}" id="banner">
          <p class="t" style="color:${Lv.hex}">${Lv.banner}</p>
          <p class="m">${msg}</p>
        </section>

        <section class="sum-row" id="area">
          <div class="sum">
            <p class="l">Your Area</p>
            <label class="area-select"><span class="sr-only">Choose your state</span>
              <select id="area-select">${sorted.map((x) => `<option value="${x.shapeISO}" ${x.shapeISO === s.shapeISO ? "selected" : ""}>${esc(x.state)}, Nigeria</option>`).join("")}</select></label>
            <p class="d">This signal applies to the whole state. Local conditions can differ.</p>
          </div>
          <div class="sum">
            <p class="l">Risk level</p>
            <p class="v" style="color:${Lv.hex}">${Lv.risk}</p>
            <p class="d">${riskText}</p>
          </div>
          <div class="sum">
            <p class="l">Issued by</p>
            <p class="v">Not yet issued</p>
            <p class="d">Automated rainfall signal awaiting review by the authorised disaster management authority.</p>
          </div>
        </section>

        <section class="main-row">
          <div class="todo" id="guidance">
            <div><p class="t">What should I do?</p><p class="s">Follow official local instructions and take the recommended actions below.</p></div>
            <div class="steps">${steps.map((t, i) => `<div class="step"><span class="n">${i + 1}</span><p>${t}</p></div>`).join("")}</div>
          </div>
          <div class="winfo">
            <p class="t">Warning Information</p>
            <div>
              <div class="irow"><p class="l">Hazard</p><p class="v">Flood</p></div>
              <div class="irow"><p class="l">Risk level</p><p class="v">${Lv.risk}</p></div>
              <div class="irow"><p class="l">Issued by</p><p class="v">Not yet issued</p></div>
              <div class="irow"><p class="l">Status</p><p class="v">Draft · not an official warning</p></div>
            </div>
          </div>
        </section>

        <section class="bottom-row">
          <div class="a11y" id="a11y">
            <p class="t">Accessibility</p>
            <div class="a11y-actions">
              <button class="abtn" id="listen" aria-pressed="false">Listen to warning</button>
              <button class="abtn" id="textsize" aria-pressed="${p.large}">Aa Text size</button>
              <button class="abtn" id="contrast" aria-pressed="${p.contrast}">High contrast</button>
            </div>
          </div>
          <div class="foot-note" id="notify">
            <p>This warning may also be communicated through SMS, local authorities and other available community channels.</p>
            <p>Prototype scenario • Research-informed interface • Not a deployed operational warning system</p>
          </div>
        </section>
      </main>
    </div>
  </div>`;
}

function bindWarnings() {
  const s = selectedState(), Lv = levelOf(s);
  $("#area-select").addEventListener("change", (e) => { location.hash = link("warnings", e.target.value); });
  document.querySelectorAll(".pnav").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".pnav").forEach((x) => x.classList.toggle("active", x === b));
    document.getElementById(b.dataset.go)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("#a11y-jump").addEventListener("click", () => $("#a11y").scrollIntoView({ behavior: "smooth" }));
  $("#textsize").addEventListener("click", () => { store.pub.large = !store.pub.large; render(); });
  $("#contrast").addEventListener("click", () => { store.pub.contrast = !store.pub.contrast; render(); });

  const spoken = () => [Lv.banner, $("#banner .m").textContent, "What should I do?",
    ...[...document.querySelectorAll(".step p")].map((p, i) => `${i + 1}. ${p.textContent}`),
    "This is not an official warning."].join(" ");
  const listen = $("#listen");
  if (!("speechSynthesis" in window)) { listen.disabled = true; listen.title = "Not supported in this browser"; }
  listen.addEventListener("click", () => {
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); listen.setAttribute("aria-pressed", "false"); listen.textContent = "Listen to warning"; return; }
    const u = new SpeechSynthesisUtterance(spoken()); u.lang = "en-GB";
    u.onend = () => { listen.setAttribute("aria-pressed", "false"); listen.textContent = "Listen to warning"; };
    speechSynthesis.speak(u); listen.setAttribute("aria-pressed", "true"); listen.textContent = "Stop";
  });

  $("#share").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}${link("warnings", s.shapeISO)}`;
    const text = `${Lv.banner}: ${s.state}, Nigeria. Rainfall-based signal (not an official warning).`;
    try {
      if (navigator.share) await navigator.share({ title: "DGARI flood signal", text, url });
      else { await navigator.clipboard.writeText(`${text} ${url}`); toast("Link copied"); }
    } catch { /* user cancelled */ }
  });
}

// ---------------------------------------------------------------- start
async function init() {
  // Only offer periods whose data files exist.
  for (const p of PERIODS) {
    const ok = await fetch(`${p.dir}/summary.json`, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
    if (ok) store.periods.push(p);
  }
  if (!store.periods.some((p) => p.dir === store.dir)) store.dir = store.periods[0]?.dir || "data";
  await loadPeriod(store.dir);
  store.rivers = await fetch("data/rivers.geojson").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  window.addEventListener("hashchange", render);
  render();
}

init().catch((err) => {
  $("#app").innerHTML = `<p class="loading">Could not load the data (${esc(err.message)}). If you opened index.html straight from your computer, run a local web server instead (see README).</p>`;
});

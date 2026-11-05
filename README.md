# DGARI flood prototype: Nigeria rainfall-anomaly dashboard

A small working prototype built from the MSc dissertation *The Disaster Governance
and AI Readiness Index (DGARI)* (Northumbria University, MSc Disaster Management and
Sustainable Development). It turns one part of the Appendix A interface design into
a working page with one live data layer:

> **Recent CHIRPS rainfall in each Nigerian state, compared with the 1991–2020
> average for the same time of year, with a simple Normal / Watch / Warning flag.**

**This is a rainfall-anomaly indicator, not a validated flood forecast.** It
contains no AI or predictive model, it has not been validated against flood
records, and its thresholds are illustrative. See *Limitations* below.

Scope: Nigeria · flood only · CHIRPS v3.0 rainfall only · 36 states + FCT.

---

## What is in this folder

```
pipeline/run_pipeline.py      The Python pipeline (all the calculations)
requirements.txt              Python packages the pipeline needs
data/boundaries/              Nigeria state boundaries (geoBoundaries / GRID3)
data/cache/                   Saved baseline values, so they are not re-downloaded
docs/                         The website (this folder is what GitHub Pages publishes)
  index.html, style.css, app.js
  data/                       Files written by the pipeline for the latest period
  data/example-2022-09/       The same calculation for Jul–Sep 2022 (historical example)
  vendor/leaflet/             The Leaflet map library (copied in, so no CDN is needed)
.github/workflows/            The GitHub Action that refreshes data daily and publishes
```

## Running it yourself

```bash
pip install -r requirements.txt
python pipeline/run_pipeline.py
```

The first run builds the baseline from 90 CHIRPS files and takes around 5–10
minutes. Later runs reuse `data/cache/` and take seconds, until the calendar
window moves on and a new set of dekads is needed.

To view the website on your own computer (opening `index.html` directly will not
load the data, because browsers block that):

```bash
python -m http.server 8000 --directory docs
```

Then open http://localhost:8000.

To reproduce the historical example:

```bash
python pipeline/run_pipeline.py --end 2022-09-3 --out docs/data/example-2022-09
```

---

## How it works, step by step

### Step 1: State boundaries
The script downloads Nigeria's first-level administrative boundaries (36 states and
the FCT) from **geoBoundaries** (gbOpen, NGA ADM1, sourced from GRID3, CC BY 4.0).
It keeps a detailed version for the calculations and a simplified version for the
website, which keeps the page fast.

### Step 2: Find the latest rainfall data
**CHIRPS v3.0** (Climate Hazards Center, UC Santa Barbara) provides rainfall
estimates on a grid of 0.05° (about 5.5 km). It combines satellite infrared
observations with rain-gauge records. We use **dekadal** files: rainfall totals for
10-day periods (days 1–10, 11–20 and 21 to the end of each month).

CHIRPS publishes two versions:
- **Final**: quality-controlled, released about three weeks after each month ends.
- **Preliminary**: released about two days after each period, with fewer checks.

The script uses Final where it exists and Preliminary only for the newest periods.
The dashboard shows which one was used.

### Step 3: Recent rainfall per state
The script takes the **last three dekads** (about a month) and reads only the
rectangle around Nigeria from each file. It does not download the whole continent.
**rasterstats** averages the grid cells whose centres fall inside each state, and
the three dekads are added together. The result is "recent rainfall (mm)" for each
state.

### Step 4: The baseline ("normal")
For the **same three calendar dekads**, the same calculation is done for every year
from **1991 to 2020** (the WMO standard climate-normal period). That gives 30 totals
per state, and their average is the "normal". These values are saved in
`data/cache/baseline_state_dekads.csv` so they are only downloaded once.

### Step 5: Compare and flag
For each state:

- **Percent of normal** = recent ÷ normal × 100
- **Anomaly (mm)** = recent − normal

| Flag | Percent of normal | **and** anomaly |
|---|---|---|
| **Warning** | ≥ 150% | ≥ 50 mm above normal |
| **Watch** | ≥ 125% | ≥ 25 mm above normal |
| **Normal** | everything else, including below-normal rainfall | |

Both conditions must be met. The millimetre condition matters in the dry season:
if the normal is 2 mm and 6 mm falls, that is 300% of normal but has no practical
flood significance.

The thresholds are in one clearly marked block at the top of
`pipeline/run_pipeline.py`. They are **illustrative design values**, chosen to be
easy to explain. As the dissertation says (Section 4.9), operational thresholds
would need calibration against historical rainfall and flood-impact records, and
would likely differ between regions.

As context only (not used in the flag), the page also shows how many of the 30
baseline years were drier than the recent period.

### Step 6: Outputs and the website
The pipeline writes three small files into `docs/data/`:

- `summary.json`: the period, which CHIRPS files were used, the thresholds and the counts
- `states.geojson`: state shapes with the results attached
- `state_results.csv`: a plain table you can open in Excel

The website (HTML + Leaflet, no build step) reads these files and draws the map,
the cards, the state panel and the table.

### Step 7: Automatic refresh
A GitHub Action (`.github/workflows/refresh-and-deploy.yml`) runs the pipeline
every day at 06:17 UTC. It commits new results only if the data changed, then
republishes the site to GitHub Pages. CHIRPS preliminary data appears roughly every
five days, so most days nothing changes.

---

## How the interface follows the design specification (Appendix A, Section 3.10)

| Figma element | In this prototype |
|---|---|
| Sidebar: navigation, data sources, last sync | Same structure. Data sources show CHIRPS as active and **NDVI and river gauges as "not used"** rather than implying they are live. |
| Metric cards | Count of states at Warning / Watch / Normal, plus the rainfall period |
| Regional risk map with legend | Leaflet map of states coloured by flag, legend in the same position |
| Recent alerts table and area-health bars | One "All states" table with a signal pill and a percent-of-normal bar |
| Review queue ("human verification required") | "Human review" card: every flag is marked **not reviewed** |
| "Disaster Officer" profile | Replaced with a "Research prototype · not an official warning" label, since there are no users or roles |

Design elements from the Figma that are **not** built here: the drought/NDVI
layer, the warning-issuing screen, AI-assisted risk assessment, multilingual
SMS/USSD messaging, and user roles. These would need real data, institutional
arrangements and testing, which the dissertation identifies as future work.

## Limitations

- **Not a flood forecast.** Flooding also depends on river flow, upstream rainfall
  (including in Cameroon, Niger and other upstream countries), dam operations, soil
  saturation, topography, drainage and exposure. None of these are included.
- **Not validated.** There is no measure of how often the flags coincide with real
  floods (hit rate or false-alarm rate).
- **Backward-looking.** It summarises rain that has already fallen.
- **Coarse in space and time.** State averages hide local extremes. Ten-day totals
  hide short intense storms, which drive flash and urban flooding.
- **Preliminary data can change** when the Final CHIRPS product replaces it.
- **CHIRPS is an estimate.** Gauge density in parts of Nigeria is low, which affects
  accuracy.
- **No user testing** of the interface.

## Sources

- Funk, C. et al. (2015) 'The climate hazards infrared precipitation with
  stations: a new environmental record for monitoring extremes', *Scientific Data*,
  2, 150066. (CHIRPS v2.0 method. CHIRPS v3.0 documentation:
  https://www.chc.ucsb.edu/data/chirps3)
- Runfola, D. et al. (2020) 'geoBoundaries: A global database of political
  administrative boundaries', *PLoS ONE*, 15(4), e0231866.
- Boundaries: geoBoundaries gbOpen NGA ADM1, source GRID3, CC BY 4.0.
- Leaflet 1.9.4 (BSD-2-Clause), included in `docs/vendor/leaflet/`.

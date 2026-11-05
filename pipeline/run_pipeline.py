"""
DGARI flood prototype: rainfall-anomaly pipeline for Nigeria
============================================================

WHAT THIS SCRIPT DOES (in plain language)
-----------------------------------------
1. Gets the outlines of Nigeria's 36 states + the FCT from geoBoundaries.
2. Finds the most recent CHIRPS v3.0 rainfall data (10-day "dekad" totals).
3. Adds up the rainfall of the last few dekads (default: 3 dekads, about a
   month) and averages it over each state.
4. Builds a "normal" (baseline) for the SAME calendar dekads, using the
   30 years 1991-2020.
5. Compares recent rainfall with normal and gives each state a simple flag:
   NORMAL, WATCH or WARNING, using the thresholds in the THRESHOLDS section.
6. Writes small data files that the web dashboard (docs/) reads.

WHAT IT DOES NOT DO
-------------------
This is a RAINFALL-ANOMALY INDICATOR, not a flood forecast. It does not use
river levels, dam releases, soil moisture, terrain, drainage, land cover or
exposure, and the thresholds have NOT been calibrated against past floods
in Nigeria. A "warning" flag means "much wetter than usual for this time of
year", nothing more.

HOW TO RUN IT
-------------
    pip install -r requirements.txt
    python pipeline/run_pipeline.py

Optional: look at a past period instead of the latest data, e.g. the
dekads ending 30 Sept 2022 (the 2022 flood season), saved separately:
    python pipeline/run_pipeline.py --end 2022-09-3 --out docs/data/example-2022-09
"""

# --------------------------------------------------------------------------
# Imports: other people's code we rely on
# --------------------------------------------------------------------------
import argparse          # reads options typed on the command line (e.g. --end)
import calendar          # tells us how many days are in a month
import json              # writes the summary file the website reads
import re                # "regular expressions": finds file names in web pages
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd  # tables of shapes (the state boundaries)
import numpy as np       # fast maths on grids of numbers
import pandas as pd      # ordinary tables (like a spreadsheet)
import rasterio          # reads raster (gridded) data such as CHIRPS GeoTIFFs
import requests          # downloads things from the web
from rasterio.windows import from_bounds
from rasterstats import zonal_stats  # averages a raster inside each polygon

# --------------------------------------------------------------------------
# SETTINGS: everything you might want to change is in this block
# --------------------------------------------------------------------------

# Where files live, relative to the project folder.
PROJECT_DIR = Path(__file__).resolve().parent.parent
BOUNDARY_DIR = PROJECT_DIR / "data" / "boundaries"
CACHE_FILE = PROJECT_DIR / "data" / "cache" / "baseline_state_dekads.csv"
OUTPUT_DIR = PROJECT_DIR / "docs" / "data"

# How many 10-day periods (dekads) count as "recent". 3 dekads ~ 1 month.
RECENT_DEKADS = 3

# The baseline ("normal") years. 1991-2020 is the WMO standard normal period.
BASELINE_START_YEAR = 1991
BASELINE_END_YEAR = 2020

# CHIRPS v3.0 web folders.
#   FINAL  = quality-controlled, released about 3 weeks after each month.
#   PRELIM = preliminary, released ~2 days after each period, fewer checks.
# We prefer FINAL and use PRELIM only for periods FINAL does not cover yet.
CHIRPS_ROOT = "https://data.chc.ucsb.edu/products/CHIRPS/v3.0"
FINAL_DIR = f"{CHIRPS_ROOT}/dekads/africa/tifs"
PRELIM_DIR = f"{CHIRPS_ROOT}/prelim/dekads/global/tifs"
FILE_PATTERN = r"chirps-v3\.0\.(\d{4})\.(\d{2})\.([123])\.tif"

# A box around Nigeria (west, south, east, north) in degrees. We read only
# this part of each rainfall file, so we never download the whole continent.
NIGERIA_BOX = (2.6, 4.2, 14.7, 13.9)

# CHIRPS marks "no data" (e.g. sea) with -9999.
NODATA = -9999.0

# geoBoundaries API for Nigeria's first-level administrative units (states).
GEOBOUNDARIES_API = "https://www.geoboundaries.org/api/current/gbOpen/NGA/ADM1/"

# --------------------------------------------------------------------------
# THRESHOLDS: how a state gets its flag
# --------------------------------------------------------------------------
# Two numbers are worked out for every state:
#   percent_of_normal = recent rainfall / normal rainfall x 100
#   anomaly_mm        = recent rainfall - normal rainfall   (in millimetres)
#
# Both must pass for a flag. The millimetre test stops dry-season false
# alarms: if normal is 2 mm and 6 mm falls, that is 300% of normal but
# hydrologically trivial.
#
#   WARNING : percent_of_normal >= 150  AND  anomaly_mm >= 50
#   WATCH   : percent_of_normal >= 125  AND  anomaly_mm >= 25
#   NORMAL  : anything else (including below-normal rainfall)
#
# IMPORTANT: these numbers are ILLUSTRATIVE. They were chosen to be easy to
# explain, not fitted to Nigerian flood records. As the dissertation notes
# (Section 4.9), operational thresholds would need calibration against
# historical rainfall and flood-impact records, and may differ by region.
THRESHOLDS = {
    "warning": {"min_percent_of_normal": 150, "min_anomaly_mm": 50},
    "watch": {"min_percent_of_normal": 125, "min_anomaly_mm": 25},
}


def classify(percent_of_normal, anomaly_mm):
    """Turn the two numbers into a flag, using THRESHOLDS above."""
    if percent_of_normal is None:          # normal rainfall was zero
        return "normal"
    for flag in ("warning", "watch"):      # check the most severe first
        rule = THRESHOLDS[flag]
        if (percent_of_normal >= rule["min_percent_of_normal"]
                and anomaly_mm >= rule["min_anomaly_mm"]):
            return flag
    return "normal"


# --------------------------------------------------------------------------
# Small helpers for "dekads" (10-day periods)
# --------------------------------------------------------------------------
# A dekad is written as (year, month, d) where d is 1, 2 or 3:
#   d=1 -> days 1-10, d=2 -> days 11-20, d=3 -> day 21 to end of month.

def dekad_label(year, month, d):
    """e.g. (2026, 10, 3) -> '21-31 Oct 2026'"""
    first = {1: 1, 2: 11, 3: 21}[d]
    last = {1: 10, 2: 20, 3: calendar.monthrange(year, month)[1]}[d]
    return f"{first}-{last} {calendar.month_abbr[month]} {year}"


def dekad_dates(year, month, d):
    """First and last calendar date of a dekad, as 'YYYY-MM-DD' text."""
    first = {1: 1, 2: 11, 3: 21}[d]
    last = {1: 10, 2: 20, 3: calendar.monthrange(year, month)[1]}[d]
    return f"{year}-{month:02d}-{first:02d}", f"{year}-{month:02d}-{last:02d}"


def previous_dekad(year, month, d):
    """The dekad just before this one, e.g. (2026, 1, 1) -> (2025, 12, 3)."""
    if d > 1:
        return year, month, d - 1
    if month > 1:
        return year, month - 1, 3
    return year - 1, 12, 3


# --------------------------------------------------------------------------
# STEP 1: state boundaries
# --------------------------------------------------------------------------

def get_state_boundaries():
    """Download Nigeria's state boundaries once, then reuse the saved copy.

    We keep two versions:
      - full detail: used for the rainfall calculations (more accurate)
      - simplified : used on the website (much smaller file, loads faster)
    """
    BOUNDARY_DIR.mkdir(parents=True, exist_ok=True)
    full_path = BOUNDARY_DIR / "nga_adm1.geojson"
    simple_path = BOUNDARY_DIR / "nga_adm1_simplified.geojson"
    meta_path = BOUNDARY_DIR / "source.json"

    if not full_path.exists() or not simple_path.exists():
        print("Step 1: downloading state boundaries from geoBoundaries ...")
        meta = requests.get(GEOBOUNDARIES_API, timeout=60).json()
        for url, path in [(meta["gjDownloadURL"], full_path),
                          (meta["simplifiedGeometryGeoJSON"], simple_path)]:
            # geoBoundaries stores these files with Git LFS; a
            # github.com/.../raw/... link just redirects to this address.
            url = re.sub(r"https://github\.com/([^/]+)/([^/]+)/raw/",
                         r"https://media.githubusercontent.com/media/\1/\2/", url)
            response = requests.get(url, timeout=120)
            response.raise_for_status()
            path.write_bytes(response.content)
        # Save where the data came from, so we can cite it properly.
        keep = ["boundaryID", "boundaryYearRepresented", "boundarySource",
                "boundaryLicense", "buildDate", "gjDownloadURL"]
        meta_path.write_text(json.dumps({k: meta.get(k) for k in keep}, indent=2))
    else:
        print("Step 1: using saved state boundaries")

    # Read the shapes and keep only the columns we need.
    # shapeISO is a standard code (e.g. NG-LA for Lagos) we use as an ID.
    states = gpd.read_file(full_path)[["shapeName", "shapeISO", "geometry"]]
    states = states.to_crs("EPSG:4326")   # same coordinates as CHIRPS
    states_simple = gpd.read_file(simple_path)[["shapeISO", "geometry"]]
    source = json.loads(meta_path.read_text())
    print(f"         {len(states)} states/territories loaded")
    return states, states_simple, source


# --------------------------------------------------------------------------
# STEP 2: find which CHIRPS dekads exist online
# --------------------------------------------------------------------------

def get_with_retries(url, tries=6):
    """Download a web page, trying again a few times if the connection drops."""
    for attempt in range(1, tries + 1):
        try:
            response = requests.get(url, timeout=60)
            response.raise_for_status()
            return response.text
        except requests.RequestException as error:
            if attempt == tries:
                raise
            print(f"         (retrying {url}: {error})")
            time.sleep(2 * attempt)


def list_available_dekads():
    """Return {(year, month, d): (url, 'final' or 'preliminary')}.

    We read the folder listing on the CHIRPS website and pick out the file
    names. If a dekad exists in both folders, the FINAL one wins.
    """
    available = {}
    for folder, product in [(PRELIM_DIR, "preliminary"), (FINAL_DIR, "final")]:
        page = get_with_retries(folder + "/")
        for year, month, d in set(re.findall(FILE_PATTERN, page)):
            key = (int(year), int(month), int(d))
            name = f"chirps-v3.0.{year}.{month}.{d}.tif"
            available[key] = (f"{folder}/{name}", product)  # final overwrites
    return available


def choose_recent_dekads(available, end=None):
    """Pick the last RECENT_DEKADS dekads in a row, ending at `end`
    (or at the newest one available)."""
    if end is None:
        end = max(available)
    chosen = [end]
    while len(chosen) < RECENT_DEKADS:
        chosen.insert(0, previous_dekad(*chosen[0]))
    missing = [k for k in chosen if k not in available]
    if missing:
        sys.exit(f"CHIRPS files missing for {missing}; cannot continue.")
    return chosen


# --------------------------------------------------------------------------
# STEP 3: read rainfall for Nigeria and average it per state
# --------------------------------------------------------------------------

# Settings for GDAL, the library underneath rasterio, so that it reads
# files over the internet reliably and only fetches the bytes it needs.
GDAL_NETWORK_SETTINGS = dict(
    GDAL_HTTP_MAX_RETRY="6",
    GDAL_HTTP_RETRY_DELAY="3",
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
    GDAL_HTTP_MULTIRANGE="NO",
)


def state_mean_rainfall(url, states):
    """Average rainfall (mm) in each state for one CHIRPS file.

    '/vsicurl/' tells rasterio to read the file straight from the web.
    We only read the rectangle around Nigeria (a "window").
    """
    with rasterio.Env(**GDAL_NETWORK_SETTINGS):
        with rasterio.open("/vsicurl/" + url) as src:
            window = from_bounds(*NIGERIA_BOX, src.transform)
            window = window.round_offsets().round_lengths()
            rain = src.read(1, window=window)
            transform = src.window_transform(window)

    # rasterstats looks at every grid cell whose centre falls inside a
    # state, ignores "no data" cells, and returns their average.
    results = zonal_stats(states.geometry, rain, affine=transform,
                          nodata=NODATA, stats=["mean", "count"])
    return [r["mean"] for r in results]


# --------------------------------------------------------------------------
# STEP 4: the baseline ("normal") for the same time of year
# --------------------------------------------------------------------------

def load_cache():
    """The baseline needs 30 years x 3 dekads = 90 files. Reading them takes
    a few minutes, so we save each result in a small CSV and reuse it.
    That also keeps the automatic daily refresh light on CHIRPS servers."""
    if CACHE_FILE.exists():
        return pd.read_csv(CACHE_FILE)
    return pd.DataFrame(columns=["year", "month", "dekad", "shapeISO", "mean_mm"])


def build_baseline(recent, states, available):
    """For each baseline year, add up the same calendar dekads as `recent`.

    Returns a table: one row per state, one column per baseline year,
    each value = total rainfall (mm) over those dekads in that year.
    """
    cache = load_cache()
    have = set(zip(cache.year, cache.month, cache.dekad))
    new_rows = []

    for year in range(BASELINE_START_YEAR, BASELINE_END_YEAR + 1):
        for (_, month, d) in recent:
            # A window that crosses New Year (e.g. Dec-Jan) needs year+1.
            y = year + (1 if month < recent[0][1] else 0)
            if (y, month, d) in have:
                continue
            url = f"{FINAL_DIR}/chirps-v3.0.{y}.{month:02d}.{d}.tif"
            print(f"         baseline: reading {dekad_label(y, month, d)}")
            for iso, value in zip(states.shapeISO, state_mean_rainfall(url, states)):
                new_rows.append(dict(year=y, month=month, dekad=d,
                                     shapeISO=iso, mean_mm=value))

    if new_rows:
        cache = pd.concat([cache, pd.DataFrame(new_rows)], ignore_index=True)
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        cache.sort_values(["year", "month", "dekad", "shapeISO"]).to_csv(
            CACHE_FILE, index=False, float_format="%.3f")

    # Keep only the dekads we need, then total them up within each "season".
    wanted = {(m, d) for (_, m, d) in recent}
    rows = cache[[(m, d) in wanted for m, d in zip(cache.month, cache.dekad)]].copy()
    first_month = recent[0][1]
    rows["season_year"] = rows.year - (rows.month < first_month).astype(int)
    rows = rows[rows.season_year.between(BASELINE_START_YEAR, BASELINE_END_YEAR)]
    totals = rows.pivot_table(index="shapeISO", columns="season_year",
                              values="mean_mm", aggfunc="sum")
    return totals


# --------------------------------------------------------------------------
# STEP 5: compare recent with normal and assign flags
# --------------------------------------------------------------------------

def compare(states, recent_totals, baseline_totals):
    rows = []
    for iso, name, recent_mm in zip(states.shapeISO, states.shapeName, recent_totals):
        history = baseline_totals.loc[iso].values      # 30 yearly totals
        normal_mm = float(np.mean(history))
        anomaly_mm = recent_mm - normal_mm
        percent = recent_mm / normal_mm * 100 if normal_mm > 0 else None
        # Context, not used for the flag: in how many of the 30 baseline
        # years was rainfall lower than now?
        years_drier = int((history < recent_mm).sum())
        rows.append(dict(
            shapeISO=iso,
            state=name,
            recent_mm=round(recent_mm, 1),
            normal_mm=round(normal_mm, 1),
            anomaly_mm=round(anomaly_mm, 1),
            percent_of_normal=None if percent is None else round(percent),
            baseline_years_drier=years_drier,
            baseline_years=len(history),
            baseline_min_mm=round(float(history.min()), 1),
            baseline_max_mm=round(float(history.max()), 1),
            flag=classify(percent, anomaly_mm),
        ))
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# STEP 6: write files for the dashboard
# --------------------------------------------------------------------------

def write_outputs(results, states_simple, recent, available, boundary_source,
                  out_dir=OUTPUT_DIR):
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1) A plain CSV anyone can open in Excel.
    results.sort_values("percent_of_normal", ascending=False).to_csv(
        out_dir / "state_results.csv", index=False)

    # 2) A map file: simplified state shapes + the results attached.
    mapped = states_simple.merge(results, on="shapeISO", how="left")
    mapped.to_file(out_dir / "states.geojson", driver="GeoJSON",
                   COORDINATE_PRECISION=4)

    # 3) A summary describing exactly what was calculated and from what.
    start, _ = dekad_dates(*recent[0])
    _, end = dekad_dates(*recent[-1])
    summary = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "indicator": "Recent CHIRPS rainfall compared with the 1991-2020 average "
                     "for the same dekads. Rainfall-anomaly indicator only; "
                     "not a flood forecast.",
        "period_start": start,
        "period_end": end,
        "dekads": [{"label": dekad_label(*k), "product": available[k][1],
                    "url": available[k][0]} for k in recent],
        "baseline": f"{BASELINE_START_YEAR}-{BASELINE_END_YEAR}",
        "thresholds": THRESHOLDS,
        "counts": results.flag.value_counts().reindex(
            ["warning", "watch", "normal"], fill_value=0).to_dict(),
        "rainfall_source": "CHIRPS v3.0, Climate Hazards Center, UC Santa Barbara",
        "boundary_source": boundary_source,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print(f"Step 6: wrote results to {out_dir}")


# --------------------------------------------------------------------------
# Put the steps together
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--end", help="last dekad to include, e.g. 2022-09-3 "
                                      "(default: newest available)")
    parser.add_argument("--out", default=str(OUTPUT_DIR),
                        help="folder for the dashboard data files")
    args = parser.parse_args()
    end = tuple(int(x) for x in args.end.split("-")) if args.end else None

    states, states_simple, boundary_source = get_state_boundaries()

    print("Step 2: checking which CHIRPS files are online ...")
    available = list_available_dekads()
    recent = choose_recent_dekads(available, end)
    for k in recent:
        print(f"         recent: {dekad_label(*k)}  ({available[k][1]})")

    print("Step 3: averaging recent rainfall over each state ...")
    per_dekad = [state_mean_rainfall(available[k][0], states) for k in recent]
    recent_totals = np.sum(per_dekad, axis=0)   # add the dekads together

    print(f"Step 4: building the {BASELINE_START_YEAR}-{BASELINE_END_YEAR} baseline ...")
    baseline_totals = build_baseline(recent, states, available)

    print("Step 5: comparing and assigning flags ...")
    results = compare(states, recent_totals, baseline_totals)
    print(results.flag.value_counts().to_string())

    write_outputs(results, states_simple, recent, available, boundary_source,
                  Path(args.out))


if __name__ == "__main__":
    main()

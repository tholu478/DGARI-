"""
One-off helper: make the river lines shown on the Map screen.

Downloads Natural Earth 1:10m rivers (public domain), keeps Nigeria's main
rivers, clips them to Nigeria and saves a small file for the website.
The rivers are for orientation only; they are not used in any calculation.

    python pipeline/make_rivers.py
"""
from pathlib import Path

import geopandas as gpd
import requests

PROJECT_DIR = Path(__file__).resolve().parent.parent
URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
       "geojson/ne_10m_rivers_lake_centerlines.geojson")
KEEP = ["Niger", "Benue", "Bénoué", "Kaduna", "Sokoto", "Gongola",
        "Hadejia", "Komadugu Yobe", "Ogun"]

raw = PROJECT_DIR / "data" / "boundaries" / "ne_10m_rivers.geojson"
if not raw.exists():
    raw.write_bytes(requests.get(URL, timeout=300).content)

rivers = gpd.read_file(raw)
rivers = rivers[rivers["name"].isin(KEEP)][["name", "geometry"]]
nigeria = gpd.read_file(PROJECT_DIR / "data" / "boundaries" / "nga_adm1.geojson").dissolve()
rivers = gpd.clip(rivers, nigeria.buffer(0.05))
rivers["name"] = rivers["name"].replace({"Bénoué": "Benue"})
rivers = rivers.dissolve(by="name").reset_index()
rivers["geometry"] = rivers.simplify(0.01)
rivers.to_file(PROJECT_DIR / "docs" / "data" / "rivers.geojson", driver="GeoJSON",
               COORDINATE_PRECISION=3)
raw.unlink()   # the full world file is large; we only keep the small result
print(rivers[["name"]].to_string(index=False))

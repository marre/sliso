# Water masking (experimental)

The walking raster can be alpha-masked using polygonal water geometry exported
from OpenStreetMap. This is independent of MapLibre style layer order.

1. Prepare a *bounded* GeoJSON FeatureCollection of OSM water **polygons** for
   the service area (e.g. with osmium/ogr2ogr). Do not use raw coastline lines
   as polygons. For sea coverage, supply a separately validated ocean polygon
   dataset; the included exporter does not create ocean polygons.
2. Run `python scripts/export_water_mask.py --geojson input.geojson --output public/water.geojson`.
3. Set `VITE_WATER_GEOJSON_URL=/water.geojson` at Vite build time.

When the variable is unset, or the fetch fails, walking coverage renders
unmasked (fail open). Water pixels become transparent before canvas upload;
the original contour data and routing results are unchanged. The raster mask
is cached by grid size and geographic bounds, so cutoff changes reuse it.

**Limitations:** This is a first implementation. It requires an externally
prepared and validated OSM polygon export, which is **not bundled** in the
repository. Large whole-region GeoJSON can be expensive to download and
rasterize; production should use spatially tiled, versioned masks and benchmark
cold-load latency on mobile. Coastlines/ocean need a separate source. Check
bridges, islands, docks and shoreline accuracy visually. OSM attribution and
ODbL obligations apply to exported datasets.

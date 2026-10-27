# Water masking (draft)

The walking raster is alpha-masked with independently sourced OSM water
polygons. It does not change routing or MapLibre layer order.

## Generate static geographic tiles

Export a bounded, tagged OSM water GeoJSON FeatureCollection (natural=water,
waterway=riverbank etc.) from a regional OSM extract. Coastlines are lines,
not polygons: separately prepare a *clipped, validated* ocean polygon
FeatureCollection (for example from an OSM-derived land/ocean dataset).
Both inputs must use WGS84 longitude/latitude coordinates. Avoid unbounded
global ocean polygons.

```sh
python scripts/export_water_mask.py \
  --geojson .data-build/water.geojson \
  --ocean-geojson .data-build/ocean.geojson \
  --output public/water-tiles
```

Omit `--ocean-geojson` only for inland tests. The exporter writes
`index.json` plus spatial tiles. A polygon crossing multiple tiles is
duplicated; the renderer clips it to the current raster grid. Avoid very large
polygons and benchmark output sizes before publishing.

Set `VITE_WATER_TILES_URL=/water-tiles` at **build time**. The browser loads
only tiles intersecting the walking raster's bounds. It caches the tile fetches
and the per-grid mask for cutoff changes. If data is absent, no masking occurs.
If a tile fails, the overlay remains visible rather than disappearing.

## Release checklist

- Source water and ocean polygons from documented, reproducible OSM extracts;
  review ODbL obligations and attribution.
- Verify islands, bridges, riverbanks and coastal boundaries in the preview.
- Confirm tile size, cold-load latency, and memory use on mobile devices.
- Ensure the generated static tiles are deployed with the same build.
- Keep the PR as draft until real water data and tests are in place.

The repo does not yet bundle the regional OSM water/ocean export. The
implementation is inactive unless the environment variable and files are
provided.

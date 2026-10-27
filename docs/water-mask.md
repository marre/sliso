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

## Automated source preparation (new)

A manual GitHub Actions workflow, `.github/workflows/water-mask.yml`,
fetches the checksum-pinned OSM extract already used by the walking build,
filters water ways/relations with Osmium, converts and clips inland polygons
using GDAL, and downloads the WGS84 split ocean polygons from OSMCoastline.
It clips each polygon into bounded 0.25-degree tiles using Shapely, validates
tile sizes, and uploads a seven-day `sliso-water-tiles` artifact.

For local execution on a machine with `osmium`, `ogr2ogr`, `curl` and
Python `shapely>=2,<3` installed:

```sh
python scripts/prepare_water_mask.py --pbf .data-build/osm-cache/VERIFIED.osm.pbf \
  --output public/water-tiles --bounds 17.2 58.7 19.8 60.4
```

The bounding box is a configurable **initial Stockholm-region estimate**,
not a guaranteed complete SL service boundary. Verify it against stop and
walking-contour extents before deployment. The ocean ZIP is a mutable external
source; for fully reproducible releases, record its SHA-256 and archive
snapshot before publication.

The workflow is deliberately opt-in and publishes an artifact, **not a
production deployment**. To activate a preview, copy the validated artifact
to `public/water-tiles`, set `VITE_WATER_TILES_URL=/water-tiles` in the
Cloudflare build environment, and rebuild. Water masking is otherwise off.

## Shared walking-data build (PR #6)

The preferred build path is `.github/workflows/data.yml` with `prepare_walking=true`,
`prepare_water=true`, and `inventory_only=false`. The walking source is resolved
and SHA-256 verified once by `prepare_walking.py`; the same local PBF is passed
to `prepare_water_mask.py`. The resulting `sliso-water-tiles` artifact is
**not automatically deployed**. It still needs coastline and island review,
and the browser currently reads optional water tiles rather than an embedded
walking-data mask.

The walking provenance currently identifies a dated OSM extract which may no
longer be available upstream. Until source rotation is implemented with a new
checksum and recorded provenance, a fresh CI rebuild may fail. Never silently
substitute `latest` bytes for the pinned walking-source SHA-256.

Manual `prepare_water_mask.py` calls must now specify `--pbf` pointing to the
verified walking source. The standalone water workflow uses the same pinned
source resolver but is intended only for troubleshooting.

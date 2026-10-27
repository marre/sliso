# Water masking from the walking-data build

Water uses **the same checksum-verified Geofabrik Sweden OSM extract** as the
walking network. A manual full walking rebuild resolves Geofabrik's latest
snapshot, validates its published MD5, calculates SHA-256, and stores exact
provenance as `osm-source.json`. Historical walking provenance remains
unchanged. New builds use an immutable SHA-256-derived walking version.

## Build

In **Prepare SL data** (`.github/workflows/data.yml`) choose:

- `inventory_only=false`
- `prepare_walking=true`
- `prepare_water=true`
- `publish_release=false` for first verification

The builder extracts inland water polygons from the same OSM PBF and clips
separate OSMCoastline ocean polygons (coastline lines alone are insufficient).
It then precomputes 512×512, one-bit-per-pixel geographic water tiles. The
intermediate GeoJSON tiles are not served to browsers.

`scripts/build_data.py --water-mask <prepared-walking/water-bitmap>`
packages the binary tiles alongside immutable walking data and writes
`manifest.waterMask` with per-file SHA-256 hashes. The browser uses the
normal verified data loader and applies the mask to the travel-time raster,
without downloading or rasterizing water polygons.

The mask resolution is 0.25° / 512 pixels (approximately tens of metres,
depending on latitude). Check narrow islands, bridges and shorelines in the
preview before enabling a production release. Ocean sources are independently
updated; record/archive their exact checksum for strict reproducibility.

## Caveats and rollout

A fresh full walking build has significant runtime, OSM processing and GTFS
cost; it is opt-in. The current bounds `17.2 58.7 19.8 60.4` are
provisional and must be compared with actual SL coverage.

Newly generated mask tiles remain part of the **same data release**.
Older releases without `waterMask` retain their existing raster behaviour.
The retired standalone water workflow and `VITE_WATER_TILES_URL` setting are
no longer used.

Before merging, run Python and browser tests and one complete manual walking
build with water enabled, inspect coastal coverage, and verify the publication
size budget. Production deployment remains opt-in.

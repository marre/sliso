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

## Non-publishing validation run

Start the complete build explicitly, without changing the release pointer:

```sh
gh workflow run data.yml --repo marre/sliso --ref main \
  -f inventory_only=false -f prepare_walking=true -f prepare_water=true \
  -f publish_release=false -f deploy=false -f export_source=false \
  -f initialize_quota_ledger=false
```

Wait for the build to succeed and download `sliso-validated-data` into a separate
staging directory. Run `scripts/verify_water_release.py --root <staging>/data`
before packaging with `scripts/release_data.py pack`. Keep the generated release
archive and descriptor outside tracked `data/release.json` until publication.
The workflow refreshes the shared walking cache; subsequent scheduled builds can
reuse the completed water-enabled inputs.

Departure and arrival raster layers both use the manifest's verified water mask.
If a declared mask cannot be loaded or its metadata is invalid, the affected
raster is hidden rather than displayed without clipping. Releases without a
mask retain legacy behaviour. Missing tiles are not proof of land: inspect the
configured geographic coverage as part of release validation.

Local regressions: `npm test`, `npm run test:python`, `npm run build`, and
`npx playwright test tests/browser/water.spec.ts`. The browser test checks water
removal and island preservation at two zoom levels on desktop and mobile.
Real coastlines, narrow islands and bridges still require geographic inspection;
a raster mask does not validate the underlying walking routes.

### Validation attempt, 2026-11-04

Non-publishing run: https://github.com/marre/sliso/actions/runs/41889015340
The verified Sweden OSM download succeeded, but the OSMCoastline ocean ZIP
connection timed out after all retries. An independent request from the cloud
development environment returned HTTP 503 for both the ZIP and the official
documentation page. No validated water release was produced or published.

Resume when the authoritative source is reachable, or provide a previously
verified OSMCoastline WGS84 ocean archive through the existing
`prepare_walking.py --ocean-archive <path>` option. Do not omit ocean polygons:
inland water alone cannot mask the Stockholm archipelago correctly.

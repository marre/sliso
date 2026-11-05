# Reviewed walking corrections — 2026-11-05

Three bidirectional reviewed links (six directed edges) are recorded in
`data/reviewed-walking-access.json`. They supplement the mapped network with
explicit estimates. They do not mark endpoints as fully mapped or generate
new walking contours. Existing physical edges are preserved. Moved or renamed
endpoints fail validation and require another review.

## Ringvägen, bus toward Sofia

GTFS stop `9022001010971001` is at 59.318388, 18.049971. OSM bus pole
[675633196](https://www.openstreetmap.org/node/675633196) identifies Ringvägen,
SL ref 10971, at 59.3182095, 18.0499602. The pole lies between the west-side
[footway 1027347480](https://www.openstreetmap.org/way/1027347480) and
[carriageway 151083834](https://www.openstreetmap.org/way/151083834).
The carriageway is tagged `foot=use_sidepath`; the reviewed route follows the
sidewalk and existing mapped crossings, not the carriageway.

The deployed pedestrian graph provides routes from Zinkensdamm bus positions
`9022001010655001` and `9022001010655002` to the adjacent sidewalk, approximately
203 m and 141 m respectively. The final stop-access/coordinate gap remains an
estimate. Conservative whole-link budgets are 250 m / 210 s and 180 m / 165 s.
No underground platform connection is added.

## Björns trädgård / Medborgarplatsen platform B

GTFS positions `9022001010410001` and `9022001010130001` are less than one metre
apart and both identify platform B. OSM bus pole
[719629885](https://www.openstreetmap.org/node/719629885) identifies Björns
trädgård, local_ref B, SL ref 10410 at this location. The reviewed connection
allows 10 m / 30 s for repositioning. It does not connect the metro platforms.

## Exact-search replay

Data: `sl-50332a83c383a786d3f3`. Point origin 59.337866, 18.0026869;
2026-11-04 at 21:11; 60-minute travel budget; 15-minute walking budget;
three transfers; 30-minute departure window; all transport modes.

| Stop | Baseline | With reviewed links |
| --- | --- | --- |
| Ringvägen | 34m12s | 21m05s |
| Björns trädgård | 39m48s | 26m12s |

Replay used the same original network in both runs, with precomputed walking
closure disabled in both so it could not conceal newly added edges. Only the
six reviewed edges were added. The baseline reproduced the original reported
values. Both corrected journey witnesses contain estimated walking legs. The
walking-extension invariant audit reported zero violations. Compiled releases
must regenerate their closure normally; never reuse a closure from before the
edge changes.

All 115 Python tests passed, including reviewed-link identity, conservative
costs, bidirectionality, retirement/idempotence and stale-coordinate rejection.
Detailed replay output is retained locally under
`.data-build/ringvagen/reviewed-replay.json`.

Rotebro and Stureby station gaps remain deferred: nearby rail platforms and bus
stops need verified entrance/platform paths and access costs. The broader audit
is a review queue, not proof that every apparent shortcut is legal. This batch
is not a claim that all 77 flagged stop positions have been repaired.

These edits are consumed by `build_data.py` when compiling a new data release.
They have not been rebuilt into a published release or deployed.

> Aktuell regel från v9: samma namn inom 250 meter får en märkt uppskattad gångkoppling när kartlagd riktning saknas. Historiska profiler nedan beskriver även äldre, striktare underlag.

# Trafikurval och gångindex

**Utvecklingsdata, ännu inte komplett för en pilot.**

Beställaren valde 2026-10-19 att inkludera **samtliga linjer i GTFS Regional SL-feeden**, även UL, Waxholmsbolaget och närtrafiken. Detta ersätter tidigare antagande om ett snävare SL-urval. Beslutet finns som `feed-scope.json`; all-feed är ett uttryckligt val. En blandad feed utan policy stoppas av importören.

`walking-index.json` är ett faktiskt, förberäknat och riktat OSM-baserat gångindex: **10 460 par, 1 041 kopplade lägen av 14 219** i feedversion 2026-10-19. `reviewed=false` är avsiktligt. Övriga hållplatser, inklusive järnvägsplattformar, saknar granskade gångkopplingar. Indexet får inte beskrivas som ett fullständigt regionalt gångunderlag.

Gångparen räknades lokalt av Valhalla 3.9.1 med 4,8 km/h, högst 30 minuter och inga externa gång-API-anrop. Endast entydiga buss-/båtlägen inom en meter från en modellerad gångväg accepterades automatiskt. En meters gräns är koordinatprecision vid kartkopplingen; inga fria anslutningslinjer eller gångtider längs fågelvägen har lagts till. Identiska projicerade lägen med olika GTFS-ID:n nekas automatiskt. Plattformar med oklar nivå, entré eller passage kräver uttrycklig granskning.

Det fysiska nätet består av OSM-vägsegment med konservativ gång-/tillträdesprofil. Kända tidsbegränsade kanter och tillträdeshinder utesluts. Automatiska färjeöverfarter ingår inte i gångnätet. Okända tillträden/öppettider och OSM-fel är fortfarande datakvalitetsbegränsningar. Första försöket med enbart exakta befintliga gångnoder gav endast sex kopplade lägen och inga par; Valhalla-steget tillåter även positioner längs faktiska vägsegment med samma strikta precision.

## Licens och ursprung

- GTFS-hållplatsidentiteter/koordinater: Trafiklab/Samtrafiken, **CC0 1.0**, enligt [GTFS Regional](https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/#licence).
- Härledda gångförbindelser: **© OpenStreetMap contributors, ODbL 1.0**, [licens](https://opendatacommons.org/licenses/odbl/1-0/), [OSM-källangivelse](https://www.openstreetmap.org/copyright).
- OSM-utdrag: Geofabrik, Sverige 2026-10-18. Originalfilens leverantörs-MD5 har kontrollerats. SHA-256, källadress, programversion och metod anges i `walking-index.source.json`.
- Den maskinläsbara bearbetade databasen är `walking-index.json`. Källutdrag och den fullständiga metoden för bearbetning anges i källfilen och de öppna skripten nedan. Appens manifest anger aktiva källor; ODbL-attribution följer med distribuerade data.

## Bygg om lokalt (Linux, Python 3.12+)

```sh
python -m venv .data-build/venv
.data-build/venv/bin/pip install -r scripts/requirements-walking.txt
```

Hämta en aktuell Geofabrik-Sverige-PBF och dess tillhörande `.md5` via HTTPS. Kontrollera leverantörens checksumma innan filen används. För denna version är källan och förväntade värden låsta i `walking-index.source.json`. Originalet är cirka 916 MB; ha flera GB ledigt för mellanresultat. En ny källa kräver ny versions-/proveniensfil.

```sh
.data-build/venv/bin/python scripts/osm_walks.py \
  --pbf .data-build/sweden-261018.osm.pbf --gtfs .data-build/source/sl.zip \
  --output .data-build/walking-graph.json.gz
.data-build/venv/bin/python scripts/prepare_pedestrian_tiles.py \
  --graph .data-build/walking-graph.json.gz --pbf .data-build/sweden-261018.osm.pbf \
  --directory .data-build/valhalla
.data-build/venv/bin/python scripts/valhalla_walks.py \
  --config .data-build/valhalla/config.json --gtfs .data-build/source/sl.zip \
  --graph-report .data-build/walking-graph.json.gz.report.json \
  --stop-features .data-build/walking-graph.json.gz.bus-stops.json \
  --output .data-build/valhalla-walks.json
```

Inspektera rapport, ändrade kopplingar och referensfall innan det tidigare indexet ersätts. `--reviewed-bindings` till OSM-steget stöder uttryckliga nodbindningar för den separata grafbyggaren; ange `verified=true` endast efter faktisk kontroll, aldrig för att få bygget att passera. Valhalla-stegets automatiska stationsundantag kvarstår tills separata granskade plattforms-/entréregler implementerats.

Mätprotokoll för nät, tilebygge och par finns under `docs/`. Gångbygget är separat från den dagliga tidtabellen. Flyttade/ändrade hållplatser upptäcks vid nästa GTFS-import; gamla gångtider får inte användas mot nya koordinater. Hållplats-/entréändringar i OSM kräver också nytt gångbygge, föreslaget månadsvis. Ingen stor OSM-PBF eller gatugraf laddas av slutanvändarens webbläsare.


## Senare tillägg: längder och gångområden

`valhalla_walks.py` sparar även nätets rapporterade längd i meter för varje riktat par. `walking_areas.py` använder samma filtrerade nät och automatiska hållplatsbindningar för konturer i steg om 1 minut, upp till 30 minuter. De senare är interpolerade, generaliserade polygoner och **inte** ett intyg om tillträde till all mark i dem. Plattformar utan granskad anslutning saknar fortfarande ytor. Konturer och färdiga appdata distribueras i GitHub Releases enligt `data/release.json`; de stora genererade filerna hör inte hemma i Git. OSM ODbL-attribution och samma käll-/programversion gäller även konturerna. `prepare_walking.py` är den reproducerbara CI-ingången; se `docs/operations.md`.

## Rättning 2026-10-20: små koordinatavvikelser vid busshållplatser

Git-indexet ovan bevaras som äldre basdata. Nya releasebyggen använder profilen
`identified-bus5m-v2`: grundtoleransen är fortfarande 1 meter. För lägen som endast
trafikeras med buss tillåts högst 5 meter om exakt en OSM-busshållplats inom
10 meter har samma namn och, när GTFS anger lägeskod, samma lägeskod. Flera
möjliga gångvägar eller identiska projicerade GTFS-lägen nekas fortfarande.
Detta är en automatisk koordinatmatchning, inte en platsgranskning eller en
allmän anslutning till närmaste väg. Båt-/spårplattformars tolerans utökas inte.

Båda ändarnas koordinatavvikelser adderas till gånglängden och gångtiden med
4,8 km/h innan gränsen 30 minuter tillämpas. Gångområdenas nätbudget minskas
med startlägets anslutningstid. Gångsträckan mellan anslutningarna följer det
filtrerade OSM-nätet. Kända tillträdeshinder och separerade nät kvarstår.

Orsaken och det reproducerade användarfallet finns i
[Skärvik–Skorpvägen–Ankarstocksvägen](../docs/walking-regression.md).

## Rättning 2026-10-20: namngivna OSM-positioner vid Runstensplan

Profil `osm-bus-position-v3` bevarar de tidigare accepterade anslutningarna och
kompletterar dem med identitetsbaserade busshållplatspositioner. Om en GTFS-punkt
inte kan kopplas entydigt får exakt en OSM-`highway=bus_stop` med samma namn och
angiven lägeskod identifieras inom 25 meter. OSM-noden får inte ha kända
begränsningar och får inte vara kandidat för flera GTFS-lägen. Därefter kopplas
**OSM-hållplatsens position**, inte den felplacerade GTFS-punkten, till exakt en
gångväg inom 5 meter. Tvetydiga vägar, för stora avvikelser och spår-/båtlägen
får inte denna komplettering. Identiska projicerade GTFS-lägen nekas som tidigare.

Både GTFS–OSM-avvikelsen och OSM–gångnätsavvikelsen räknas konservativt med i
gångbudget och meter; inga kostnadsfria plattformshopp införs. Själva förbindelsen
routas längs det filtrerade gångnätet. Originalets GTFS-ID/koordinater bevaras för
kontroll mot nästa feed. OSM-nod-ID och koordinatavvikelse sparas i indexets
hållplatsproveniens och ankarfil. Parens upprepade källtext har kortats;
fullständig profil, OSM-hash och Valhalla-version finns i indexmetadata och
manifestets `walkingVersion`. Detta minskar distributionens storlek utan att
ändra tiderna för befintliga par.

Se [Runstensplan-fallet](../docs/runstensplan-regression.md). Det lokala
ombygget med feed 2026-10-19 gav 3 970 anslutna lägen, varav 879 genom den nya
positionstilldelningen, och 133 310 riktade par utan matrisfel. Aktuella
produktionstal hämtas ur manifestet; underlaget är fortfarande partiellt.

## Systematisk rättning: tilldelning, gångkorsningar och lokalgator

Profil `bus-assignment-junction-v4` löser närliggande hållplatslägen gemensamt.
Samma namn/lägeskod, högst 25 meters avvikelse och kända tillträdesregler krävs
fortfarande. En avgränsad bipartit sökning väljer maximal entydig tilldelning
med minsta totala koordinatavvikelse. Endast tilldelningar som är oförändrade
i alla alternativ inom 5 meters total kostnad accepteras. Likvärdiga byten av
riktning, identiska GTFS-lägen och för stora grupper lämnas olösta.

Vid vägkopplingen prioriteras redan accepterad gånggeometri framför en ny
intilliggande gata med standardtillträde. En klart bättre positionsträff på
OSM-hållplatsens gångväg kan skiljas från en sämre kandidat (både minst 2 meters
avståndsskillnad och dubbla avståndet krävs för att förkasta alternativet).
Kvarvarande alternativ måste vara förenade inom 15 meter genom Valhallas
faktiska grafnod-ID:n och tillåtna dubbelriktade kanter. Närliggande koordinater
kopplar aldrig ihop två grafnoder. Separata broplan eller frånkopplade gångbanor
blir därför inte en ny passage genom denna korsningskontroll.

OSM-profilen medger svensk normal gångåtkomst på vanliga `primary`-, `secondary`- och `tertiary`-vägar (inklusive länkar), även på landsbygden. Bilarnas hastighetsgräns är inte
ett gångförbud. `motorroad=yes`, explicit gångförbud, krav på separat sidoväg
(`foot=use_sidepath`), privat åtkomst, kända tidsbegränsningar och barriärer
har företräde. Motorvägar, motortrafikleder och `trunk`-vägar ingår inte i denna standardåtkomst.
En tillåten väg kan sakna trottoar; modellen bedömer åtkomst, inte trafikmiljö
eller lämplighet för barn. Detta rättar de bortfiltrerade 60–70-vägarna vid
Lovö kyrka och Barkarby på Lovön.

`platform-bindings.json` identifierar uttryckligen plattformarna i Vallentuna,
Stockholms östra och Tekniska högskolan med OSM-väg-ID och GTFS-läge.
Vallentunas OSM-stop_area 19354312 anger plattformarna 40140423/40140424;
övriga plattformsytor har också SL:s NeTEx-quay-ID:n. Plattformarnas egna
kartlagda kanter läggs till gånggrafen och ansluts bara via verkligt gemensamma
OSM-noder. Projektionen görs på den identifierade plattformen, aldrig på en
närliggande gata eller en annan nivå. Högst 25 meters koordinatavvikelse räknas
in i gångtid och avstånd; flyttat GTFS-läge, ändrat plattformsnummer, saknad
eller tillträdesbegränsad OSM-yta stoppar bygget. Dessa identitetskontroller
ersätter inte platsgranskning. Övriga järnvägs-/tunnelbaneplattformar ingår inte
automatiskt, och täckningen förblir partiell.

`scripts/walking_audit.py` granskar samtliga yttrafiklägen efter saknade
riktade gångpar och orimligt långa nätvägar mellan närliggande lägen med samma
namn. Den fysiska granskningen använder fågelvägsavstånd bara för diagnos. Separata antagna gångkanter enligt v9 räknas inte som nätbevis. Resultatet
publiceras som Actions-artefakten `sliso-walking-audit`. Kvarstående fynd kräver
granskning; de fylls inte automatiskt med genvägar. De rapporterade fallen
finns i `walking-reference-pairs.json`; bygget stoppas om en kontrollerad
riktning saknas eller överstiger gränsen i referenslistan. Borttagna hållplats-ID:n
redovisas som överhoppade referenser. Denna regressionstestlista är inte en
manuell granskning av alla gångpassager.

Vid Tekniska högskolan ingår de kartlagda hissarna 398632623 och 1516917805,
och två uttryckligt identifierade SL-biljettspärrar (se `station-access.json`).
Vanliga privata grindar är fortsatt uteslutna. Färd-/väntetid i hiss uppskattas
till två minuter per plattformsanslutning, utöver gång över den kartlagda vägen.
Detta är en modellparameter, inte en uppmätt väntetid eller tillgänglighetsgaranti.
Två lokala Valhalla-grafer används: gång mellan yttrafiklägen och deras ytor
använder grafen utan hissar; anslutningar till/från de utpekade underjordiska
plattformarna använder stationsgrafen och betalar stationstiden. Därmed skapas
inte tidsfria genvägar genom hissar mellan två vanliga ythållplatser. Även
stationernas gångytor reserverar anslutningstiden före nätutvidgningen.

Namngivna OSM-busshållplatser som har en enda vanlig vägkorridor inom tio meter
får en tidsatt anslutning till denna. Detta tillägg gäller efter entydig
hållplatsidentifiering, och bara när samtliga närliggande kandidater hör till
samma vanliga väg. Konkurrerande gångbanor, vägar eller plattformar avvisas.
Det löser Barkarbys vägrensläge cirka sex meter från vägens mittlinje utan att
vidga den vanliga GTFS-projektionen till godtyckligt närmaste väg.

Råindexet inkluderar stationstillägget vid plattformsändpunkterna. Vid
kompilering undantas gång mellan två uttryckligt identifierade lägen på
**samma plattformsyta**: ingen hiss eller entré behövs för detta. Den verkliga
kartlagda gångtiden och koordinatavvikelserna behålls, med minst en sekund.
Anslutningar till gatan eller en annan plattform behåller stationstillägget.


2026-10-21: Solbacka på Färingsö och Sundby by kompletterar referenslistan.
En obunden busshållplats får nu använda sin egen GTFS-position vid en entydig
kartlagd gångkorsning inom fem meter, om ett OSM-identifierat syskon i samma
GTFS-stoppområde kan nås över nätet i båda riktningarna inom 250 meter.
Olika broplan förenas inte av koordinater; korsningskontrollen kräver delade
riktiga grafnoder. Inget fågelvägsavstånd ersätter fysisk gång.

Stora gångpaket använder ett självidentifierande JSON-format med `schema: 1`,
`sources` och `edges`: varje rad är `[frånindex,tillindex,sekunder,meter,källindex]`.
`null` som meter bevarar avsaknad av avstånd. Riktning, bråkdelar av sekunder
och full källtext bevaras. Läsaren stöder också äldre oföränderliga JSON-arrayer.
Närliggande gångområden (cirka 110-metersrutor) samlas i filer med högst fyra
lägen. Gammalt genererat shardmaterial tas bort efter ett lyckat nytt index;
andra filer lämnas orörda. Detta begränsar filantal och upprepade hämtningar.

Profil v8 kompletterar samma-stationsregeln med spatial nätverifiering för
busslägen oavsett namn: högst 10 meters tidsatt avvikelse, verklig korsning
inom 50 meter och gång i båda riktningar inom 500 meter till ett etablerat
bussläge högst 250 meter bort. Återställda lägen kedjas inte som bevis.
Alla närliggande par granskas nu i byggets diagnostik, även olika namn.
Se [nät- och resultataudit](../docs/walking-network-audit.md) för gränser,
regressioner och kommandot som kontrollerar en hel delad sökning.

Från gångprofil v9 tillåts ett användarvalt undantag: saknade gångriktningar
mellan lägen med samma namn inom 250 meter får en tydligt märkt uppskattning.
Tid och avstånd ingår i gångbudgeten; uppskattningarna skapar inga gångytor.
Se [metod och begränsningar](../docs/walking-network-audit.md#antagna-byten-mellan-lägen-med-samma-namn-v9).
## Precomputed stop-to-stop walking

Compiled releases may include a checksum-bound, bounded walking-closure table.
It preserves original walking edges and provenance for itinerary reconstruction,
and is generated offline from the existing directed walking graph. It adds no
new inferred access links. See [format, caching and compatibility](../docs/walking-precompute.md).

## Start from a map point

`prepare_walking.py` also exports `sliso-footpaths-v1` tiles from its filtered
pedestrian PBF and verified stop anchors. These are physical walking edges,
not the stop-to-stop closure. Restrictions/barriers remain excluded; no spatial
links between components are added. Global node IDs join adjacent tiles, and an
edge crossing a tile boundary is included in every tile it crosses. Stop anchors
split their identified OSM way, retain existing endpoint access costs, and are
accepted by the client only while the GTFS stop coordinates still match.

The browser loads only tiles within the selected walking radius, verifies their
SHA-256 hashes, decompresses them and runs bounded Dijkstra in the routing worker.
The chosen origin is projected onto a mapped edge within 25 metres; the displayed
start pin moves to that path and the UI reports the snap distance. This is a change
of starting position, not a simulated off-network walking link. A point without a
nearby mapped path produces an explicit error. A mapped point with no reachable
bound stop remains valid for direct walking journeys; it has no transit access. Routes
respect walking direction and retain their physical geometry for the itinerary.
Initial access counts toward journey time, the continuous walking limit and first
boarding feasibility. The existing route scanner, transfer closure and stop-based
contours then operate with those access states. For point origins, the routing
worker also retains bounded directed walking times on mapped edges. The map
interpolates these into filled local walking-time areas, comparable in style
to the published Valhalla stop contours, and merges the earliest time with
the existing transit contour at each display pixel. The interpolation reaches
at most 120 metres perpendicular to a *reachable* mapped pedestrian edge,
charges additional walking time for that distance, and never extends along
a forbidden one-way edge. Nearby mapped streets therefore form coherent
filled areas instead of thin route strokes, without a convex hull or an
invented long-distance link. Direct walking does not require any reachable
stop.

**As with the precomputed contours, the filled area is only a visualization.**
The 120-metre interpolation does not establish public access or a valid
off-network route. Existing water masking removes known water pixels, but
roads on opposite banks of a narrow waterway can still cause approximate
land coverage; unmapped barriers and missing OSM links can also affect it.
For exact directions, point-to-point journeys continue to require a real
mapped, directionally traversable footpath. The walking area respects the
same 30-minute walking limit as the point journey planner.

Files have a `.bin` extension and contain deterministic gzip-compressed UTF-8 JSON
with `schema: 1`, node rows `[id,latE7,lonE7]`, edge rows
`[from,to,metres,seconds,oneway]`, and stop-binding rows
`[node,stopId,accessSeconds,offsetMetres,gtfsLat,gtfsLon]`. The manifest indexes
0.05-degree tiles by `floor(lat / .05)_floor(lon / .05)`. The static host needs no
routing service and no special HTTP compression configuration for these files.

To attach newly built tiles to an existing data release without downloading GTFS:

```sh
python scripts/attach_footpaths.py --root public/data --tiles .data-build/prepared-walking/footpaths
python scripts/prune_data.py --root public/data --keep 2
```

The migration preserves traffic, closure and contour bytes, publishes a new
immutable version and retains the preceding version for clients already open.
Normal data builds accept `--footpaths` and CI refuses to silently drop this feature
if the prepared walking cache is missing. Regenerate with `prepare_walking=true`.

## Published GTFS station connections

The `gtfs-station-access-v1` build policy supplements missing station access using
explicit, directed, unscoped GTFS `transfer_type=2` rows with a positive
`min_transfer_time`. These rows previously constrained boarding without providing
a walking connection, leaving named parts of a complex disconnected (for example
Odenplan / Stockholm Odenplan and T-Centralen / Stockholm City).

Only pairs in **different original weakly connected walking components** are
eligible. Existing walking paths are never shortened, and mapped one-way
restrictions cannot be bypassed by adding a reverse edge inside a component.
Components are frozen before adding links: each added direction requires its own
GTFS declaration. Self-transfers, retired endpoints, zero-time transfers,
trip/route-specific rows and explicitly forbidden generic pairs are excluded.
The walking cost uses the published time, conservatively bounded below by physical
straight-line travel time at 4.8 km/h, and must fit the supported walking limit.
Duplicate generic declarations use the longest time. Straight-line distance is
only a consistency guard; it is never displayed as a measured walking distance.

These links are labelled **estimated**. They have no invented path geometry or
measured distance, add no contours, and do not alter strict mapped access from an
arbitrary map origin. Actual GTFS minimum-transfer and scoped prohibition checks
still apply at boarding; walking time and minimum transfer time overlap rather
than being charged twice. All walking continues to share the same continuous-leg
budget. The exact offline closure is rebuilt with original-edge witnesses, so the
client continues to use precomputed lookups.

Normal feed compilation applies this policy. To update an existing pinned release
without fetching GTFS or OSM, run `scripts/migrate_transfer_walks.py --root DATA`.
It preserves timetable, footpath-tile and contour bytes, publishes a new immutable
version, and retains the previous one. The `Publish declared station transfers`
Actions workflow packages that migration outside Git.

# Dataflöde

## Produktion kräver verkligt underlag

Kompilerad GTFS följer inte med i Git. Ett verkligt men partiellt OSM-gångindex medföljer under `data/`; se [källor och metod](../data/README.md). `scripts/demo.py` skapar ett litet syntetiskt nät med riktiga ortnamn för orientering. Avgångar, linjeförlopp och gångtider är uppdiktade; appen visar testläge även när mobilpanelen är stängd.

1. Skaffa **GTFS Regional SL**, inte en godtycklig regional feed. API-nyckeln används enbart i byggmiljön. Trafiklab-konto i sig ger inte åtkomst till filen här.
2. Inventera feeden per linje/trafikslag och gränsöverskridande sträcka. Importören skriver `report.json` med samtliga linjer, trafikslagsfördelning, faktiska `transfers.txt`-rader per typ och antal gångluckor. Detta är en inventering, inte ett intyg att SL-täckningen är fullständig.
3. Förbered ett granskat gångnät inklusive plattforms-/stationsanslutningar. Bind hållplatser uttryckligen till rätt gångnod. Det medföljande partiella indexet använder en konservativ projektion högst 1 meter till en unik väg för yttrafik; den är inte ett granskat plattformstillträde. Nya releasebyggen tillåter dessutom högst 5 meters koordinatavvikelse vid entydigt identifierade OSM-busshållplatser och räknar med anslutningstid/-längd; se [metod och begränsningar](../data/README.md).
4. Bygg och validera datasetet. Granska stations-/resefallen och licenser före pilot/publicering.

```sh
python scripts/build_data.py --gtfs .data-build/sl.zip --walks data/walking-index.json --scope data/feed-scope.json
npm run build
```

GTFS-import kan också köras direkt med ett externt verifierat hållplatspar-index enligt formatet nedan. Ett tomt gångindex stöds för diagnos, men är en tydlig täckningslucka och uppfyller inte produktionskravet på gånganslutningar.

## Granskad gånggraf

`build_walks.py` gör riktade, avståndsbegränsade Dijkstra-sökningar över gångbara grafkanter. Ingen gång-API-förfrågan görs i webbläsaren eller av denna förberäkning. Grafen kan tas fram från OSM med lokal routingmotor eller ett granskat exportverktyg. `osm_walks.py`, `prepare_pedestrian_tiles.py` och `valhalla_walks.py` levererar en separat lokal OSM-PBF-pipeline; se [metoden](../data/README.md). För en manuellt granskad graf används `build_walks.py --graph <graf> --output <index>`. Stationsinventering och bevis på tillträde kräver fortsatt granskning.

Minimal formatskiss (värdena är endast syntaktiska exempel):

```json
{
  "version": "osm-export-YYYY-MM-DD-survey-v1",
  "attribution": ["© OpenStreetMap contributors · ODbL", "Stationsinventering: …"],
  "nodes": ["osm:1", "osm:2"],
  "stops": [
    {"id":"GTFS-ID-A","node":"osm:1","lat":59.3,"lon":18.0,"verified":true,"source":"platsgranskning/referens"},
    {"id":"GTFS-ID-B","node":"osm:2","lat":59.31,"lon":18.01,"verified":true,"source":"platsgranskning/referens"}
  ],
  "edges": [
    {"from":"osm:1","to":"osm:2","metres":400,"source":"osm-way/revision","oneWay":false,"extraSeconds":0,"restricted":false}
  ]
}
```

Kantlängder ska komma från verkliga gångvägar. Gångtid beräknas med 4,8 km/h och eventuella dokumenterade fysiska tillägg (t.ex. trappor). `oneWay` avser gångriktning, inte vägens bilregler. Kända tillträdesbegränsningar (`restricted`, `openingHours`, `foot=no/private/customers`) utesluts konservativt. En graf utan kända hinder är inte bevis för öppet dygnet runt. Anslutningskanter mellan plattform och gångnät måste också granskas; koordinatöverensstämmelse ensam är inget gångbarhetsbevis.

## Förberäknade gångpar

```json
{
  "version":"audited-walking-v1",
  "maxMinutes":30,
  "speedKmh":4.8,
  "stops":[{"id":"GTFS-ID-A","lat":59.3,"lon":18.0},{"id":"GTFS-ID-B","lat":59.31,"lon":18.01}],
  "edges":[{"from":"GTFS-ID-A","to":"GTFS-ID-B","seconds":300,"source":"granskad nätverksrutt/referens","restricted":false}],
  "attribution":["Källor och licenser"],
  "warnings":["Kända begränsningar"]
}
```

Riktning sparas. Inga implicita omvända kanter skapas av importören. ID och koordinater måste matcha den aktuella feeden (tolerans 0,000001 grader för serialisering). Flyttade eller borttagna hållplatser stoppar bygget. Saknad fysisk gångtid blir aldrig `min_transfer_time`. Bygg om när graf, plattformar eller bindningar ändras; månadsvis granskning föreslås.

## GTFS-stöd och försiktiga begränsningar

- Faktiska trafikdagar via `calendar_dates.txt`, eller `calendar.txt` med undantag.
- Tid över 24.00 kopplas till rätt trafikdygn. GTFS-sekunder förankras enligt noon-minus-12h i Stockholm; faktisk UTC-avgång styr datapaketets dygn, även från föregående trafikdygn.
- Alla stopp på samma trip får sittas kvar förbi; tillåten första påstigning och slutlig avstigning respekteras.
- `pickup_type`/`drop_off_type` 1 (förbjudet) och 2 (telefonbokning) används inte; bokningsregel-ID eller flexibla tidsfönster nekas också. Typ 3 (samordning med förare) ingår och markeras i resultatet. Detta krävs för normal buss-/spårvagnstrafik i den faktiska feeden. [GTFS-referensen](https://gtfs.org/documentation/schedule/reference/#stop_timestxt) skiljer föraresamordning från telefonbokning.
- Stationer expanderas för `transfers.txt`, utan att skapa gångkanter. Barnläge väljs uttryckligen i appen.
- `transfer_type` 0–3 med trip-/route-villkor stöds. Resor ska uppfylla både fysisk gång och regelns tid. Trip-specifika regler har företräde framför route- och hållplatsregler; lika specifika motstridiga regler tolkas konservativt.
- Olika trip_id räknas som olika fordon. `transfer_type` 4/5 (in-seat) stoppas uttryckligen för vidare modellarbete; de ignoreras inte.
- `frequencies.txt`, saknade hållplatstider och okända trafikslag stoppar importen för explicit expansion/klassificering. Ingen tyst utelämning. Nuvarande standardtyper: 0/900 spårvagn, 1/400/401 metro, 2/100/109 tåg, 3/700 buss, 4/1000 båt. **Lokalbanornas produktgruppering måste granskas mot verkliga route_id:n**; en GTFS-typ i sig bevisar inte SL-produkt.
- Urvalet i `data/feed-scope.json` väljer uttryckligen alla aktörer i feeden, enligt beställarens svar 2026-10-19. En blandad feed utan policy stoppas. Hela det valda utbudet behandlas; kartutsnittet beskär aldrig söknätet. Även UL, Waxholmsbolaget och närtrafiken ingår avsiktligt; detta anges i datainformationen.
- Saknad gång mellan olika stopp tillåts aldrig. Ett byte på exakt samma hållplatsläge behöver ingen fysisk förflyttning, men eventuella minsta bytestider gäller fortfarande. Inga generella extra påstigningsmarginaler införs utöver datareglerna.

## Paket och atomisk publicering

En manifestversion refererar endast oföränderliga filer under `/data/<version>/`. SHA-256 och byteantal kontrolleras innan användning, även för cacheträffar. Hållplatser, gång, rutter, tur-ID:n och bytesregler ligger i separata filer. Tidtabellen består av little-endian uint32-poster à 36 byte:

`from, to, departureEpoch, arrivalEpoch, tripIndex, routeIndex, sequence, pickupFlags, dropoffFlags`.

Manifestets **schema 2** har `days[UTC-datum]` som en lista av tidsblock med SHA-256, byteantal samt `from` (inklusive) och `until` (exklusive), i epochsekunder. Trafiken partitioneras efter UTC-timme, med högst 100 000 poster per fil. Endast block som överlappar frågan laddas. Pickup-/dropoff-flaggornas bit 0 betyder tillåtet och bit 1 betyder meddela föraren. Share-formatet är fortsatt version 1. Äldre datamanifest behöver byggas om. Dygnspaket sorteras på faktisk UTC-avgång. Alla dygn som berör `t0 … t0 + avgångsfönster + maxtid` måste finnas. Turbundna bytesregler lagras en gång med GTFS-bas-ID; motorn matchar dem mot daterade turinstanser. Ingen kartesisk produkt av trafikdygn skapas. Därför kan en nattresa från sista valbara dagen behöva nästa dygn. Importören håller en extra servicedag och begränsar valbar giltighet därefter. Föregående trafikdygn med tider över 24.00 ingår också. Vald lokal tid konverteras oberoende av besökarens tidszon. Tvetydiga/ogiltiga lokala klockslag avvisas med förklaring.

Byggaren skriver alla filer innan manifestet atomiskt ersätts. Ett misslyckat bygge lämnar föregående manifest orört. Den ersätter inga källfiler. CI behåller aktuell och senast föregående identifierade, genererade versioner med `scripts/prune_data.py`; okända kataloger och symlänkar rörs inte. CI:s cache bevarar tidigare paket inför nästa Pages-deploy, så att pågående klienter kan hämta sin version. Driftansvarig måste rensa gamla versioner och hålla koll på totalkvoten; inga filer över 25 MiB publiceras. Vid för stora filer stoppas bygget för partitioneringsarbete, inte förlust av giltiga förbindelser. En verklig feed har kompilerats och mätts, men den partiella gångtäckningen begränsar vad mätningen visar. Fysisk mobilprestanda och full gång-/stationsmodell återstår.

Den första verkliga feedens inventering finns i [SL-feed 2026-10-19](sl-feed-2026-10-19.md). Den innehåller flera trafikaktörer. Beställaren har därefter valt att alla linjer i feeden ska ingå.

### Lossless delivery contours (`sliso-contours-v1`)

The compiler keeps the native JSON walking-generation cache, but publishes binary
`.bin` shards and sets `walkingAreas.format` to `sliso-contours-v1`. An absent
format still means legacy JSON. Unknown formats fail explicitly. The map worker
fetches, verifies, decodes and retains only the current viewport's profiles; the
UI thread sends stop IDs and walking allowances, rather than coordinate objects.

Delivery files are explicitly gzip-compressed (deterministic mtime zero). Hashes
and byte counts describe the compressed file; the worker verifies those bytes
before streaming decompression. This avoids relying on the host compressing
application/octet-stream. Uncompressed archives remain readable.

All integers and doubles in the decompressed archive are little endian. It begins
with uint32 magic `0x534c4131` and a uint32 UTF-8 JSON-directory byte count. Its
body starts at the next eight-byte boundary. The directory maps stop IDs to
`{minutes,offset,length}` entries, with byte offsets relative to the body. Chunks
are contiguous in directory order. Each geometry chunk contains four uint32s:
magic, vertex count, ring count and polygon count. Magic `0x534c5131` means signed
Int32 coordinates divided by 1,000,000; `0x534c5031` means Float64 coordinates.
Then come `ringCount+1` vertex offsets and `polygonCount+1` ring offsets (uint32),
eight-byte alignment padding, and interleaved longitude/latitude coordinates.
Empty source contours are valid. Polygon versus one-part MultiPolygon is not
retained as a tag: their ordered rings and raster semantics are identical.

Fixed point is selected per geometry only when **every coordinate round-trips
exactly**; finer source precision uses Float64. No contours, islands, holes or
minute budgets are removed or simplified. The renderer divides integer coordinates
by the scale before projection, preserving the existing pixel-centre scanline rules.
This changes storage and decoding, not walking accessibility assumptions.

For an existing compiled release, run
`python scripts/convert_contours.py --root PATH_TO_VERIFIED_DATA`. The migration
verifies all input checksums and compares every decoded coordinate against the
source. Transit packages keep their original bytes and the physical walking
version stays unchanged. It writes a new immutable version and retains the old
version for open clients. Package and publish it with `release_data.py` as usual;
there is no Trafiklab request or OSM rebuild. Before packing, retain only the
immediately preceding release directory to stay within the static asset budget.

## Trafikkatalog för externa klienter

Det ordinarie nattliga GTFS-bygget publicerar även en kompakt, versionsbunden
trafikkatalog. Ingen ny Trafiklab-hämtning, nyckel eller separat tidtabellskörning
krävs. Katalogen omfattar alla återstående aktiva trafikdagar i källans kalender,
inte bara sliso:s kortare sökperiod. Den innehåller inga avgångstider.

1. Hämta `/data/manifest.json` och läs det valfria fältet `serviceCatalog`
   (format `sliso-service-catalog-v1`, URL, SHA-256 och byteantal).
2. Hämta JSON-filen via dess versionsbundna URL. Äldre dataset och demo saknar
   fältet. Server-till-server-klienter kan cacha filen tills manifestet ändras.
3. Katalogens `schema: 1`, `sourceVersion`, `validFrom` och `validTo` avser
   GTFS-källan och de trafikdagar som representeras, inte routingens giltighet.
   `routes` är en map från GTFS route_id till `line` (route_short_name),
   `name` (route_long_name), numeriskt `routeType` och `agencyId`.
   `areas` är en map från GTFS parent_station (eller stop_id om förälder saknas)
   till namn, `stopPointIds` och unika `services` med `routeId` och
   `destination`. Endast lägen med tillåten påstigning före turens sista stopp
   ingår; samma regler för bokning som routingimporten. En destinationsskylt
   hämtas från stop_headsign, annars trip_headsign, annars sista hållplatsens
   områdesnamn. Katalogen bevarar olika route_id även vid samma linjenummer.
4. För SL-formatet `9021001xxxxxx000` finns även `slStopAreaId` (lokalt
   hållplatsområdes-ID som sträng). Det är **inte** ett SiteID. En klient som
   använder SL Transport behöver sammanföra områden via `/sites?expand=true`
   och vid behov exakta GTFS stop-point GID:n via `/stop-points`. Ingen
   namnmatchning, gissning av SiteID eller klassificering av lokala
   trafikslag görs här. Rå GTFS route_type bevaras; SL:s produktkategorier
   och exakt live-destinationsmatchning behöver hanteras av konsumenten.

Alla katalogfiler inkluderas i ordinarie release och verifieras med samma
storleks- och SHA-256-kontroller som övriga tillgångar. Katalogen omfattar
planerade, inte tillfälliga oplanerade, turer. Datumgränserna betyder inte att
varje variant körs varje dag. Källa: Trafiklab / Samtrafiken / SL (CC0).

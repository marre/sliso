# Drift och kvoter

Tjänsten är en utvecklingsversion. Beställaren har publicerat appen via Cloudflares Git-integration till `sliso.markus-eriksson.workers.dev`. Trafikdata uppdateras automatiskt varje natt; gångkartan byggs om på söndagar och vid saknad gångcache. Riktiga tidtabellspaket och ett partiellt gångindex har byggts; gångluckor märks i appen. Repot är publikt enligt GitHub, men dess synlighet har inte ändrats av agenten.

## GitHub Actions

`TRAFIKLAB_GTFS_KEY` finns enligt beställaren som Actions repository secret. Den har verifierats genom lyckad hämtning och inventering. Den behövs aldrig i webbläsaren eller en `VITE_`-variabel.

Öppna **Actions → Refresh SL traffic data → Run workflow** på `main`:

| Input | Funktion |
| --- | --- |
| `inventory_only=true` | Hämta/cachea och inventera trafikdata, utan appbygge eller deployment. |
| `inventory_only=false` | Kompilera aktuell tidtabell med `data/feed-scope.json` och det cacheade gångunderlaget, testa och bygg appen. |
| `initialize_quota_ledger=false` | Återanvänd sparad bokföring. Välj true endast om den beständiga journalen saknas och kvarvarande Trafiklab-kvot har kontrollerats. |
| `export_source=false` | Normalläge. True exporterar validerad rå GTFS som ett separat artefakt för lokal bearbetning; retention 1 dag. |
| `prepare_walking=false` | Återanvänd gångcachen (bygg om automatiskt om den saknas). True bygger manuellt om gångavstånd, gångområden och kartans gångnät från aktuell verifierad OSM-källa. |
| `publish_release=false` | True publicerar kompilerade data som en versionsmärkt GitHub Release och uppdaterar den lilla `data/release.json` i Git. Det triggar Cloudflares befintliga Git-integration. Kräver `inventory_only=false`. |
| `deploy=false` | Bygg för granskning utan att publicera. True kräver dessutom `SLISO_DEPLOY_ENABLED=true` och Cloudflare-inställningarna nedan. |

Artefakten `sliso-gtfs-inventory` innehåller rapport, hållplatser och linjer (7 dagars retention). Ett fullt bygge ger `sliso-validated-data` med `dist/` (3 dagar). Check-workflowens demo är separat och publiceras inte.

Varje natt 03.17 UTC (04.17 svensk vintertid, 05.17 sommartid) byggs och publiceras trafikdata automatiskt. GitHub kan fördröja schemat. De tidigare variablerna `SLISO_DATA_ENABLED` och `SLISO_RELEASE_ENABLED` behövs inte. En ändring av detta workflow på `main` startar också ett trafikbygge, så att driftfixar verifieras direkt. Releasepekarens dagliga commit startar inte ännu ett databyggningsjobb.

På söndagar byggs gångunderlaget om från aktuell verifierad OSM-källa. Det färdiga gångunderlaget har en separat cache (`sliso-walking-v1-`) som återställs av varje nattjobb. Återställningen håller cachen aktiv, men GitHub kan ändå rensa den vid platsbrist. Saknad cache ger därför ett automatiskt gångbygge även en annan natt. Rå OSM/PBF och gamla publicerade datapaket ligger inte i denna cache; bara återanvändbara gångindata sparas. Oförändrade hållplats-ID:n och koordinater behåller gånganslutningar och konturer. Flyttade/borttagna lägen kopplas bort från gamla fysiska gångkanter, konturer och kartankare; nya lägen får inga påhittade fysiska anslutningar. Uppskattade namnbyten och deklarerade GTFS-byten räknas om från aktuell feed. Granskade stationspassagers befintliga validering gäller fortfarande. Gångnätets version, vattenmask och OSM-proveniens bevaras.

## Hämtning och återhämtning

Källadress: `https://opendata.samtrafiken.se/gtfs/sl/sl.zip`. GTFS Regional kräver `Accept-Encoding: gzip`; hämtaren annonserar och avkodar gzip innan ZIP-kontrollen. TLS, ZIP-CRC och efterföljande datapaketkontroller behålls. Råa felkroppar och begärans URL loggas inte eftersom de kan innehålla nyckeln.

Trafikdagar och turbundna regler kompileras till manifest schema 2 med UTC-timblock. `sourceUpdated` anger publicerad feedversion när datumet är känt; `updated` anger bygget. Appen markerar äldre källa och avvisar datum utan datatäckning. Vid ett misslyckat bygge förblir senast distribuerade version kvar; ingen automatisk betald reservtjänst används.

Kvotjournalen ligger i `quota.json` på branchen `data-state`. Varje anropsförsök committas och pushas **före** Trafiklab-anropet; om lagringen misslyckas görs inget anrop. Det skyddar även vid avbrutna jobb och cacheförlust. Vid första övergången importeras den gamla journalen från Actions-cache. Saknas både beständig journal och gammal cache stoppas hämtningen; använd då uttrycklig initiering efter kvotkontroll. Source-ZIP cacheas separat och återanvänds checksummeverifierad inom UTC-datumet. Ny kalendermånad nollställer månadsräknaren; taket är fortsatt 45 försök. Andra klienter med samma nyckel räknas separat. `data-state` kör inte Checks och ska inte vara Cloudflares produktionsbranch.

Efter en kodfix: **Run workflow** på senaste `main`, inte **Re-run jobs** på en äldre commit. Om API-nyckeln ändrats efter ett misslyckat försök gör nästa körning ett nytt försök; ingen ny secret behövs.

## Cloudflare Workers med befintlig Git-integration

Cloudflare kan bara bygga de filer som finns i en ny utcheckning. `public/data` är avsiktligt ignorerad i Git. Actions-artefakter följer inte med en Git-utcheckning och är heller ingen permanent anonym nedladdningsadress.

Datakedjan är därför:

1. **Prepare SL data** med `inventory_only=false`, `publish_release=true`, `initialize_quota_ledger=false` och `deploy=false` hämtar eller återanvänder GTFS, bygger och testar riktiga data.
2. Ett separat jobb med `contents: write` packar data till `sliso-data.zip` och publicerar en versionsmärkt GitHub Release. Arkivet ligger utanför Git; källa, gånglicenser och begränsningar följer med manifestet och repo-dokumentationen.
3. Jobbet uppdaterar endast den lilla `data/release.json` i `main`, med en fast versionsadress, SHA-256 och storlek. Det utlöser Cloudflares Git-integration. Releases skrivs inte över. Skyddad huvudbranch måste tillåta denna botuppdatering eller få pekaren uppdaterad via PR.
4. `npm run build` kör `prebuild`, som hämtar paketet om lokalt manifest saknas. Hela arkivets checksumma/storlek och manifestets samtliga filreferenser verifieras före installation. Fel stoppar bygget; ingen demo skapas som reserv. Därefter kopierar Vite data från `public/data` till `dist/data`.
5. `wrangler.jsonc` publicerar `dist` som statiska Workers Assets. `/data/manifest.json` blir riktig JSON. Saknade filer ger 404 i stället för att returnera appens HTML.

I **sliso → Settings → Build** i Cloudflare används:

| Inställning | Värde |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | repots rot |
| Production branch | `main` |

Cloudflares befintliga integration sköter autentiseringen. Ingen ny Cloudflare- eller Trafiklab-hemlighet behövs för detta flöde, och ingen R2-bucket krävs. Det publika datapaketet hämtas under bygget; besökare hämtar data från samma Cloudflare-origin som appen.

För att uppdatera gångkartan körs `prepare_walking=true`, `inventory_only=false` och `publish_release=true` manuellt. Detta fungerar även mellan söndagens automatiska gångbyggen. Trafikbyggen återanvänder därefter gångcachen. Vattenmasken och dess OSM-proveniens behålls när gångdata återanvänds; om releasen har vattenmask byggs den om tillsammans med nästa gångkarta.

`npm run data:pull` tvingar en verifierad hämtning av den versionslåsta releasen även när lokal data finns. Vanligt `npm run build` bevarar befintlig lokal data, inklusive uttryckligt skapade testfixturer. Stora dataarkiv och `public/data` ska aldrig checkas in. En tidtabellsversion utan gångområden är cirka 77 MB komprimerad; gångkonturer och sparade tidigare versioner ökar arkivets storlek. De större gångindexen ryms fortfarande under 25 MiB per fil. Total storlek hindrar inte statisk publicering eftersom varje fil ligger under 25 MiB. Aktuell och tidigare sparade versioner paketeras tillsammans för redan öppna klienter.

Nattjobbet publicerar alltid en validerad GitHub Release och uppdaterar pekaren på `main`; Cloudflares befintliga Git-integration publicerar webbplatsen. Misslyckade byggen ersätter inte den senaste fungerande releasen. Gamla GitHub Releases ligger kvar tills ägaren väljer en separat retentionspolicy.

## Alternativ: Cloudflare Pages från Actions

Appen är statisk: `npm run build`, utdatamapp `dist`. Alla riktiga data ska först finnas under `public/data`. För manuell deployment via Actions behövs:

- repository variable `SLISO_DEPLOY_ENABLED=true`;
- repository variable `CLOUDFLARE_ACCOUNT_ID`;
- repository secret `CLOUDFLARE_API_TOKEN`;
- Pages-projekt `sliso` och en manuell körning med `deploy=true`.

Dessa värden har inte konfigurerats av agenten. Ingen Worker, R2, betalplan eller publik reposynlighetsändring krävs. En eventuell deployment visar fortfarande utvecklingsmärkning så länge gångindexet har `reviewed=false`. Att koden bygger är inte ett pilotgodkännande.

CI behåller aktuell och senast föregående identifierade genererade dataversion. Det utökade gångnätet gör att tre fulla versioner skulle överskrida den tidigare arkivbudgeten 512 MiB vid kommande uppdateringar. Den redan publicerade övergångsreleasen med tre versioner är 524 355 920 byte, under gränsen 536 870 912 byte. `prune_data.py` tar bara bort kataloger med matchande generatorstämpel och version under angiven datarot; okända kataloger och symlänkar lämnas orörda. Klienter som hållits öppna länge och behöver en borttagen version måste ladda om; nya och gamla paket blandas aldrig.

## Mätt budget och kvarvarande kontokrav

| Resurs | Observerat / stoppregel |
| --- | --- |
| Trafiklab Bronze | Dokumenterade 50 hämtningar/månad; lokal spärr 45 försök och högst en lyckad hämtning per UTC-dag. Normal daglig trafik 28–31 hämtningar. Delad kontokvot kan bara kontoinnehavaren verifiera. |
| Statisk data | Cirka 225 MB okomprimerade index för 10 UTC-dygn i det första bygget; 5,76 miljoner förbindelser. Största filen cirka 9,6 MB. Aktuell + föregående version behålls i kommande byggen för att begränsa tillväxten. |
| Pages Free | Bygget stoppar vid 25 MiB per fil eller fler än 20 000 filer. Drygt 240 trafikblock per dataversion; ingen serverberäkning per fråga. Kontovillkor ska kontrolleras före deployment. |
| Första dataurval | Uppmätt offline-gzip omkring 4,2 MB i referensfrågorna, cirka 23,4 MB före komprimering. Det är beräknad kompression, inte observerad HTTP-överföring på en telefon. |
| Sökning | Lokal Web Worker. Minnesbudget 2 miljoner skapade tillstånd; ett överskridande ger ofärdigt resultat. Faktiska tider/configurationer finns i benchmarkprotokollet; mobil peakminne återstår. |
| Gångförberedelse | OSM-utdrag 916 MB; filtrerat nät cirka 2,62 miljoner noder/2,74 miljoner segment. Lokal filtrering 151 s, ombyggnad av Valhalla-tiles cirka 42 s, parberäkning cirka 6 s på denna container. Detta körs separat, inte för varje daglig trafikuppdatering. |
| CI/cache/artefakt | Publik standardrunner används. Kontoinnehavaren behöver kontrollera gemensam lagringskvot och stoppa fakturerad överförbrukning. Cacheförlust stoppar automatiska hämtningar om ledger saknas. Inga betalda reservvägar finns i koden. |
| Karttiles | Utbytbara OSM standardtiles som pilotinställning. Ingen tile-prefetch eller offline-tilecache. HTTP-cache sköts av webbläsaren. Vid fel fungerar hållplatskartan utan bakgrund. Aktuell policy/kapacitet ska kontrolleras före pilot. |

## Lokalt dataarbete

Med en redan hämtad fil behövs ingen API-nyckel:

```sh
python scripts/inventory_gtfs.py --gtfs .data-build/source/sl.zip
python scripts/build_data.py --gtfs .data-build/source/sl.zip \
  --walks data/walking-index.json --scope data/feed-scope.json
npm run build
```

Gångkällor, licenser, checksummor, optional dependencies och ombyggnadsmetod finns i [data/README.md](../data/README.md). Nycklar får inte läggas i källfiler, URL-fragment, artefakter eller loggar. Delningslänkar innehåller användarens startval och inställningar, men ingen central sökhistorik lagras.


## Gångavstånd och områden

`prepare_walking.py` kör de befintliga OSM-/Valhalla-stegen och `walking_areas.py` med 30 konturer, 1–30 minuter, per automatiskt anslutet yttrafikläge. Första lokala körningen gav 1 041 lägen, 1 041 små filer och cirka 90 MB okomprimerade konturer på cirka 22 sekunder efter tilebygget. Inga konturarkiv, PBF-filer eller tiles ligger i Git. Manifestet refererar till checksummebundna filer; klienten hämtar bara filer för relevanta lägen med begränsad parallellitet. GeoJSON återanvänder samma gång-/tillträdesprofil som gångparen.

En gångytas färg anger total restid inklusive föregående färd och byte. Tillåten sista gång är det minsta av återstående restid och återstående budget för sammanhängande gång. Motorn bevarar även alternativa ankomster med mindre förbrukad gångbudget. Konturtiden avrundas nedåt till hela minuter. Första väntan är fortsatt utesluten ur restidsmåttet.

Konturer interpolerar räckvidden i gångnätet; de är **inte** en garanti för gångbarhet eller tillträde till varje punkt innanför polygonen. Även vatten, tomtmark och andra otillgängliga detaljer kan täckas av interpolation. Ytorna märks därför ungefärliga och täckningen ofullständig. Ingen cirkel eller fri plattformsanslutning används som ersättning. Gångområden ger inga klickbara adressrestider eller exakta resvägar till godtyckliga punkter. Gångavstånd i reselistan kommer från routningens faktiska nätlängd; tid multipliceras inte med en schablonhastighet för att skapa påstådda meter.

Vid gångombygge sparas nu Actions-artefakten `sliso-walking-audit` i sju dagar. Den redovisar återstående gångluckor, långa nätdetourer och utfallet för de rapporterade referensparen. En referensregression stoppar publicering; granska underlaget innan referensen ändras. Ingen geografisk genväg skapas för att passera kontrollen.


Den utökade vanliga vägåtkomsten använder nu en intern arkivgräns på 768 MiB
komprimerat och 3 GiB uppackat, med fortsatt högst två sparade versioner.
Cloudflares gränser på 25 MiB per fil och 20 000 filer gäller oförändrat.
Stora gångindex kodas kompakt utan att kasta kanter eller källhänvisningar,
och närliggande gångprofiler grupperas i begränsade shards. Arkivets byteantal,
SHA-256 och alla filers integritet kontrolleras före installation/publicering.

OSM-hämtningen har tre försök med högst 180 sekunders överföring per försök,
20 sekunders anslutningsgräns och avbrytning vid långvarigt låg överföringstakt.
Endast en fullständig SHA-256-verifierad fil får publiceras till källcachen;
avbrutna överföringar sparas separat och återupptas, men används inte av
gångbygget förrän hela filens checksumma stämmer. Felaktiga kompletta filer avvisas. Cachen ligger utanför Git.

Gångprofil v9 skiljer kartlagda gångpar från användarens antagna byten mellan
liknamniga lägen inom 250 meter. Ett byte av den regeln kräver ett nytt gångbygge
(`prepare_walking=true`) och publicering av ny datarelease, inte bara en ny
webbbyggnad. `assumedPairs` i byggrapporten ska redovisas separat från
`mappedPairs`; antagna passager räknas aldrig som godkända fysiska referenspar.

### Format-only contour migration

The manual **Migrate lossless contours** Actions workflow downloads and verifies
`data/release.json`, converts every contour with an exact coordinate round-trip
check, then publishes a new data release and `release.json` descriptor. It uses
GitHub's workflow token for the large asset upload. It makes no Trafiklab or OSM
request and preserves the previous immutable version. Normal future data builds
already emit the compressed fixed-point format; this migration is for older JSON
releases and refuses an already-compressed input.

After the job succeeds, download its `contour-release-descriptor` artifact (or the
release's `release.json` asset), verify the source version and release, then commit
the descriptor to `data/release.json`. Deploy the compatible frontend first. The
workflow does not change the pin automatically.

### Stops without scheduled service and route symbols

`npm run build` runs `scripts/stop_service.py` after installing the pinned release.
It checks every published timetable shard by SHA-256 and records only actual
pickup/dropoff flags (including driver-coordinated stops), across the full data
period and all modes. The version-bound `stop-service.json` bitset lives alongside
the immutable dataset and is generated locally during deployment; no GTFS request,
data archive migration or browser timetable scan is needed. In the current
14,195-stop release it is 2,528 bytes: 11,615 served stops and 2,580 unserved stops,
of which 1,612 were already hidden by the legacy OLD-platform rule.

The UI uses this index for marker visibility, origin suggestions and public counts.
It never removes/reindexes routing nodes, walking edges or physical path tiles.
A missing or mismatched index preserves the previous visibility rules. New GTFS
builds additionally write an explicit `scheduled` flag using the same criteria.
This is independent of the selected search date, time, mode or walk-only arrival.

New builds preserve `route_short_name`, `route_desc`, `agency_id`, `route_color`
and `route_text_color`. Journey symbols and polylines use valid published colours
first, then route classifications. Legacy SL route IDs use a scoped fallback:
blue bus numbers/variants are taken from the pinned feed's explicit blåbuss rows;
metro 10/11, 13/14 and 17/18/19 are blue, red and green. This fallback never uses a
foreign operator's line number as evidence of an SL bus class. Other operators'
buses remain neutral when no classification/colour is provided. The icons are
inline SVGs, with no icon font or image fetch; the time-colour scale is unchanged.

### Automatic origin placement

A single map click/tap selects a new point origin and starts the worker immediately
after a 450 ms double-click guard. Clicking a stop uses that stop as the new origin.
New origin clicks also work during calculation: the previous worker is terminated
and generation IDs reject stale replies. Drag/zoom movement cancels pending origin
selection, and double clicks bubble through station and origin markers to zoom.
Restoring a point-origin sharing link suppresses the automatic call while applying
settings, then launches exactly one search with its saved display cutoff.

Desktop hover continues to inspect destinations; right-click pins the journey.
Touch/pen long-press dispatches the same inspection after 600 ms. Movement beyond
8 px or map dragging cancels the hold; releasing an inspected point cannot also
select an origin. Native context menus are supported without duplicate inspection.

Walking raster grids use their viewport's captured zoom, rather than the live
animation zoom. This keeps cached raster dimensions consistent when contour
files finish loading between zoomstart and zoomend. A browser regression test
delivers a delayed contour during a real zoom animation.

### Repository renamed to marre/sliso

The canonical source repository is https://github.com/marre/sliso. The data
release pointer uses the renamed repository while retaining its original version,
archive size and SHA-256 checksum. Existing releases do not need repackaging.
Release workflows use `GITHUB_REPOSITORY` and follow the rename automatically.
Repository secrets and variables remain attached to the same GitHub repository.
The Cloudflare Worker/project name (`sliso`) and custom domain (`sliso.xr.se`)
remain unchanged. Check the Cloudflare build status after a push to verify that
its Git integration still follows the repository; reconnect it to `marre/sliso`
only if builds stop triggering.

Existing checkouts should run:

```sh
git remote set-url origin https://github.com/marre/sliso.git
```

### MapLibre and Maptoolkit.org basemap

The default vector style is `https://styles.maptoolkit.org/summer.json`.
Maptoolkit.org's community service requires no account or API key. Its
[attribution requirements](https://docs.maptoolkit.org/attribution/) require the
logo (at least 24 px high) and an always expanded copyright line. The official
logo control is bundled; MapLibre's AttributionControl uses `compact: false`
and reads the copyright text from the provider's TileJSON. Mobile overlays leave
space below them for the logo and copyright, including in landscape.

`VITE_MAP_STYLE_URL` optionally overrides the public style URL at build time.
Use `none` for tests or a map with no external basemap requests. The former
`VITE_TILE_URL` / `VITE_TILE_ATTRIBUTION` raster settings are no longer used.
No Maptoolkit key is needed or read. Style/tile/font/sprite requests go directly
to the provider; no map images are prefetched or saved in the app's data cache.
MapLibre's module worker is served from the app's own versioned assets.

Stops and journey lines use native GeoJSON/WebGL layers. Stops retain labelled
keyboard hit targets. The existing contour worker still merges precomputed
contours with its bounded, exact Mercator grid; MapLibre draws that canvas as a
geographically anchored raster texture with nearest-neighbour sampling. Canvas
sources repaint only when pixels change. Panning and zooming transform the
texture on the GPU while new viewport data arrives. Bearing and pitch are locked
to keep the 2D contour/interaction model consistent. Traffic routing, mapped
walking, data checksums and client-side execution are unchanged.

### Dense stop views

Overview stop grouping is local to MapLibre's worker and needs no new data
release, API or server. A displayed set of at least 500 stops groups through zoom
10; zoom 11+ shows individual stop positions. Aggregated groups are hidden,
with no circles, counts, keyboard targets or invisible click interception. Sparse
unclustered stops can remain visible in overview views. Walking areas keep their
time colours. Keyboard targets are limited to 128 in
view and use delegated focus/keyboard handlers. Highlighting updates feature state;
only actual visibility/colour changes rebuild the GeoJSON source. See
[the measured rendering comparison](stop-rendering-performance.md).


## Städning av datareleaser

Efter lyckad publicering och push av `data/release.json` städar samma jobb
GitHub Releases. Publicerade `data-sl-*`-arkiv äldre än 14 dagar tas bort, men
minst de tre senast publicerade datapaketen behålls. Den nya och föregående
releasepekaren samt `data/release.json` på alla befintliga branchers spetsar
skyddas oavsett ålder. Lägg `[keep-data]` i en releases beskrivning för att
behålla ett särskilt rollbackmål. Gamla oanvända brancher kan därför förhindra
städning tills de tas bort eller deras data pekas om.

Utkast, prereleaser och andra releasetyper lämnas kvar. Git-taggar, gångcache,
kvotjournal och redan distribuerade Cloudflare-filer påverkas inte. Om någon
pekare inte kan läsas/valideras eller refererar till en saknad release stoppas
städningen före radering. En branch utan datafil är tillåten (t.ex. `data-state`).
Misslyckad städning markerar jobbet som misslyckat men återställer inte en redan
publicerad release. Bygg av äldre commits kan kräva en ny datareleasepekare när
deras arkiv har raderats.

Förhandsgranska utan att radera (kräver `gh` med repositoryåtkomst):

```sh
python scripts/cleanup_releases.py --repository marre/sliso --protect-descriptor data/release.json
```

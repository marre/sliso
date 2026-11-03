# sliso

Svensk restidskarta för SL-hållplatslägen. Statisk TypeScript-app med MapLibre GL JS och sökning i en Web Worker. Ingen backend, inloggning, adressökning eller betald reservtjänst.

**Status: körbar utvecklingsversion med riktig GTFS-import och ett partiellt OSM-gångindex.** Trafikurvalet omfattar enligt beställarens val samtliga linjer i SL-feeden, även UL, Waxholmsbolaget och närtrafiken. Gångindexet kopplar 1 041 av 14 219 hållplatslägen; stationers entréer/plattformar och de 30 verkliga referensresorna behöver fortsatt granskning. Appen märker därför realdata som utvecklingsläge och visar osäker nåbarhet där gångunderlaget saknas. Webbversionen är publicerad av beställaren via Cloudflare; den är fortfarande en utvecklingsversion.

Ankomstkartor finns via **Varifrån når jag målet?**: välj mål och ”Senast framme” för att se senaste möjliga start från andra platser. [Semantik, algoritm och inkommande gånglager](docs/arrive-by.md).

## Kör lokalt

Node 24 (se `.node-version`) och Python 3.12+ med systemets tidszonsdatabas behövs. Tidtabellsbygget använder Pythons standardbibliotek. Den separata OSM-förberedelsen har extra beroenden enligt `scripts/requirements-walking.txt`.

```sh
npm ci
npm run data:pull
npm run dev
```

Ovanstående hämtar den versionslåsta riktiga datareleasen från GitHub, verifierar SHA-256 och startar appen. Ingen API-nyckel behövs. För en uttrycklig **syntetisk demo** kan du i stället köra `npm run data:demo`; gör inte det ovanpå ett riktigt dataset. För att kompilera egen GTFS:

```sh
python scripts/build_data.py --gtfs .data-build/source/sl.zip \
  --walks data/walking-index.json --scope data/feed-scope.json
npm run dev
```

Nyckeln `TRAFIKLAB_GTFS_KEY` finns som Actions-hemlighet och behövs inte i webbläsaren. Det manuella dataflödet kan bygga riktiga paket och lämna ett dist-artefakt utan deployment; se driftinstruktionerna.

I Codex-miljön, om standardcachen är skrivskyddad: `npm ci --cache /workspace/.npm-cache`.

```sh
npm test
npm run test:python
npm run build
npm run test:e2e
```

Webbläsartester skapar egna demofixturer i `.data-build/browser-public` och använder port 5174; de skriver inte över riktiga appdata. De använder `/usr/bin/chromium`. Ange `CHROMIUM_PATH` till en annan Chromium-installation. `npx playwright install chromium` installerar Playwrights version; sätt sedan `CHROMIUM_PATH` till dess körbara fil. Testerna kör mobil- och datorvyer; det ersätter inte tester på fysisk iPhone/Android.

`npm run preview` serverar produktionsbygget. Demo genereras uttryckligen och förnyas inte tyst av appen. Bygg/importera om data om dess giltighet gått ut. En riktig importerad feed ska inte skrivas över med demo.

## Funktioner

- Lokal hållplatssökning med svenskt stöd, separat val av namngivet hållplatsläge och startval på kartan.
- Datum idag till idag + 7 i **Europe/Stockholm**, inom datatäckningen. Ogiltiga och tvetydiga tider vid sommartidsbyten avvisas uttryckligen.
- Max restid 10–120 min, gång 5–30 min per sammanhängande sträcka, 0–4 byten, fem trafikslagsfilter, avgångsfönster 5–120 min (standard 30).
- Beräkning i Web Worker, avbrytning genom att terminera processen, separata laddnings-/beräkningsstatusar och isolerade körnings-ID:n.
- Diskreta 10-minutersband från ljusgrönt till mörkrött, anpassade till vald maxtid. Hovra eller fokusera en destination för resväg; klicka/tryck för att fästa den med reselista, linjer, gång, byten samt avgångs-/ankomsttider i Stockholm. Resvägen är schematisk via turens hållplatser, inte exakt väg-/spårgeometri.
- Efter en sökning visas endast hållplatser med en känd resa. **Ny sökning** visar åter alla hållplatser, rensar start/resväg/länk och behåller reseinställningarna. **Visa hela resultatet** passar in de visade hållplatserna och gångområdena.
- Gångsträckor visar meter/kilometer från gångnätet och gångtid, inklusive en totalsumma. Valbara färgade gångområden tar hänsyn till återstående restid och kvarvarande gångbudget. Områdena bygger på lokalt förberäknade OSM/Valhalla-konturer i enminutssteg; de är ungefärliga och saknas där hållplatsen inte har en känd gånganslutning.
- Tangentbordsåtkomliga hållplatsmarkörer och delningslänk i URL-fragmentet.
- Versionsbundna SHA-256-kontrollerade data, binära timblock och frivillig Cache API-lagring med minnesfallback.
- GTFS-import, offlineförberäkning av gångpar från ett konservativt OSM-nät eller en granskad gånggraf och nattlig CI för trafikdata och veckovisa gångkartsbyggen.

## Restidsmodell

`R = gång före första påstigning + sista ankomst − första påstigning + avslutande gång`.

Initial väntan exkluderas; väntan vid byten ingår. Olika mål kan använda olika första avgångar inom fönstret. Sökmotorn sparar alternativa tillstånd för faktisk ankomst, restid, gångbudget och transferkontext. Den beräknar **inte** bara tidigaste ankomst. Samma tur kan följas förbi hållplatser där på-/avstigning inte tillåts. Olika GTFS-turer räknas konservativt som olika fordon; `block_id` är inte bevis för obruten fordonskontinuitet.

En gångsträcka summeras över flera kanter och återställs först vid påstigning. Minsta bytestid räknas från senaste avstigning, parallellt med fysisk gång; 4 min gång och 7 min minsta bytestid kräver 7 minuter, inte 11. Gång till en avslutande SL-hållplats ingår. Saknad gångväg fylls aldrig med fågelvägstider.

## Riktiga data och drift

Se [dataflöde och filformat](docs/data.md), [drift och kvoter](docs/operations.md), [verifiering och öppna datagap](docs/verification.md) och [ursprunglig kravspecifikation](docs/kravspec.md).

Cloudflare Workers Git-integration: bygg `npm run build`, deploy `npx wrangler deploy`. `prebuild` hämtar den verifierade datareleasen när `public/data/manifest.json` saknas. Bara `data/release.json` ligger i Git; det stora arkivet ligger i GitHub Releases. Se [driftinstruktionerna](docs/operations.md). Cloudflare Pages kan också publicera samma `dist`. Kontrollworkflow bygger demo enbart för tester; det publicerar inget. Trafikdata byggs och publiceras automatiskt varje natt 03.17 UTC. Gångkartan byggs om på söndagar, vid saknad gångcache eller på manuell begäran; nattjobben återanvänder den däremellan. Ett manuellt inventeringsläge kan köras med Trafiklab-hemligheten och kvotinitiering; se driftinstruktionerna. Repots synlighet har inte ändrats.

Bakgrundskartan använder Maptoolkit.orgs fria vektorkarta: `https://styles.maptoolkit.org/summer.json`, utan API-nyckel. Maptoolkits logotyp och kartans upphovsrättslänkar visas på alla skärmstorlekar. `.env.example` visar den valfria inställningen `VITE_MAP_STYLE_URL`; värdet `none` stänger av externa kartanrop utan att påverka sökningen. MapLibre och dess worker samt appens typsnitt levereras med appen. Inga hemligheter får ligga i `VITE_`-variabler, delningslänkar eller apppaketet.

Mätning på verklig feed med det partiella gångindexet finns i [benchmark-real-partial-walk.json](docs/benchmark-real-partial-walk.json). Mätning och reproduktion av den inkrementella gångrenderingen finns i [walking-render-performance.md](docs/walking-render-performance.md). Det är containerdata, inte fysisk mobilprestanda. [Datakällor och byggmetod](data/README.md) beskriver gångluckor, licenser och reproduktion. Bakgrundstiles är avsiktligt blockerade i automatiska webbläsartester.

Jämförelse av binära gångprofiler, förberäknade raster och filstorlekar: [experiment och resultat](docs/walking-lab.md), med en [interaktiv prototyp](https://sliso.xr.se/lab/walking/).

Algoritmjämförelse med RAPTOR-liknande sökning, H3, quadtrees och PMTiles: [rapport](docs/algorithm-lab.md) och [interaktiv prototyp](https://sliso.xr.se/lab/algorithms/).

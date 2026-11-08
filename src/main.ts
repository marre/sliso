import {profiling,acceptProfile,profileStart,profileEnd} from './core/profile';
import { mobileLayout } from './layout';
import { aboutHTML } from './about';
import {Marker,Popup,LngLatBounds,type MapMouseEvent} from 'maplibre-gl';
import {createMap,lngLat,boundsOf,size,worldProject,worldUnproject} from './map';
import {MapStops,hitStop,type StopMarker} from './map-stops';
import {loadStopService} from './core/stop-service';
import {MODE_COLORS,transportIcon} from './core/transport';
import {PointDestinations} from './point-destinations';
import { JourneyView } from './journey-view';
import { MapProgress } from './map-progress';
import { WalkingView } from './walking-view';
import { isMapStop, searchStations, stationOrigin } from './core/stops';
import { walkingExitGap } from './core/result-notice';
import '@fontsource-variable/manrope';
import '@fontsource-variable/dm-sans';
import './style.css';
import { cacheAvailable, loadJSON, loadManifest, pruneCache } from './core/data';
import { colorFor, defaults, parseHash, shareHash, validateSettings } from './core/settings';
import { addDays, dateBounds, stockholmNow, validateDate } from './core/time';
import { MODES, MODE_NAMES, type Manifest, type SearchResult, type Settings, type Stop, type Reach, type StationProgress } from './core/types';

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const escape = (s: string): string => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const arrow='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg>';
$('#app').innerHTML = `
<header class="topbar"><a class="brand" href="/" aria-label="sliso startsida"><span class="brand-icon">s<span>${arrow}</span></span>sliso<span class="brand-dot">.</span></a><span class="tagline">Stockholm, inom räckhåll.</span><button class="text-button" id="about-open">Om kartan <span aria-hidden="true">${arrow}</span></button></header>
<main>
<aside id="search-settings" class="panel" aria-label="Sökinställningar"><div class="mobile-panel-header"><strong>Sökinställningar</strong><button id="mobile-close-search" type="button">Visa kartan ↓</button></div>
<div class="eyebrow"><span class="live-dot"></span> UTFORSKA MED SL</div>
<h1>Hur långt<br>når <em>du?</em></h1>
<p class="intro">Välj en plats och se hur långt du når.</p>
<div id="data-banner" class="notice">Laddar hållplatser…</div>
<form id="search-form">
<div class="field"><label for="direction">Jag vill</label><select id="direction"><option value="depart">Resa från en plats</option><option value="arrive">Vara framme en viss tid</option></select></div>
<div class="field search-field"><label for="stop-search"><span class="field-icon" aria-hidden="true">◎</span> <span id="place-label">Var börjar resan?</span></label><input id="stop-search" placeholder="Sök hållplats eller station" autocomplete="off" role="combobox" aria-controls="stop-options" aria-autocomplete="list" aria-expanded="false" disabled><ul id="stop-options" role="listbox" hidden></ul></div>
<p id="start-data-gap" class="notice demo" hidden></p>
<div class="date-row"><div class="field"><label for="date">Datum</label><input id="date" type="date" required></div><div class="field"><label for="time"><span id="time-label">Avresetid</span> <span class="label-note">Stockholm</span></label><input id="time" type="time" required></div></div>
<p class="time-note">Restid utan väntan före första avgången.</p>
<div class="field range-field"><label for="max-time">Max restid <output id="max-output" for="max-time">60 <small>min</small></output></label><input id="max-time" type="range" min="10" max="120" step="1" value="60"><div class="range-ends"><span>10 min</span><span>120 min</span></div></div>
<details id="options"><summary><span aria-hidden="true">☷</span> Fler alternativ <span class="summary-meta">Gång · byten · trafikslag</span></summary><div class="options-body"><div class="field"><label for="walk">Max gång per sträcka</label><select id="walk">${[5,10,15,20,25,30].map(n=>`<option value="${n}" ${n===15?'selected':''}>${n} minuter</option>`).join('')}</select><p class="hint">Sammanhängande gång, även via flera hållplatser. 4,8 km/h.</p></div><div class="date-row"><div class="field"><label for="transfers">Max byten</label><select id="transfers">${[0,1,2,3,4].map(n=>`<option value="${n}" ${n===3?'selected':''}>${n} byten</option>`).join('')}</select></div><div class="field"><label for="window" id="window-label">Avgångsfönster</label><input id="window" type="number" min="5" max="120" value="30" required><p class="hint">5–120 minuter</p></div></div><p class="hint" id="window-note">Första påstigning måste ske inom fönstret från vald tid. Väntan vid byten ingår alltid.</p><fieldset><legend>Trafikslag</legend><div class="mode-grid">${MODES.map(m=>`<label class="mode-chip"><input type="checkbox" name="mode" value="${m}" checked><span class="mode-symbol" style="color:${MODE_COLORS[m]}">${transportIcon(m)}</span><span>${MODE_NAMES[m]}</span></label>`).join('')}</div></fieldset></div></details>
<div id="form-error" class="error" role="alert" hidden></div>
<div class="search-actions"><button id="calculate" class="primary" type="submit" disabled>Visa restidskarta <span aria-hidden="true">${arrow}</span></button><button id="reset-search" class="reset-search" type="button" title="Välj ny startpunkt och behåll restidsinställningarna" disabled>Nollställ</button></div><button type="button" id="cancel" class="cancel" hidden>Avbryt beräkning</button>
<div id="status" role="status" aria-live="polite">Välj en hållplats för att börja.</div><p id="walking-status" class="hint" role="status"></p>
</form><div class="panel-foot"><span aria-hidden="true">◷</span> Planerad trafik · Ingen realtid <button id="data-open" class="text-button">Om datan</button></div>
</aside>
<section class="map-section" aria-label="Restidskarta"><div id="map-progress" class="map-progress" hidden><div role="progressbar" aria-label="Beräkning" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="map-progress-fill"></span></div><span class="map-progress-text"></span></div><div id="map" aria-busy="false" data-search-state="idle"></div><div id="point-status" class="point-status" role="status" hidden></div><div class="map-heading"><span class="map-heading-dot"></span><span id="map-label">STOCKHOLM & OMKRING</span></div><div id="map-demo" class="map-demo" hidden>TESTDATA · Ej för reseplanering</div><button id="mobile-toggle" class="mobile-toggle" aria-controls="search-settings" aria-expanded="true">Dölj sökpanel ↓</button><button id="map-cancel" class="map-cancel" hidden>Avbryt sökning</button><div class="map-actions"><button id="fit" title="Visa hela trafiknätet" aria-label="Visa hela trafiknätet">⌖</button></div><div id="map-empty" class="map-tip"><span aria-hidden="true">◎</span><div><strong>Välj en plats på kartan</strong><span>Eller sök efter en hållplats i sökpanelen.</span></div></div><aside id="journey-panel" class="journey-panel" aria-label="Resedetaljer" aria-labelledby="journey-title" hidden></aside><button id="share" class="share-button" aria-label="Kopiera delningslänk" title="Kopiera delningslänk" disabled><span aria-hidden="true">${arrow}</span> Dela karta</button><div class="map-source" id="source-note">Hållplatser och ungefärliga gångområden</div></section>
</main>
<dialog id="info-dialog" aria-labelledby="dialog-title"><div class="dialog-head"><h2 id="dialog-title"></h2><button id="dialog-close" aria-label="Stäng">×</button></div><div id="dialog-body"></div></dialog>`;

export const map = await createMap('map');
let currentPopup:Popup|undefined,startPin:Marker|undefined;
function closePopup(){currentPopup?.remove();currentPopup=undefined;}
const baseError=()=>{$('#source-note').textContent='Bakgrundskartan kunde inte laddas. Hållplatser och beräkning fungerar ändå.';};
map.on('error',baseError);if(map.getContainer().dataset.basemap==='unavailable')baseError();map.getContainer().addEventListener('basemaperror',baseError);
const markers:(StopMarker|undefined)[]=[],stopLayer=new MapStops(map);
function clearStart(){startPin?.remove();startPin=undefined;}
let pointOrigin:{lat:number;lon:number}|undefined, originClick:ReturnType<typeof setTimeout>|undefined;
let coverageBounds:LngLatBounds|undefined;
let publicStops:Stop[]=[];
let stops: Stop[] = [], manifest: Manifest, selected = -1, worker: Worker | undefined, generation = 0;
let result: SearchResult | undefined, usedSettings: Settings | undefined;
let settings: Settings, runTimer: ReturnType<typeof setTimeout>;
let activeOption = -1;
const journeyView = new JourneyView(map, markers, index => { closePopup(); setStart(index,true); },point=>setPointStart(point));
const pointDestinations=new PointDestinations(map,journeyView,$('#point-status'));
const mapProgress=new MapProgress($('#map-progress'));
let previewValues: (Reach|null)[] = [], previewActive=false;
const walkingView = new WalkingView(map, text=>{const el=document.querySelector('#walking-status');if(el)el.textContent=text;}, ()=>{}, (completed,total,failed)=>{
  if(!total){mapProgress.reset();return;}
  mapProgress.update(`3/3 · Gånglagret i kartvyn: ${completed} av ${total}${failed?` · ${failed} misslyckades`:''}`,completed,total);
});
const modeInputs = () => [...document.querySelectorAll<HTMLInputElement>('input[name=mode]')];
function showError(message: string) { $('#form-error').textContent = message; $('#form-error').hidden = false; if(mobileLayout.matches)setMobileSearch(true); }
function status(message: string) { $('#status').textContent = message; }
function terminate(message?: string) {
  mapProgress.reset();
  generation++; worker?.terminate(); worker = undefined; clearTimeout(runTimer);
  $('#cancel').hidden = true; $('#map-cancel').hidden=true;
  if (message) status(message);
}
function clearResults() {
  pointDestinations.reset();journeyView.reset();walkingView.reset();closePopup();mapProgress.reset();previewValues=[];previewActive=false;
  result = undefined; usedSettings = undefined; $('#map').dataset.searchState='idle';$('#map').setAttribute('aria-busy','false');$('#walking-status').textContent=''; $('#map-empty').hidden = false;
  for (const marker of markers) {
    if(!marker)continue;
    marker.setVisible(true);
    marker.setStyle({ color: '#52766e', fillColor: '#f5f6f0', fillOpacity: .9, weight: 1.5, radius: 5 });
  }
  $('#fit').setAttribute('title','Visa hela trafiknätet');$('#fit').setAttribute('aria-label','Visa hela trafiknätet');
}
function invalidate(message = 'Inställningarna har ändrats. Visa en ny restidskarta.') {
  cancelOriginClick();
  const hadResult = !!result || !!worker;
  terminate(); if(hadResult)clearResults();
  if (hadResult) status(message);
}
function setStart(index: number, recalculate = false) {
  if(!isMapStop(stops[index]))return;
  cancelOriginClick();pointOrigin=undefined;
  invalidate('Ny startpunkt vald. Visa en ny restidskarta.'); selected = index;
  const stop = stops[index];
  $('#stop-search').setAttribute('aria-expanded','false'); $('#stop-options').hidden = true;
  $<HTMLInputElement>('#stop-search').value = stop.station;
  clearStart();
  addPointPin(stop,false,`${$<HTMLSelectElement>('#direction').value==='arrive'?'Mål':'Start'}: ${stop.name} · ${stop.platform}`);
  $('#start-data-gap').textContent=stop.walking==='estimated'?'Vissa gånganslutningar är uppskattade. Se resedetaljer.':'Gånganslutningar saknas från detta läge. Resultatet kan därför missa möjliga resor.';
  $('#start-data-gap').hidden=manifest.demo||stop.walking==='available'||!!stop.walkingArea;
  $('#map-label').textContent = `${$<HTMLSelectElement>('#direction').value==='arrive'?'TILL':'FRÅN'} ${stop.name.toLocaleUpperCase('sv')}`;
  $('#calculate').removeAttribute('disabled'); $('#share').removeAttribute('disabled');$('#reset-search').removeAttribute('disabled');map.panTo(lngLat(stop),{duration:0});
  status(`${$<HTMLSelectElement>('#direction').value==='arrive'?'Mål':'Start'}: ${stop.name}, ${stop.platform}. Redo att beräkna.`);
  if (recalculate) void calculate();
}
function stationChoice(station: string) {
  const index=stationOrigin(stops,station);
  if(index>=0)setStart(index);
}
function readSettings(): Settings {
  if(!pointOrigin&&(selected<0||!isMapStop(stops[selected]))) throw new Error('Välj en hållplats eller en punkt på kartan.');
  const stop=pointOrigin?{id:'@point',name:'Vald kartpunkt',...pointOrigin}:stops[selected];
  return { ...($<HTMLSelectElement>('#direction').value==='arrive'?{direction:'arrive' as const}:{}),...(pointOrigin?{origin:'point' as const}:{}),v:1, stop:stop.id,name:stop.name,lat:stop.lat,lon:stop.lon, date:$<HTMLInputElement>('#date').value,time:$<HTMLInputElement>('#time').value,maxMinutes:Number($<HTMLInputElement>('#max-time').value),walkMinutes:Number($<HTMLSelectElement>('#walk').value),maxTransfers:Number($<HTMLSelectElement>('#transfers').value),windowMinutes:$<HTMLSelectElement>('#direction').value==='arrive'?30:Number($<HTMLInputElement>('#window').value),modes:modeInputs().filter(i=>i.checked).map(i=>i.value as Settings['modes'][number]) };
}
function applySettings(s: Settings) {
  $<HTMLSelectElement>('#direction').value=s.direction??'depart';updateDirection();
  $<HTMLInputElement>('#date').value=s.date;$<HTMLInputElement>('#time').value=s.time;
  $<HTMLInputElement>('#max-time').value=String(s.maxMinutes);$('#max-output').innerHTML=`${s.maxMinutes} <small>min</small>`;
  $<HTMLSelectElement>('#walk').value=String(s.walkMinutes);$<HTMLSelectElement>('#transfers').value=String(s.maxTransfers);$<HTMLInputElement>('#window').value=String(s.windowMinutes);
  modeInputs().forEach(i=>i.checked=s.modes.includes(i.value as Settings['modes'][number]));
}
function updateDirection() {
  const arrive=$<HTMLSelectElement>('#direction').value==='arrive';
  $('h1').innerHTML=arrive?'Varifrån<br>hinner <em>du?</em>':'Hur långt<br>når <em>du?</em>';
  $('.intro').innerHTML=arrive?'Välj ett mål och när du vill vara framme.':'Välj en plats och se hur långt du når.';
  $('#place-label').textContent=arrive?'Vart vill du komma?':'Var börjar resan?';
  $('#time-label').textContent=arrive?'Senast framme':'Avresetid';
  $('.time-note').textContent=arrive?'Visar senaste start. Tidsmarginal vid målet ingår.':'Restid utan väntan före första avgången.';
  $<HTMLInputElement>('#window').disabled=arrive;$('#window').parentElement!.hidden=arrive;$('#window-note').hidden=arrive;
  $('#source-note').textContent=arrive?'Senaste start före ankomstgränsen · gångvägar vid inzoomning':'Hållplatser och ungefärliga gångområden';
  $('#map-label').textContent=pointOrigin?`${arrive?'TILL':'FRÅN'} VALD KARTPUNKT`:selected>=0?`${arrive?'TILL':'FRÅN'} ${stops[selected].name.toLocaleUpperCase('sv')}`:'STOCKHOLM & OMKRING';
  if(startPin)startPin.getElement().title=arrive?'Valt mål':'Vald startpunkt';
}
function renderPreview(p: StationProgress) {
  if(!previewActive)return;
  for(const {stop,value} of p.changes){
    previewValues[stop]=value;
    const marker=markers[stop];if(!marker)continue;
    marker.setVisible(true);
    marker.setStyle({color:'#fff',fillColor:colorFor(value.seconds,settings.maxMinutes),fillOpacity:1,weight:2,radius:7});
  }
  const found=previewValues.filter((value,index)=>value&&isMapStop(stops[index])).length;
  mapProgress.update(`2/3 · Stationer: ${p.completedRounds} av ${p.totalRounds} steg · ${found} funna`,p.completedRounds,p.totalRounds);
  status(`Beräknar · ${found} hållplatslägen hittills. Färger och restider är preliminära tills sökningen är klar.`);
}
function renderResults(r: SearchResult,s: Settings) {
  previewActive=false;previewValues=[];
  const origin=r.origin;
  const journeyStops=origin?[...stops,{id:'@point',name:'Vald kartpunkt',lat:origin.lat,lon:origin.lon,station:'Vald kartpunkt',platform:s.direction==='arrive'?'Mål på kartlagd gångväg':'Start på kartlagd gångväg'}]:stops;
  journeyView.setData(r,s,journeyStops);
  pointDestinations.setData(r,s,manifest,stops);
  if(origin){
    clearStart();addPointPin(origin,true);
    $('#start-data-gap').hidden=false;
    $('#start-data-gap').textContent=`${s.direction==='arrive'?'Gångmål':'Gångstart'} på kartlagd väg${origin.snapMetres>=1?`, ${Math.round(origin.snapMetres)} m från vald punkt`:''}. Gånganslutningen räknas in i restid och gånggräns.`;
  }
  result=r; usedSettings=s;$('#map-empty').hidden=true;
  const exitGap=walkingExitGap(r,s,stops);
  const exitWarning='Ingen kollektivresa hittades. De nådda hållplatslägena saknar koppling till kartans gångnät. Resultatet kan därför missa möjliga resor. Prova en närliggande hållplats eller ett annat avgångsfönster.';
  $('#map').dataset.searchState='complete';$('#map').setAttribute('aria-busy','false');
  walkingView.setData(r,s,manifest,stops);
  r.values.forEach((value,i)=>{
    const marker=markers[i];if(!marker)return;
    marker.setVisible(!!value);
    if(value)marker.setStyle({color:'#fff',fillColor:colorFor(value.seconds,s.maxMinutes),fillOpacity:1,weight:2,radius:7});
  });
  const count=r.values.filter((value,i)=>value&&i!==selected&&isMapStop(stops[i])).length;
  status(exitGap ? exitWarning : count ? `Färdigt. ${count} hållplatslägen ${s.direction==='arrive'?'kan nå målet om du startar högst':'nås på högst'} ${s.maxMinutes} minuter${s.direction==='arrive'?' före din ankomsttid':''}. Beräkning: ${Math.round(r.elapsed)} ms.` : 'Inga andra hållplatslägen nås inom gränserna. Det kan saknas gånganslutningar i underlaget.');
  if (mobileLayout.matches) setMobileSearch(exitGap);
  $('#fit').setAttribute('title','Visa hela resultatet');$('#fit').setAttribute('aria-label','Visa hela resultatet');
}

async function calculate() {
  cancelOriginClick();
  $('#form-error').hidden=true;
  try {
    settings=readSettings();validateSettings(settings,manifest.walkingMaxMinutes);validateDate(settings.date,manifest.validFrom,manifest.validTo);
    terminate();clearResults();const id=generation;
    $('#cancel').hidden=false;$('#map-cancel').hidden=false;
    if(mobileLayout.matches)setMobileSearch(false);
    $('#map').dataset.searchState='loading';$('#map').setAttribute('aria-busy','true');$('#map-empty').hidden=true;previewActive=true;previewValues=stops.map(()=>null);
    markers.forEach((marker,i)=>marker?.setVisible(i===selected));
    mapProgress.update('1/3 · Laddar och verifierar data',0,1);
    status('Laddar tidtabell och gånganslutningar…');
    worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>{
      if(data.id!==generation)return;
      acceptProfile(data.profileEvents);
      if(data.type==='status')status(data.message);
      if(data.type==='progress')mapProgress.update(`1/3 · Data: ${data.completed} av ${data.total} filer`,data.bytesCompleted,data.bytesTotal);
      if(data.type==='access-progress'){mapProgress.update(`1/3 · Gångnät nära startpunkten: ${data.completed} av ${data.total} delar`,data.completed,data.total);status('Söker gångvägar från kartpunkten till närliggande hållplatser…');}
      if(data.type==='stations'){const start=profileStart();renderPreview(data);profileEnd('main.stationBatch',start);}
      if(data.type==='error'){terminate();clearResults();status('Sökningen slutfördes inte. Hållplatsernas nåbarhet är okänd.');showError(data.message);}
      if(data.type==='result'){const start=profileStart(),s=settings;terminate();renderResults(data.result,s);profileEnd('main.results',start);}
    };
    worker.onerror=()=>{terminate();clearResults();showError('Beräkningsprocessen kunde inte köras. Försök igen.');status('Ofärdigt resultat. Nåbarheten är okänd.');};
    worker.postMessage({id,manifest,settings,profiling:profiling()});
    runTimer=setTimeout(()=>{if(worker)status('Beräkningen pågår fortfarande. Kartan kan flyttas och sökningen kan avbrytas.');},10000);
  }catch(e){showError((e as Error).message);}
}
function popup(index: number) {
  const stop=stops[index],value=result?.values[index]??previewValues[index];
  const box=document.createElement('div');box.className='stop-popup';
  const title=document.createElement('h3');title.textContent=stop.name;box.append(title);
  const platform=document.createElement('p');platform.textContent=stop.platform;box.append(platform);
  const detail=document.createElement('p');
  detail.textContent = previewActive ? value ? `Preliminärt ${Math.ceil(value.seconds/60)} min · Beräkningen pågår` : 'Beräkningen pågår. Nåbarheten är ännu okänd.' : result ? value ? `${Math.ceil(value.seconds/60)} min · ${value.kind==='walk'?'Gång':`${Math.max(0,value.boardings-1)} byten`}${value.requestStop?' · Stopp på signal – meddela föraren':''} · Färdig beräkning` : (!manifest.demo&&!manifest.walkingCoverage?.reviewed?'Ingen känd resa. Gångunderlaget är ofullständigt, så nåbarheten är osäker.':'Ej nåbar inom valda gränser i tillgänglig data.') : 'Restid okänd – ingen färdig beräkning.';
  box.append(detail);
  if(value){const note=document.createElement('small');note.textContent=usedSettings?.direction==='arrive'?'Tid före ankomstgränsen, inklusive marginal vid målet.':'Utan initial väntan. Restiden gäller detta hållplatsläge.';box.append(note);}
  const button=document.createElement('button');button.textContent=$<HTMLSelectElement>('#direction').value==='arrive'?'Res hit ↗':'Res härifrån ↗';button.className='popup-start';button.onclick=()=>{closePopup();setStart(index,true);};box.append(button);
  closePopup();currentPopup=new Popup().setLngLat(lngLat(stop)).setDOMContent(box).addTo(map);
}

function cancelOriginClick(){clearTimeout(originClick);}
function addPointPin(point:{lat:number;lon:number},mapped=false,title?:string){
  const el=document.createElement('div');el.className='start-pin';el.innerHTML='<span>◎</span>';
  el.title=title??(mapped?'Start på kartlagd gångväg':'Vald startpunkt · gångvägen kontrolleras vid sökning');
  startPin=new Marker({element:el,anchor:'bottom'}).setLngLat(lngLat(point)).addTo(map);
}

function setPointStart(point:{lat:number;lon:number},recalculate=true){
  if(!manifest.footpaths){showError('Gångnät för kartstart saknas i denna dataversion.');return;}
  cancelOriginClick();invalidate('Ny kartpunkt vald. Visa en ny restidskarta.');selected=-1;
  pointOrigin={lat:Math.round(point.lat*1e7)/1e7,lon:Math.round(point.lon*1e7)/1e7};
  $('#stop-options').hidden=true;$('#stop-search').setAttribute('aria-expanded','false');
  $<HTMLInputElement>('#stop-search').value='Vald kartpunkt';
  $('#start-data-gap').hidden=false;$('#start-data-gap').textContent='Gång från närmaste kartlagda väg ingår i restiden.';
  clearStart();addPointPin(pointOrigin);$('#calculate').removeAttribute('disabled');$('#share').removeAttribute('disabled');$('#reset-search').removeAttribute('disabled');
  updateDirection();$('#form-error').hidden=true;status('Kartpunkt vald. Redo att beräkna gångvägar och resor.');
  if(recalculate)void calculate();
}
// Delay selection until a double-click has had a chance to zoom instead.
map.on('click',(event:MapMouseEvent)=>{
  cancelOriginClick();
  if(event.originalEvent?.detail>1||pointDestinations.consumesOriginClick())return;
  const target=(event.originalEvent?.target as Element|null)?.closest?.('[data-stop-index]');
  const index=target?Number(target.getAttribute('data-stop-index')):hitStop(map,event.point);
  if(!manifest||(index===undefined&&!manifest.footpaths))return;
  originClick=setTimeout(()=>{
    if(result){
      closePopup();pointDestinations.pause();
      if(index!==undefined){if(result.values[index])journeyView.pin(index);else{journeyView.close();popup(index);}}
      else pointDestinations.inspect(event.lngLat);
      return;
    }
    if(index!==undefined&&isMapStop(stops[index]))setStart(index,true);
    else setPointStart({lat:event.lngLat.lat,lon:event.lngLat.lng});
  },450);
});
// Result journeys are selected deliberately; crossing the map never replaces the card.
map.on('mouseleave','stops',()=>journeyView.leave());
map.on('contextmenu','stops',event=>{const index=Number(event.features?.[0]?.properties.index);if(result?.values[index]){closePopup();journeyView.pin(index);}});
for(const type of ['dblclick','movestart','contextmenu'] as const)map.on(type,cancelOriginClick);
const keyboardStop=(event:Event)=>{
 const element=(event.target as Element|null)?.closest<HTMLElement>('.map-stop[data-stop-index]');
 return element?Number(element.dataset.stopIndex):undefined;
};
map.getCanvasContainer().addEventListener('focusin',event=>{const index=keyboardStop(event);if(index!==undefined){pointDestinations.pause();journeyView.hover(index);}});
map.getCanvasContainer().addEventListener('focusout',event=>{if(keyboardStop(event)!==undefined)journeyView.leave();});
map.getCanvasContainer().addEventListener('keydown',event=>{
 const index=keyboardStop(event);if(index===undefined||!['Enter',' '].includes(event.key))return;
 event.preventDefault();pointDestinations.pause();
 if(result?.values[index]){closePopup();journeyView.pin(index,true);}
 else{journeyView.close();if(!result&&!previewActive)setStart(index,true);else popup(index);}
});
map.getContainer().addEventListener('keydown',event=>{
  if(event.key==='Escape')cancelOriginClick();
  if(event.key==='Enter'&&event.target===map.getContainer()&&manifest?.footpaths){const p=map.getCenter();setPointStart({lat:p.lat,lon:p.lng});}
});

$('#search-form').addEventListener('submit',e=>{e.preventDefault();void calculate();});
$('#cancel').onclick=()=>{terminate();clearResults();status('Avbruten. Hållplatsernas nåbarhet är okänd tills en ny sökning är färdig.');if(mobileLayout.matches)setMobileSearch(true);};
$('#map-cancel').onclick=()=>$('#cancel').click();
$('#max-time').addEventListener('input',()=>{$('#max-output').innerHTML=`${$<HTMLInputElement>('#max-time').value} <small>min</small>`;invalidate();});

$('#search-form').addEventListener('input',e=>{const target=e.target as HTMLInputElement;if(['date','time','window'].includes(target.id))invalidate();});
$('#search-form').addEventListener('change',e=>{const target=e.target as HTMLInputElement;if(['date','time','walk','transfers','window','direction'].includes(target.id)||target.name==='mode'){invalidate();if(target.id==='direction'){updateDirection();if(selected>=0||pointOrigin)void calculate();}if(target.id==='window'&&(selected>=0||pointOrigin)&&$<HTMLInputElement>('#window').checkValidity())void calculate();}});
$('#stop-search').addEventListener('input',()=>{
  cancelOriginClick();pointOrigin=undefined;invalidate();selected=-1;clearStart();$('#calculate').setAttribute('disabled','');$('#share').setAttribute('disabled','');$('#start-data-gap').hidden=true;
  const query=$<HTMLInputElement>('#stop-search').value.trim().toLocaleLowerCase('sv');
  const names=searchStations(stops,query);
  const list=$('#stop-options');list.replaceChildren();activeOption=-1;
  if(query)for(const [i,n] of names.entries()){
    const li=document.createElement('li');li.role='option';li.id=`stop-option-${i}`;li.setAttribute('aria-selected','false');
    const b=document.createElement('button');b.type='button';b.textContent=n;b.tabIndex=-1;b.onclick=()=>{stationChoice(n);list.hidden=true;$('#stop-search').setAttribute('aria-expanded','false');};li.append(b);list.append(li);
  }
  if(query&&!names.length){const li=document.createElement('li');li.textContent='Inga hållplatser matchar din sökning.';list.append(li);}
  list.hidden=!query;$('#stop-search').setAttribute('aria-expanded',String(!!query));
});
$('#stop-search').addEventListener('keydown',e=>{
  const choices=[...document.querySelectorAll<HTMLElement>('#stop-options [role=option]')];
  if(e.key==='Escape'){$('#stop-options').hidden=true;$('#stop-search').setAttribute('aria-expanded','false');return;}
  if(['ArrowDown','ArrowUp'].includes(e.key)&&choices.length){e.preventDefault();activeOption=(activeOption+(e.key==='ArrowDown'?1:-1)+choices.length)%choices.length;choices.forEach((li,i)=>li.setAttribute('aria-selected',String(i===activeOption)));$('#stop-search').setAttribute('aria-activedescendant',choices[activeOption].id);}
  if(e.key==='Enter'&&choices.length&&!$('#stop-options').hidden){e.preventDefault();choices[Math.max(activeOption,0)].querySelector('button')!.click();}
});
function mapFitPadding() {
  const bottom=40;
  // A short landscape map must still have space left after reserving controls.
  const scale=Math.min(1,Math.max(0,size(map).y-80)/(130+bottom));
  return {padding:{top:130*scale,left:30,right:30,bottom:bottom*scale}};
}
function updateMapMinZoom() {
  if(!coverageBounds)return;
  map.setMaxBounds(null);map.setMinZoom(0);
  const camera=map.cameraForBounds(coverageBounds,{...mapFitPadding(),maxZoom:19});
  const zoom=Math.max(0,camera?.zoom??0);map.setMinZoom(zoom);
  // Expand the regional rectangle to the viewport aspect ratio so maxBounds
  // does not crop network edges when fitting a narrow/landscape screen.
  const center=worldProject(camera?.center??coverageBounds.getCenter(),zoom),viewport=size(map);
  const a=worldUnproject({x:center.x-viewport.x/2,y:center.y-viewport.y/2},zoom),b=worldUnproject({x:center.x+viewport.x/2,y:center.y+viewport.y/2},zoom);
  const limits=new LngLatBounds().extend(a).extend(b);limits.extend(coverageBounds.getSouthWest()).extend(coverageBounds.getNorthEast());
  map.setMaxBounds(limits);

}
function constrainMapToStops() {
  const extent=boundsOf(publicStops.map(stop=>[stop.lat,stop.lon]));
  // At least ~2.8 km accommodates the supported 30-minute walking areas and
  // gives even single-stop datasets a non-degenerate navigable extent.
  const lat=Math.max((extent.getNorth()-extent.getSouth())*.04,.025);
  const lon=Math.max((extent.getEast()-extent.getWest())*.04,.025/Math.max(.1,Math.cos(extent.getCenter().lat*Math.PI/180)));
  coverageBounds=new LngLatBounds([extent.getWest()-lon,extent.getSouth()-lat],[extent.getEast()+lon,extent.getNorth()+lat]);
  map.setMaxBounds(coverageBounds);updateMapMinZoom();
  map.on('resize',updateMapMinZoom);
}
function fitCurrentStops() {
  const visible=stops.filter((stop,i)=>isMapStop(stop)&&(previewActive?previewValues[i]:!result||(result.values[i]&&result.values[i]!.seconds<=usedSettings!.maxMinutes*60)));if(!visible.length)return;
  map.resize();updateMapMinZoom();
  const bounds=boundsOf(visible.map(s=>[s.lat,s.lon]));if(pointOrigin)bounds.extend(lngLat(pointOrigin));const walkingBounds=walkingView.bounds();if(walkingBounds)bounds.extend(walkingBounds.getSouthWest()).extend(walkingBounds.getNorthEast());
  map.fitBounds(bounds,{duration:0,maxZoom:13,...mapFitPadding()});
}
$('#fit').onclick=fitCurrentStops;
function resetSearch() {
  cancelOriginClick();pointOrigin=undefined;terminate();clearResults();selected=-1;clearStart();
  $<HTMLInputElement>('#stop-search').value='';$('#stop-search').setAttribute('aria-expanded','false');$('#stop-search').removeAttribute('aria-activedescendant');
  $('#stop-options').replaceChildren();$('#stop-options').hidden=true;activeOption=-1;
  $('#start-data-gap').hidden=true;$('#form-error').hidden=true;$('#reset-search').setAttribute('disabled','');
  $('#calculate').setAttribute('disabled','');$('#share').setAttribute('disabled','');$('#map-label').textContent='VÄLJ EN NY STARTPUNKT';
  history.replaceState(null,'',location.pathname+location.search);
  document.body.classList.remove('panel-collapsed');updateMobile();
  status('Välj en ny startpunkt på kartan eller i sökfältet. Dina restidsinställningar är kvar.');
  if(matchMedia('(pointer: fine)').matches)$('#stop-search').focus();
}
$('#reset-search').onclick=resetSearch;
$('#share').onclick=async()=>{
  try{const s=readSettings();validateSettings(s,manifest.walkingMaxMinutes);validateDate(s.date,manifest.validFrom,manifest.validTo);const hash=shareHash(s);history.replaceState(null,'',hash);await navigator.clipboard.writeText(location.origin+location.pathname+hash);status('Länken är kopierad. Den delar startplats och inställningar, inte ett sparat resultat.');}
  catch(e){showError(`Kunde inte kopiera länken: ${(e as Error).message} Om länken syns i adressfältet kan du kopiera den därifrån.`);}
};
function updateMobile(){
  const collapsed=document.body.classList.contains('panel-collapsed');
  $('#mobile-toggle').textContent=collapsed?(pointOrigin?'Kartpunkt · Ändra':selected>=0?stops[selected].name+' · Ändra':'Sök hållplats'):'Visa kartan';
  $('#mobile-toggle').setAttribute('aria-expanded',String(!collapsed));
  setTimeout(()=>map.resize(),0);
}
function setMobileSearch(open:boolean){
  if(open){journeyView.close();closePopup();}
  document.body.classList.toggle('panel-collapsed',!open);updateMobile();
}
$('#mobile-toggle').onclick=()=>setMobileSearch(document.body.classList.contains('panel-collapsed'));
$('#mobile-close-search').onclick=()=>setMobileSearch(false);
$('#journey-panel').addEventListener('journeyopen',()=>{
  if(mobileLayout.matches){setMobileSearch(false);}
});
mobileLayout.addEventListener('change',()=>updateMobile());
function dialog(title:string,html:string){$('#dialog-title').textContent=title;$('#dialog-body').innerHTML=html;$<HTMLDialogElement>('#info-dialog').showModal();}
$('#dialog-close').onclick=()=>$<HTMLDialogElement>('#info-dialog').close();
$('#about-open').onclick=()=>dialog('Så fungerar sliso',aboutHTML);
$('#data-open').onclick=()=>{if(manifest)dialog('Data & begränsningar',`<p><strong>${manifest.demo?'Syntetisk testdata – ej reseplanering':'Planerad SL-trafik'}</strong></p><p>Uppdaterad: ${escape(manifest.sourceUpdated||manifest.updated.slice(0,10))}<br>Giltighet: ${manifest.validFrom} – ${manifest.validTo}<br>Gång: ${manifest.walkingMaxMinutes} minuter, ${manifest.walkingSpeedKmh} km/h<br>Gångversion: ${escape(manifest.walkingVersion)}${manifest.walkingCoverage?`<br>Gångkopplade lägen: ${manifest.walkingCoverage.boundStops} / ${manifest.walkingCoverage.totalStops}<br>Förberäknade gångpar: ${manifest.walkingCoverage.pairs}`:''}</p><ul>${manifest.warnings.map(w=>`<li>${escape(w)}</li>`).join('')}</ul><p>${manifest.attribution.map(escape).join('<br>')}</p><p>Bakgrundskarta: Maptoolkit.org och OpenStreetMap. Ingen analys eller central sökhistorik. Publicerade stationsbyten kan använda minsta bytestid som uppskattad gångtid; då saknas uppmätt avstånd. Gång mellan hållplatser med samma namn inom 250 meter och granskade stationspassager kan ha uppskattad tid och längd; sådana sträckor märks i resedetaljerna.</p>`);};
async function restoreLink() {
  invalidate('Delningsinställningar laddas.');
  $('#form-error').hidden=true;
  const s=parseHash(location.hash);if(!s)return;
  applySettings(s);
  if(s.origin==='point'){setPointStart(s,false);map.jumpTo({center:lngLat(s),zoom:15});validateSettings(s,manifest.walkingMaxMinutes);validateDate(s.date,manifest.validFrom,manifest.validTo);await calculate();return;}
  const index=stops.findIndex(stop=>stop.id===s.stop);
  if(index<0||!isMapStop(stops[index])){invalidate();selected=-1;$('#calculate').setAttribute('disabled','');$('#share').setAttribute('disabled','');clearStart();$<HTMLInputElement>('#stop-search').value=s.name;$('#start-data-gap').hidden=true;throw new Error(`Hållplatsläget ”${s.name}” (${s.stop}) ${index<0?'finns inte längre':'har utgått'}. Sök och välj ett aktivt läge; startpunkten har inte flyttats.`);}
  setStart(index);map.jumpTo({center:lngLat(stops[index]),zoom:12});
  validateSettings(s,manifest.walkingMaxMinutes);validateDate(s.date,manifest.validFrom,manifest.validTo);
  await calculate();
}
async function init(){
  try{
    manifest=await loadManifest();stops=await loadJSON<Stop[]>(manifest.stops);
    await loadStopService(stops,manifest);
    if(!stops.length)throw new Error('Hållplatsdata är tom.');
    publicStops=stops.filter(isMapStop);
    if(!publicStops.length)throw new Error('Inga aktuella hållplatslägen finns i detta dataset.');
    constrainMapToStops();
    settings=defaults(publicStops[0]);applySettings(settings);
    const [min,max]=dateBounds(manifest.validFrom,manifest.validTo);$<HTMLInputElement>('#date').min=min;$<HTMLInputElement>('#date').max=max;
    $<HTMLSelectElement>('#walk').querySelectorAll('option').forEach(o=>{if(Number(o.value)>manifest.walkingMaxMinutes)o.remove();});
    const banner=$('#data-banner');
    banner.classList.toggle('demo',manifest.demo);$('#map-demo').hidden=!manifest.demo;
    banner.textContent=manifest.demo?'TESTLÄGE · Syntetiska avgångar och gångtider. Ej för reseplanering.':`Tidtabell uppdaterad ${manifest.sourceUpdated||manifest.updated.slice(0,10)} · Giltig t.o.m. ${manifest.validTo}`;
    if(!manifest.demo&&(manifest.sourceUpdated||manifest.updated.slice(0,10))<addDays(stockholmNow().date,-2))banner.textContent+=' · Äldre data: uppdateringen kan ha misslyckats.';
    if(manifest.warnings.length&&!manifest.demo)banner.textContent+=' · Databegränsningar finns, se Om datan.';
    if(!manifest.demo&&!manifest.walkingCoverage?.reviewed){banner.classList.add('demo');banner.textContent=`UTVECKLINGSLÄGE · Tidtabell ${manifest.sourceUpdated||manifest.updated.slice(0,10)}. Ofullständigt gångunderlag kan underskatta nåbarheten.`;$('#map-demo').hidden=false;$('#map-demo').textContent='UTVECKLING · Gångdata ofullständiga';}
    markers.length=stops.length;
    stops.forEach((s,i)=>{if(isMapStop(s))markers[i]=stopLayer.add(s,i);});
    $('#stop-search').removeAttribute('disabled');
    if(!await cacheAvailable()){const p=document.createElement('p');p.className='hint';p.textContent='Lokal lagring är inte tillgänglig. Data hämtas på nytt vid behov.';banner.after(p);}
    void pruneCache(manifest);
    await restoreLink();
  }catch(e){showError((e as Error).message);status(stops.length?'Kontrollera inställningarna.':'Data kunde inte laddas. Ladda om sidan för att försöka igen.');if(!stops.length)$('#data-banner').textContent='Kontrollera datatillgång och nätverk.';}
}
window.addEventListener('hashchange',()=>{void restoreLink().catch(e=>showError(e.message));});
void init();

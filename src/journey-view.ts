import {routeColor,routeTextColor,transportIcon} from './core/transport';
import {isMapStop} from './core/stops';
import { mobileLayout } from './layout';
import type {Map,GeoJSONSource} from 'maplibre-gl';
import type {FeatureCollection,Feature} from 'geojson';
import {boundsOf,lngLat,size} from './map';
import type {StopMarker} from './map-stops';
import { journeyFor, journeyTime } from './core/journey';
import { distanceText } from './core/walking';
import { colorFor } from './core/settings';
import { MODE_NAMES, type PointJourney, type JourneyLeg, type SearchResult, type Settings, type Stop } from './core/types';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const minutes = (seconds: number) => `${Math.ceil(seconds / 60)} min`;

export class JourneyView {
  private routeData:FeatureCollection={type:'FeatureCollection',features:[]};
  private result?: SearchResult;
  private settings?: Settings;
  private stops: Stop[] = [];
  private active: number | null = null;
  private pinned: number | null = null;
  private cutoff=Infinity;
  private pointer?:{x:number;y:number};
  private approaching=false;
  private point?:PointJourney;
  get isPinned(){return this.pinned!==null;}
  private timer?: ReturnType<typeof setTimeout>;
  private panel = document.querySelector<HTMLElement>('#journey-panel')!;

  constructor(private map: Map, private markers: (StopMarker|undefined)[], private onStart: (index: number) => void, private onPointStart?: (point:{lat:number;lon:number})=>void) {
    map.addSource('journey',{type:'geojson',data:this.routeData});
    map.addLayer({id:'journey-halo',type:'line',source:'journey',filter:['==',['geometry-type'],'LineString'],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#fff','line-width':9,'line-opacity':.95}});
    for(const kind of ['transit','walk'])map.addLayer({id:'journey-'+kind,type:'line',source:'journey',filter:['all',['==',['geometry-type'],'LineString'],['==',['get','kind'],kind]],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['get','color'],'line-width':4,...(kind==='walk'?{'line-dasharray':[1.25,1.75]}:{})}});
    map.addLayer({id:'journey-stops',type:'circle',source:'journey',filter:['==',['geometry-type'],'Point'],paint:{'circle-radius':['get','radius'],'circle-color':['get','fill'],'circle-stroke-color':['get','color'],'circle-stroke-width':['get','weight']}});
    this.panel.addEventListener('mouseenter', () => {clearTimeout(this.timer);this.panel.dispatchEvent(new Event('journeyinteract'));});
    this.panel.addEventListener('mouseleave', () => this.leave());
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this.panel.hidden && !document.querySelector('dialog[open]')) {
        this.close(); this.map.getContainer().focus();
      }
    });
  }

  setData(result: SearchResult, settings: Settings, stops: Stop[]) {
    this.reset(); this.cutoff=settings.maxMinutes; this.result = result; this.settings = settings; this.stops = stops;
  }

  setCutoff(minutes:number) {
    this.cutoff=minutes;
    if(this.active!==null&&(this.point?.value.seconds??this.result?.values[this.active]?.seconds??Infinity)>minutes*60)this.close();
  }

  reset() { this.close(); this.result = undefined; this.settings = undefined; }

  close() {
    clearTimeout(this.timer); this.pinned = null; this.hide();this.panel.dispatchEvent(new Event('journeyclose'));
  }

  /** Keep the preview stable while the pointer travels towards its controls. */
  protectsPreview(event:MouseEvent) {
    const next={x:event.clientX,y:event.clientY},previous=this.pointer;
    if(previous?.x===next.x&&previous.y===next.y)return this.approaching;
    this.pointer=next;
    const rect=this.panel.getBoundingClientRect();
    const distance=(p:{x:number;y:number})=>Math.hypot(Math.max(rect.left-p.x,0,p.x-rect.right),Math.max(rect.top-p.y,0,p.y-rect.bottom));
    this.approaching=!this.panel.hidden&&!!previous&&distance(next)<distance(previous);
    if(this.approaching)clearTimeout(this.timer);
    return this.approaching;
  }

  hover(index: number) {
    clearTimeout(this.timer);
    if (this.pinned === null && !this.panel.matches(':hover')) this.show(index);
  }

  /** Capture the visible endpoint before the delayed click can change previews. */
  endpointSelection(at:{x:number;y:number}):(()=>void)|undefined {
    if(this.active===null||this.panel.hidden)return;
    const index=this.active,point=this.point,destination=point?.destination??this.stops[index];
    if(!destination)return;
    const pixel=this.map.project(lngLat(destination));
    if(Math.hypot(pixel.x-at.x,pixel.y-at.y)>12)return;
    return ()=>{if(point)this.showPoint(point,true);else this.pin(index);};
  }

  pin(index: number, focus = false) {
    clearTimeout(this.timer); this.pinned = index; this.show(index);
    if (focus && !this.panel.hidden) this.panel.querySelector<HTMLButtonElement>('#journey-expand')!.focus({ preventScroll: true });
  }

  showPoint(point:PointJourney,pin=false){
    clearTimeout(this.timer);
    if(!pin&&(this.pinned!==null||this.panel.matches(':hover')))return;
    if(pin)this.pinned=this.stops.length;
    this.show(this.stops.length,point);
  }

  leave() {
    clearTimeout(this.timer);
    if (this.pinned === null && !this.approaching) this.timer = setTimeout(() => this.hide(), 700);
  }

  private hide() {
    if (this.active !== null && this.result && this.settings) {
      const value = this.result.values[this.active];
      if (value) this.markers[this.active]?.setStyle({ color: '#fff', fillColor: colorFor(value.seconds, this.settings.maxMinutes), weight: 2, radius: 7 });
    }
    this.active = null; this.approaching=false; this.point=undefined; this.routeData.features=[];(this.map.getSource('journey') as GeoJSONSource).setData(this.routeData); this.panel.hidden = true; this.panel.classList.remove('journey-expanded');
    this.panel.closest('.map-section')!.classList.remove('journey-open');
  }

  private show(index: number, point:PointJourney|undefined=index===this.stops.length?this.point:undefined) {
    const stops=point?[...this.stops,{id:'@destination',name:this.settings?.direction==='arrive'?'Vald startpunkt':'Vald målpunkt',station:'Vald kartpunkt',platform:`${this.settings?.direction==='arrive'?'Start':'Slutgång'} på kartlagd väg${point.destination.snapMetres>=1?` · ${Math.round(point.destination.snapMetres)} m från vald punkt`:''}`,lat:point.destination.lat,lon:point.destination.lon}]:this.stops;
    const result = this.result, settings = this.settings, value = point?.value??result?.values[index];
    if (!result || !settings || !value || !isMapStop(stops[index]) || value.seconds>this.cutoff*60) { this.hide(); return; }
    if (!point && this.active === index && !this.panel.hidden) {
      const button = this.panel.querySelector<HTMLButtonElement>('#journey-pin')!;
      button.textContent = this.pinned === index ? 'Fäst ✓' : 'Fäst resan';
      button.setAttribute('aria-pressed', String(this.pinned === index)); return;
    }
    this.hide(); this.active = index;this.point=point;
    const legs = point?.legs??journeyFor(result,index,stops), destination = stops[index];
    const position = (i:number):[number,number]=>[stops[i].lat,stops[i].lon];
    const features:Feature[]=[];
    for(const leg of legs){
      const coords=(leg.path??leg.stops.map(position)).map(lngLat),color=leg.kind==='walk'?'#55645f':routeColor(result.routes[leg.route!]);
      if(coords.length>=2)features.push({type:'Feature',geometry:{type:'LineString',coordinates:coords},properties:{kind:leg.kind,color}});
      for(const stop of leg.stops.filter(i=>isMapStop(stops[i])))features.push({type:'Feature',geometry:{type:'Point',coordinates:lngLat(position(stop))},properties:{radius:3,color,fill:'#fff',weight:1.5}});
    }
    this.markers[index]?.setStyle({radius:10,weight:3,color:'#183e36'});
    features.push({type:'Feature',geometry:{type:'Point',coordinates:lngLat(position(index))},properties:{radius:10,color:'#183e36',fill:colorFor(value.seconds,settings.maxMinutes),weight:3}});
    this.routeData={type:'FeatureCollection',features};(this.map.getSource('journey') as GeoJSONSource).setData(this.routeData);
    const walkingGap = !point && value.seconds > 0 && destination.walking === 'missing' && !destination.walkingArea;
    const time = (epoch: number) => `<time datetime="${new Date(epoch * 1000).toISOString()}">${journeyTime(epoch, settings.date)}</time>`;
    const stopRow = (at: number, epoch: number) => `<div class="journey-stop">${time(epoch)}<div><strong>${escape(stops[at].name)}</strong></div></div>`;
    const rows = legs.map((leg, i) => {
      const route = leg.kind === 'transit' ? result.routes[leg.route!] : undefined;
      const color = route ? routeColor(route) : '#55645f';
      const previous = legs[i - 1], wait = previous ? leg.departure - previous.arrival : 0;
      return `${wait > 0 ? `<li class="journey-wait">Väntan vid byte · ${minutes(wait)}</li>` : ''}<li class="journey-leg" style="--leg-color:${color}"><span class="journey-step" style="color:${route?routeTextColor(route):'#ffffff'}" aria-label="Steg ${i+1}">${transportIcon(route?.mode??'walk')}</span><div class="journey-leg-head"><div><strong>${route ? escape(MODE_NAMES[route.mode]) + ' · ' + escape(route.name) : leg.estimated ? 'Gång · uppskattad' : 'Gång'}</strong><span>${minutes(leg.arrival - leg.departure)}${leg.kind === 'walk' ? ' · '+distanceText(leg.metres) : ''}</span></div></div>${stopRow(leg.from, leg.departure)}${stopRow(leg.to, leg.arrival)}${[leg.from,leg.to].some(at=>stops[at].platform)?`<details class="journey-platforms"><summary>Hållplatslägen</summary>${[...new Set([leg.from,leg.to])].filter(at=>stops[at].platform).map(at=>`<p><strong>${escape(stops[at].name)}</strong> · ${escape(stops[at].platform)}</p>`).join('')}</details>`:''}${leg.requestStop ? '<p class="journey-request">Stopp på signal – meddela föraren.</p>' : ''}</li>`;
    }).join('');
    const margin=result.reverseEpoch===undefined||!legs.length?0:Math.max(0,result.reverseEpoch/2-legs.at(-1)!.arrival);
    const walks=legs.filter(l=>l.kind==='walk'),walkingSeconds=walks.reduce((sum,l)=>sum+l.arrival-l.departure,0);
    const walkingMetres=walks.every(l=>l.metres!==undefined)?walks.reduce((sum,l)=>sum+l.metres!,0):undefined;
    const overview = legs.map(leg => {
      const route = leg.kind === 'transit' ? result.routes[leg.route!] : undefined;
      return `<span class="journey-chip" aria-label="${route ? escape(MODE_NAMES[route.mode]) : 'Gång'}">${transportIcon(route?.mode ?? 'walk')} ${route ? escape(route.name) : minutes(leg.arrival-leg.departure)}</span>`;
    }).join('<span class="journey-arrow" aria-hidden="true">›</span>');
    this.panel.innerHTML = `<div class="journey-header"><div>${settings.direction==='arrive'?'<span class="eyebrow">FRÅN</span>':''}<h2 id="journey-title">${escape(destination.name)}</h2>${legs.length?`<p class="journey-times journey-arrival"><span>Avgång ${time(legs[0].departure)}</span><span>Ankomst ${time(legs.at(-1)!.arrival)}</span></p>`:''}<div class="journey-overview">${overview}</div>${walks.some(l=>l.estimated)?'<p class="journey-request">Uppskattad gång ingår</p>':''}${walkingGap?'<p class="journey-request">Gångväg saknas här. En kortare resa kan finnas.</p>':''}<button id="journey-expand" class="journey-expand" aria-expanded="false" aria-controls="journey-content"><strong>${minutes(value.seconds)}</strong> · ${value.kind==='walk'?'Gång':`${Math.max(0,value.boardings-1)} ${value.boardings===2?'byte':'byten'}`} <span>Visa detaljer</span></button></div><button id="journey-close" aria-label="Stäng resedetaljer">×</button></div><div id="journey-content" class="journey-scroll">${legs.length ? `${margin?`<p class="journey-margin">Marginal till ankomstgränsen: ${minutes(margin)}</p>`:''}${walks.length?`<p class="journey-walking">Gång totalt: ${minutes(walkingSeconds)} · ${distanceText(walkingMetres)}</p>`:''}<ol class="journey-legs">${rows}</ol>` : '<p>Du är redan vid starthållplatsen.</p>'}<details class="journey-explanation"><summary>Om tider och gångvägar</summary><p class="journey-note">${escape(destination.platform)}</p><p class="journey-note">Planerade tider i Stockholmstid. ${settings.direction==='arrive'?'Färgen visar tid från senaste start till din ankomstgräns, inklusive marginal vid målet.':'Initial väntan räknas inte; väntan vid byten ingår.'}</p><p class="journey-note">${point?(settings.direction==='arrive'?'Första gångvägen från kartpunkten följer kartlagda vägar. ':'Sista gångvägen till målpunkt följer kartlagda vägar. ')+(settings.origin==='point'?(settings.direction==='arrive'?'Även gången till målpunkten följer kartlagda vägar. ':'Även gången från startpunkten följer kartlagda vägar. '):'')+'Övrig resväg är schematisk via hållplatserna.':settings.origin==='point'?(settings.direction==='arrive'?'Gången till målpunkten följer kartlagda vägar. Övrig resväg är schematisk via hållplatserna.':'Gången från kartpunkten följer kartlagda vägar. Övrig resväg är schematisk via hållplatserna.'):'Schematisk resväg via hållplatserna. Linjerna visar inte exakt spår- eller gånggeometri.'} Streckad linje betyder gång.</p></details><div class="journey-actions"><button id="journey-pin" aria-pressed="${this.pinned === index}">${this.pinned === index ? 'Fäst ✓' : 'Fäst resan'}</button><button id="journey-fit" ${legs.length ? '' : 'disabled'}>Visa hela resvägen</button><button id="journey-start">${settings.direction==='arrive'?'Res hit':'Res härifrån'}</button></div></div>`;
    this.panel.hidden = false; this.panel.closest('.map-section')!.classList.add('journey-open');
    this.panel.dispatchEvent(new Event('journeyopen'));
    this.panel.querySelector<HTMLButtonElement>('#journey-expand')!.onclick=()=>{
      const open=this.panel.classList.toggle('journey-expanded');
      if(open){this.pinned=index;this.panel.querySelector('#journey-pin')!.setAttribute('aria-pressed','true');this.panel.querySelector('#journey-pin')!.textContent='Fäst ✓';this.panel.dispatchEvent(new Event('journeyinteract'));}
      const button=this.panel.querySelector<HTMLButtonElement>('#journey-expand')!;
      button.setAttribute('aria-expanded',String(open));
      button.querySelector('span')!.textContent=open?'Dölj detaljer':'Visa detaljer';
    };
    this.panel.querySelector<HTMLButtonElement>('#journey-close')!.onclick = () => { this.close(); this.map.getContainer().focus(); };
    this.panel.querySelector<HTMLButtonElement>('#journey-pin')!.onclick = () => { this.pinned = this.pinned === index ? null : index; this.show(index); };
    this.panel.querySelector<HTMLButtonElement>('#journey-start')!.onclick = () => {if(point)this.onPointStart?.(point.destination);else this.onStart(index);};
    this.panel.querySelector<HTMLButtonElement>('#journey-fit')!.onclick = () => this.fit(legs);
  }

  private fit(legs: JourneyLeg[]) {
    const coords = legs.flatMap(leg => leg.path??leg.stops.map(i => [this.stops[i].lat, this.stops[i].lon] as [number,number]));
    if (!coords.length) return;
    const mobile = mobileLayout.matches;
    // Mobile search-panel collapse changes the map size before its delayed resize.
    this.map.resize();
    this.map.fitBounds(boundsOf(coords),{duration:0,maxZoom:14,padding:{top:110,left:24,right:mobile?24:Math.min(size(this.map).x*.45,this.panel.offsetWidth+100),bottom:mobile?this.panel.offsetHeight+65:65}});
  }
}

import {LngLatBounds,type Map} from 'maplibre-gl';
import {BandCanvas} from './band-canvas';
import type {Manifest,SearchResult,Settings,Stop} from './core/types';

/** The published contours describe walking FROM a stop. Reverse searches use
 * mapped incoming paths instead; outgoing polygons cannot prove access TO it.
 * Bound the viewport's working set on phones. Wide views keep the stop map. */
export class ReverseWalkingView {
 private overview?:HTMLButtonElement;
 private worker?:Worker;private image?:BandCanvas;private timer?:ReturnType<typeof setTimeout>;private generation=0;
 private data?:{result:SearchResult;settings:Settings;manifest:Manifest;stops:Stop[]};
 constructor(private map:Map,private status:(text:string)=>void,private progress?:(done:number,total:number,failed:number)=>void){}
 private move=()=>{clearTimeout(this.timer);this.worker?.postMessage({type:'cancel'});this.generation++;this.image?.remove();this.image=undefined;this.timer=setTimeout(()=>this.draw(),180);};
 setData(result:SearchResult,settings:Settings,manifest:Manifest,stops:Stop[]){
  this.data={result,settings,manifest,stops};this.map.on('movestart',this.move);this.map.on('moveend',this.move);this.map.on('resize',this.move);this.draw();
 }
 reset(){this.overview?.remove();this.overview=undefined;this.generation++;clearTimeout(this.timer);this.worker?.terminate();this.worker=undefined;this.image?.remove();this.image=undefined;this.map.off('movestart',this.move);this.map.off('moveend',this.move);this.map.off('resize',this.move);}
 private draw(){
  if(!this.data||this.map.isMoving())return;
  this.overview?.remove();this.overview=undefined;
  const {result,settings,manifest,stops}=this.data;
  const bounds=this.map.getBounds(),margin=(settings.walkMinutes*80+100)/111195,longitude=margin/Math.cos(this.map.getCenter().lat*Math.PI/180);
  const refs=Object.entries(manifest.footpaths?.index??{}).filter(([key])=>{
   const [y,x]=key.split('_').map(Number),d=manifest.footpaths!.tileDegrees;
   return (y+1)*d>=bounds.getSouth()-margin&&y*d<=bounds.getNorth()+margin&&(x+1)*d>=bounds.getWest()-longitude&&x*d<=bounds.getEast()+longitude;
  }).map(([,ref])=>ref);
  if(!manifest.footpaths||!refs.length){this.progress?.(0,0,0);this.status('Inkommande gångvägar saknas i detta dataset.');return;}
  if(refs.length>96||refs.reduce((n,r)=>n+r.bytes,0)>8_000_000){
   this.progress?.(0,0,0);this.status('Zooma in för att se gångvägar mot målet. Hållplatsernas resultat är färdiga.');
   const button=this.overview=document.createElement('button');
   button.className='arrival-walking-zoom';button.type='button';
   button.textContent='Visa gångvägar · zooma in';
   button.title='Hållplatser visas i översikten. Zooma in för kartlagda gångvägar.';
   button.onclick=()=>this.map.easeTo({zoom:Math.max(14,this.map.getZoom()+1)});
   this.map.getContainer().parentElement!.append(button);return;
  }
  if(!this.worker){
   this.worker=new Worker(new URL('./reverse-walking-worker.ts',import.meta.url),{type:'module'});
   this.worker.postMessage({type:'configure',stops,sources:result.destinationSources??result.walkSources,anchor:result.origin?.anchor,settings});
   this.worker.onmessage=({data})=>{
    if(data.id!==this.generation)return;
    if(data.type==='progress'){this.progress?.(data.done,data.total,0);this.status(`Gångvägar mot målet: ${data.done} av ${data.total} steg`);}
    if(data.type==='image'){
     this.image??=new BandCanvas(this.map,new LngLatBounds(data.bounds),manifest.waterMask);
     this.image.image(data.width,data.height,new Uint8ClampedArray(data.pixels),settings.maxMinutes);
     this.status(data.done?'Gångvägar mot målet · kartlagda vägar med ungefärlig visningsbredd.':'Gångvägar mot målet uppdateras…');
    }
    if(data.type==='error'){this.progress?.(1,1,1);this.status('Gångvägar mot målet kunde inte laddas. Flytta kartan för att försöka igen.');}
   };
   this.worker.onerror=()=>{this.status('Gångvägar mot målet kunde inte beräknas.');this.progress?.(1,1,1);this.worker?.terminate();this.worker=undefined;};
  }
  this.worker.postMessage({type:'draw',id:++this.generation,refs,bounds:[bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()],width:Math.max(1,Math.min(1200,this.map.getContainer().clientWidth)),height:Math.max(1,Math.min(1200,this.map.getContainer().clientHeight))});
 }
}

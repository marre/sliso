import type {Map,MapMouseEvent,LngLat} from 'maplibre-gl';
import {hitStop} from './map-stops';
import type {JourneyView} from './journey-view';
import type {Manifest,SearchResult,Settings,Stop} from './core/types';

/** One persistent worker per search; destination changes invalidate stale previews. */
export class PointDestinations {
 private timer?:ReturnType<typeof setTimeout>;private arrive=false;private worker?:Worker;private id=0;private cutoff=0;private inspected=false;private pinPending=false;private holdTimer?:ReturnType<typeof setTimeout>;
 constructor(private map:Map,private view:JourneyView,private status:HTMLElement){
  document.querySelector('#journey-panel')!.addEventListener('journeyclose',()=>this.cancel());

  document.querySelector('#journey-panel')!.addEventListener('journeyinteract',()=>this.cancel());
  map.on('mousemove',e=>this.move(e));
  const container=map.getContainer();let down:{x:number;y:number}|undefined;
  const cancelHold=()=>{clearTimeout(this.holdTimer);down=undefined;};
  container.addEventListener('pointerdown',e=>{
   this.inspected=false;cancelHold();
   if(!e.isPrimary||(e.pointerType!=='touch'&&e.pointerType!=='pen')||(e.target as Element)?.closest?.('.maplibregl-ctrl'))return;
   down={x:e.clientX,y:e.clientY};const target=e.target;
   this.holdTimer=setTimeout(()=>{
    if(target instanceof Element)target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:e.clientX,clientY:e.clientY,button:2}));
   },600);
  },true);
  // Consume a hold's compatibility clicks before MapLibre can interpret them
  // as a second tap and start an unwanted zoom animation.
  const consumeInspectionClick=(e:MouseEvent)=>{if(this.inspected){e.preventDefault();e.stopImmediatePropagation();}};
  container.addEventListener('click',consumeInspectionClick,true);container.addEventListener('dblclick',consumeInspectionClick,true);
  container.addEventListener('pointermove',e=>{if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)>8)cancelHold();},true);
  container.addEventListener('pointerup',cancelHold,true);container.addEventListener('pointercancel',cancelHold,true);
  map.on('contextmenu',e=>{
   cancelHold();e.originalEvent?.preventDefault();
   if(this.inspected)return;
   this.inspected=true;this.cancel();
   if(this.available()&&!this.onStop(e))this.query(e.lngLat,true);
  });
  map.on('dblclick',()=>this.cancel());
  map.on('movestart',()=>{cancelHold();this.cancel();this.view.leave();});
  map.on('mouseout',e=>{const target=(e.originalEvent as MouseEvent)?.relatedTarget;if(target instanceof Node&&map.getContainer().contains(target))return;this.cancel();this.view.leave();});
 }
 private available(){return !!this.worker;}
 private onStop(e:MapMouseEvent){return !!(e.originalEvent?.target as Element|null)?.closest?.('.map-stop')||hitStop(this.map,e.point)!==undefined;}
 private move(e:MapMouseEvent){
  if(this.view.protectsPreview(e.originalEvent)){
   this.cancel();
   // Pause updates during the journey to the card, but resume if the pointer
   // settles on the map instead. Entering the card cancels this pending work.
   if(!this.view.isPinned&&matchMedia('(hover: hover)').matches){
    this.timer=setTimeout(()=>{const index=hitStop(this.map,e.point);if(index!==undefined)this.view.hover(index);else this.query(e.lngLat,false);},500);
   }
   return;
  }
  if(this.pinPending||!this.available()||this.view.isPinned||!matchMedia('(hover: hover)').matches)return;
  if(this.onStop(e)){this.cancel();return;}
  this.cancel();this.view.leave();
  this.timer=setTimeout(()=>this.query(e.lngLat,false),220);
 }
 inspect(point:LngLat){this.query(point,true);}
 private query(point:LngLat,pin:boolean){
  this.cancel();if(!this.available())return;
  if(pin)this.view.close();
  this.pinPending=pin;
  const id=++this.id;
  this.status.textContent=this.arrive?'Beräknar första gångvägen…':'Beräknar sista gångvägen…';this.status.hidden=false;
  this.worker!.onmessage=({data})=>{
   if(data.id!==this.id||!this.available())return;
   this.pinPending=false;
   if(data.journey){this.status.hidden=true;this.view.showPoint(data.journey,pin);}
   else {this.view.leave();this.status.textContent=pin?data.message:'Ingen känd gångresa till punkten inom valda gränser.';this.status.hidden=false;}
  };
  this.worker!.postMessage({type:'query',id,lat:point.lat,lon:point.lng,cutoff:this.cutoff});
 }
 private cancel(){clearTimeout(this.timer);this.pinPending=false;this.id++;this.worker?.postMessage({type:'cancel'});this.status.hidden=true;}
 setData(result:SearchResult,settings:Settings,manifest:Manifest,stops:Stop[]){
  this.reset();this.arrive=settings.direction==='arrive';this.cutoff=settings.maxMinutes;
  if(!manifest.footpaths||!result.destinationSources)return;
  this.worker=new Worker(new URL('./destination-worker.ts',import.meta.url),{type:'module'});
  this.worker.onerror=()=>{this.pinPending=false;this.status.textContent='Gångvägen till punkten kunde inte beräknas. Sök igen för att försöka på nytt.';this.status.hidden=false;this.worker?.terminate();this.worker=undefined;};
  this.worker.postMessage({type:'configure',context:{manifest,settings,stops,result:{...result,values:[],routes:[],walkSources:[]}}});
 }
 consumesOriginClick(){return this.inspected;}
 pause(){this.cancel();}
 setCutoff(minutes:number){this.cutoff=minutes;this.cancel();}
 reset(){clearTimeout(this.holdTimer);this.inspected=false;this.cancel();this.worker?.terminate();this.worker=undefined;}
}

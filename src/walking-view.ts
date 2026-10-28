import {BandCanvas} from './band-canvas';
import {ReverseWalkingView} from './reverse-walking-view';
import {profiling,profileStart,profileEnd,acceptProfile,type ProfileEvent} from './core/profile';
import {LngLatBounds,type Map as GLMap} from 'maplibre-gl';
import {padBounds,containsBounds,worldProject,worldUnproject,distance,lngLat} from './map';
import {useContourOverview} from './core/contour-view';
import { walkingMinutes } from './core/walking';
import { bandLimits, type RasterGrid } from './core/bands';
import type { Manifest, SearchResult, Settings, Stop } from './core/types';


export class WalkingView {
  enabled = true;
  private reverse?:ReverseWalkingView;
  private controller?: AbortController;
  private data?: {result:SearchResult;settings:Settings;manifest:Manifest;stops:Stop[]};
  private merger?:Worker;
  private image?:BandCanvas;
  private overviewNote?:HTMLElement;
  private workerVersion='';
  private workerCutoffs=new Set<number>();
  private profiles = new Set<number>();
  private cutoff = 0;
  private schedule?:()=>void;
  private timer?:ReturnType<typeof setTimeout>;

  constructor(private map:GLMap,private status:(text:string)=>void,private ready:()=>void,private progress?:(completed:number,total:number,failed:number)=>void) {

  }
  private removeLayers(){this.image?.remove();this.image=undefined;}
  private clear() {
    this.reverse?.reset();this.reverse=undefined;
    this.controller?.abort();this.merger?.terminate();this.merger=undefined;clearTimeout(this.timer);this.timer=undefined;
    this.profiles.clear();this.removeLayers();this.overviewNote?.remove();this.overviewNote=undefined;this.workerVersion='';this.workerCutoffs.clear();this.schedule=undefined;
  }
  reset(){this.clear();this.profiles.clear();this.data=undefined;}
  bounds(){return this.image?.coverage;}
  setData(result:SearchResult,settings:Settings,manifest:Manifest,stops:Stop[]){
    this.reset();this.data={result,settings,manifest,stops};this.cutoff=settings.maxMinutes;this.draw();
  }
  toggle(enabled:boolean){this.enabled=enabled;this.clear();this.draw();}
  setCutoff(minutes:number){
    if(!this.data)return;
    this.cutoff=Math.max(1,Math.min(this.data.settings.maxMinutes,Math.floor(minutes)));
    if(Number(this.image?.canvas.dataset.cutoff)!==this.cutoff)this.schedule?.();
  }

  private draw(){
    if(!this.data||!this.enabled){this.progress?.(0,0,0);this.status('Gångområden är dolda.');return;}
    const {result,settings,manifest,stops}=this.data,areas=manifest.walkingAreas;
    if(settings.direction==='arrive'){
      this.reverse=new ReverseWalkingView(this.map,this.status,this.progress);
      this.reverse.setData(result,settings,manifest,stops);return;
    }
    if(!areas){this.status('Gångområden saknas i detta dataset.');return;}
    const preparation=profileStart();
    const available=walkingMinutes(result.walkSources,settings.maxMinutes*60,settings.walkMinutes*60);
    const positions=new Map<number,number[]>(),fullDeliveries=new Map<number,number>();
    for(const index of available.keys()){
      const id=stops[index].id,file=areas.index[id],source=areas.sources?.[id]??file;
      if(file!==undefined){
        positions.set(source,[...(positions.get(source)??[]),index]);fullDeliveries.set(source,file);
      }
    }
    if(!positions.size){this.status('Inga gångområden finns för de nådda lägena. Gångtäckningen är ofullständig.');return;}
    const selection=()=>{
      const bounds=this.map.getBounds(),d=(settings.walkMinutes*80+50)/111320;
      const lon=d/Math.max(.1,Math.cos(this.map.getCenter().lat*Math.PI/180));
      const expanded=new LngLatBounds([bounds.getWest()-lon,bounds.getSouth()-d],[bounds.getEast()+lon,bounds.getNorth()+d]);
      return new Set([...positions.keys()].filter(source=>positions.get(source)!.some(i=>expanded.contains(lngLat(stops[i])))));
    };
    const needsOverview=(selected:Set<number>)=>{
      const files=new Set([...selected].map(source=>fullDeliveries.get(source)!));
      return !!areas.overview&&useContourOverview(this.map.getZoom()+1,files.size,[...files].reduce((n,file)=>n+areas.files[file].bytes,0));
    };
    const overview=needsOverview(selection()),delivery=overview?areas.overview!:areas;
    if(overview){
      this.overviewNote=document.createElement('div');this.overviewNote.className='walking-overview-note';
      this.overviewNote.textContent='Översikt · zooma in för detaljer';this.overviewNote.setAttribute('aria-hidden','true');
      this.map.getContainer().append(this.overviewNote);
    }
    // Selection follows original logical groups even when their neighbours share a bundle.
    const deliveries=new Map<number,number>(),deliveryPositions=new Map<number,number[]>();
    for(const [source,indices] of positions)for(const index of indices){
      const file=delivery.index[stops[index].id];
      if(file===undefined||deliveries.has(source)&&deliveries.get(source)!==file)throw new Error('Invalid contour source mapping');
      deliveries.set(source,file);deliveryPositions.set(file,[...(deliveryPositions.get(file)??[]),index]);
    }
    profileEnd('main.prepare',preparation);
    const controller=this.controller=new AbortController();
    const merger=this.merger=new Worker(new URL('./bands-worker.ts',import.meta.url),{type:'module'});
    merger.postMessage({type:'profile',enabled:profiling()});
    const requests=new Map<number,AbortController>(),failed=new Set<number>();
    let selected=new Set<number>();
    let wanted=new Set<number>(),queue:number[]=[],profileVersion=0,view=0,busy=false,pending=false,mergeError=false;
    let generation=0,nextToken=0;
    const loading=new Map<number,{resolve:()=>void;reject:()=>void}>();
    const load=(file:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
      const token=nextToken++;
      const abort=()=>{loading.delete(token);merger.postMessage({type:'abort',token});reject(new Error('Aborted'));};
      loading.set(token,{resolve:()=>{signal.removeEventListener('abort',abort);resolve()},reject:()=>{signal.removeEventListener('abort',abort);reject(new Error('Contour load failed'))}});
      signal.addEventListener('abort',abort,{once:true});
      merger.postMessage({type:'load',token,file,ref:delivery.files[file],format:delivery.format});
    });
    let clip=padBounds(this.map.getBounds(),.25),clipZoom=this.map.getZoom();
    const budgets=new Map<number,Map<number,number>>();
    const standard=bandLimits(settings.maxMinutes);
    const budget=(minutes:number)=>{
      if(!budgets.has(minutes))budgets.set(minutes,walkingMinutes(result.walkSources,minutes*60,settings.walkMinutes*60));
      const partials=[...budgets.keys()].filter(n=>!standard.includes(n)&&n!==minutes);
      for(const n of partials.slice(0,Math.max(0,partials.length-3)))budgets.delete(n);
      return budgets.get(minutes)!;
    };
    const progress=()=>{
      if(controller.signal.aborted)return;
      const done=[...wanted].filter(file=>this.profiles.has(file)||failed.has(file)).length;
      this.progress?.(done,wanted.size+((busy||pending)&&!mergeError?1:0),failed.size+(mergeError?1:0));
      if(done<wanted.size)this.status(`${overview?'Översikt · ':''}Laddar och visar gångområden: ${done} av ${wanted.size} (${Math.floor(done/wanted.size*100)} %) i kartvyn${failed.size?` · ${failed.size} kunde inte laddas`:''}…`);
      else if(mergeError)this.status('Gångområden kunde inte sammanfogas. Hållplatsernas restider visas fortfarande. Sök igen för att försöka på nytt.');
      else if(!wanted.size)this.status('Inga gångområden i denna kartvy. Flytta kartan till nådda hållplatser.');
      else if(busy||pending)this.status(overview?'Sammanfogar översikt över gångområden…':'Sammanfogar restidsband i kartvyn…');
      else {
        this.status(failed.size?`Gångområden visas delvis · ${failed.size} underlag kunde inte laddas. Sök igen för att försöka på nytt.`:overview?'Översiktliga gångområden · avrundade gångtider i femminuterssteg. Zooma in för fullständig detalj. Täckningen är ofullständig.':'Ungefärliga gångområden · ofullständig täckning. En färgad yta garanterar inte tillträde överallt.');
        this.ready();
      }
    };
    const send=()=>{
      clearTimeout(this.timer);this.timer=undefined;
      if(controller.signal.aborted||busy||!pending)return;
      const started=profileStart();
      pending=false;busy=true;
      const version=`${view}:${profileVersion}`,known=this.workerVersion===version;
      const partial=this.cutoff%10!==0&&this.cutoff!==settings.maxMinutes;
      const limits=known?(partial&&!this.workerCutoffs.has(this.cutoff)?[this.cutoff]:[]):[...new Set([...standard,this.cutoff])].sort((a,b)=>a-b);
      const bands=limits.map(minutes=>({minutes,allowances:[...budget(minutes)].flatMap(([index,allowance])=>{
        const id=stops[index].id,file=delivery.index[id];return selected.has(areas.sources?.[id]??areas.index[id])&&wanted.has(file)&&this.profiles.has(file)?[[id,allowance] as [string,number]]:[];
      })}));
      // Profile deliveries may arrive during an animated zoom, before zoomend
      // advances the viewport generation. Keep its raster grid at its own zoom.
      const nw=worldProject(clip.getNorthWest(),clipZoom),se=worldProject(clip.getSouthEast(),clipZoom),w=se.x-nw.x,h=se.y-nw.y;
      const scale=Math.min(1,Math.sqrt(1_000_000/(w*h)),2048/Math.max(w,h));
      const grid:RasterGrid={width:Math.max(1,Math.ceil(w*scale)),height:Math.max(1,Math.ceil(h*scale)),bounds:[clip.getWest(),clip.getSouth(),clip.getEast(),clip.getNorth()]};
      profileEnd('main.budgets',started,{files:this.profiles.size,wanted:wanted.size});
      const post=profileStart();
      merger.postMessage({type:'render',version,view,generation,cutoff:this.cutoff,maxMinutes:settings.maxMinutes,bands,grid,overview});profileEnd('main.post',post);progress();
    };
    this.schedule=()=>{
      pending=true;
      if(!this.timer&&!busy)this.timer=setTimeout(send,60);
    };
    merger.onmessage=({data}:{data:{profileEvents?:ProfileEvent[];type?:string;token?:number;version:string;view:number;generation:number;cutoff:number;width:number;height:number;pixels?:Uint8ClampedArray;extent?:number[];cachedCutoffs?:number[];error?:boolean}})=>{
      if(controller.signal.aborted)return;
      acceptProfile(data.profileEvents);
      if(data.type==='loaded'){const task=loading.get(data.token!);loading.delete(data.token!);if(task)(data.error?task.reject:task.resolve)();return;}
      busy=false;
      if(data.view===view&&data.generation===generation){
        if(data.error){mergeError=true;this.workerVersion='';this.workerCutoffs.clear();generation++;}
        else if(data.pixels){
          mergeError=false;
          if(this.workerVersion!==data.version)this.workerCutoffs.clear();
          this.workerVersion=data.version;this.workerCutoffs=new Set(data.cachedCutoffs??[]);
          if(data.cutoff===this.cutoff&&(data.extent||this.image)){
            if(!this.image){
              this.image=new BandCanvas(this.map,clip,manifest.waterMask);
              this.image.canvas.dataset.layer=overview?'overview':'detail';
              this.image.canvas.setAttribute('role','img');
              this.image.canvas.setAttribute('aria-label',overview?'Översiktliga gångområden. Zooma in för fullständig detalj.':'Gångområden med detaljerade restidsband.');
            }
            const start=profileStart();
            this.image.image(data.width,data.height,data.pixels,data.cutoff);profileEnd('main.canvas',start,{pixels:data.width*data.height});
            if(data.extent){
              const nw=worldProject(clip.getNorthWest(),clipZoom),se=worldProject(clip.getSouthEast(),clipZoom);
              const point=(x:number,y:number)=>worldUnproject({x:nw.x+(se.x-nw.x)*x/data.width,y:nw.y+(se.y-nw.y)*y/data.height},clipZoom);
              this.image.coverage=new LngLatBounds().extend(point(data.extent[0],data.extent[1])).extend(point(data.extent[2],data.extent[3]));
            }else this.image.coverage=undefined;
          }
        }
      }
      if(pending)send();progress();
    };
    merger.onerror=()=>{for(const task of loading.values())task.reject();loading.clear();if(controller.signal.aborted)return;busy=false;pending=false;mergeError=true;for(const file of wanted)failed.add(file);queue=[];for(const request of requests.values())request.abort();progress();};
    const pump=()=>{
      if(mergeError)return;
      while(requests.size<6&&queue.length){
        const file=queue.shift()!;
        if(this.profiles.has(file)||requests.has(file)||!wanted.has(file))continue;
        const request=new AbortController();requests.set(file,request);
        const abort=()=>request.abort();controller.signal.addEventListener('abort',abort,{once:true});
        void(async()=>{
          try{
            await load(file,request.signal);
            if(request.signal.aborted)return;
            this.profiles.add(file);profileVersion++;failed.delete(file);this.schedule?.();
          }catch{if(!request.signal.aborted)failed.add(file);}
          finally{
            controller.signal.removeEventListener('abort',abort);requests.delete(file);
            if(controller.signal.aborted)return;
            if(request.signal.aborted&&wanted.has(file)&&!queue.includes(file))queue.push(file);
            progress();
            // Keep bounded fetching independent of display refreshes (also in background tabs).
            if(!controller.signal.aborted)pump();
          }
        })();
      }
    };
    const updateView=()=>{
      if(controller.signal.aborted)return;
      const start=profileStart();
      const bounds=this.map.getBounds(),nextSelected=selection();
      if(needsOverview(nextSelected)!==overview){this.clear();this.draw();return;}
      const previous=wanted,previousSelected=selected;
      selected=nextSelected;wanted=new Set([...selected].map(source=>deliveries.get(source)!));
      for(const [file,request] of requests)if(!wanted.has(file))request.abort();
      merger.postMessage({type:'retain',files:[...wanted]});
      // Decoded profiles live only in the worker; verified files remain on disk.
      for(const file of this.profiles.keys())if(!wanted.has(file))this.profiles.delete(file);
      for(const file of failed)if(!wanted.has(file))failed.delete(file);
      const moved=!containsBounds(clip,bounds)||clipZoom!==this.map.getZoom(),changed=previousSelected.size!==selected.size||[...selected].some(source=>!previousSelected.has(source))||previous.size!==wanted.size||[...wanted].some(file=>!previous.has(file));
      if(moved){clip=padBounds(bounds,.25);clipZoom=this.map.getZoom();view++;this.removeLayers();}
      if(moved||changed){generation++;}
      if(changed)profileVersion++;
      queue=[...wanted].filter(file=>!this.profiles.has(file)&&!requests.has(file)).sort((a,b)=>{
        const score=(file:number)=>Math.min(...deliveryPositions.get(file)!.map(i=>distance(this.map.getCenter(),lngLat(stops[i]))));
        return score(a)-score(b);
      });
      profileEnd('main.viewport',start,{wanted:wanted.size,moved,changed});
      if(moved||changed)this.schedule?.();progress();pump();
    };
    for(const type of ['moveend','zoomend','resize'] as const)this.map.on(type,updateView);
    controller.signal.addEventListener('abort',()=>{for(const type of ['moveend','zoomend','resize'] as const)this.map.off(type,updateView);for(const request of requests.values())request.abort();},{once:true});
    updateView();
  }
}

import {configureProfile,profileStart,profileEnd,drainProfile} from './core/profile';
import {BandRaster,rasterBands,paintBands,type AreaBand,type RasterGrid} from './core/bands';
import {deliveryProfiles,legacyProfiles,type Profiles} from './core/contours';
import {verified} from './core/data';
import {rasterDirectWalking} from './core/direct-walking';
import type {DirectWalkingCoverage,FileRef} from './core/types';
let version='',generation=-1,raster:BandRaster|undefined,directRaster:Uint16Array|undefined;
const partials=new Map<number,Uint8Array>(),files=new Map<number,Profiles>(),byStop=new Map<string,Profiles[string]>(),loads=new Map<number,{file:number;controller:AbortController}>();
let wanted=new Set<number>();
interface Job {type:'render';version:string;view:number;generation:number;cutoff:number;maxMinutes:number;overview?:boolean;bands:{minutes:number;allowances:[string,number][]}[];grid:RasterGrid;direct?:DirectWalkingCoverage}
type Command={type:'profile';enabled:boolean}|Job|{type:'retain';files:number[]}|{type:'abort';token:number}|{type:'load';token:number;file:number;ref:FileRef;format?:string};
self.onmessage=({data}:MessageEvent<Command>)=>{
 if(data.type==='profile'){configureProfile(data.enabled,'walking-worker');return}
 if(data.type==='render'){render(data);return}
 if(data.type==='abort'){loads.get(data.token)?.controller.abort();return}
 if(data.type==='retain'){
  const start=profileStart();
  wanted=new Set(data.files);
  for(const load of loads.values())if(!wanted.has(load.file))load.controller.abort();
  for(const file of files.keys())if(!wanted.has(file))files.delete(file);
  byStop.clear();for(const profiles of files.values())for(const [id,entries] of Object.entries(profiles))byStop.set(id,entries);
  profileEnd('worker.retain',start,{files:files.size});return;
 }
 const controller=new AbortController();loads.set(data.token,{file:data.file,controller});
 void(async()=>{
  const start=profileStart();
  try{
   const bytes=await verified(data.ref,controller.signal);
   if(controller.signal.aborted||!wanted.has(data.file))throw new Error('Aborted');
   const profiles=data.format==='sliso-contours-v1'?await deliveryProfiles(bytes):data.format===undefined?legacyProfiles(bytes):(()=>{throw new Error('Unsupported contours')})();
   if(controller.signal.aborted||!wanted.has(data.file))throw new Error('Aborted');
   files.set(data.file,profiles);for(const [id,entries] of Object.entries(profiles))byStop.set(id,entries);
   profileEnd('worker.load',start,{file:data.file,bytes:bytes.byteLength});
   self.postMessage({type:'loaded',token:data.token,profileEvents:drainProfile()});
  }catch{self.postMessage({type:'loaded',token:data.token,error:true,profileEvents:drainProfile()})}
  finally{loads.delete(data.token)}
 })();
};
function render(data:Job){
 const started=profileStart();let stage=profileStart();
 try{
  if(generation!==data.generation){
   partials.clear();raster=new BandRaster(data.grid);directRaster=data.direct?rasterDirectWalking(data.direct,data.grid):undefined;generation=data.generation;version='';
  }
  const bands:AreaBand[]=data.bands.map(b=>({minutes:b.minutes,geometries:b.allowances.flatMap(([id,minutes])=>{
   const contours=byStop.get(id);
   const contour=data.overview?contours?.reduce<NonNullable<typeof contours>[number]|undefined>((best,c)=>c.minutes<=minutes&&(!best||c.minutes>best.minutes)?c:best,undefined):contours?.find(c=>c.minutes===minutes);
   return contour?[contour.geometry]:[];
  })}));
  profileEnd('render.resolve',stage);
  if(version!==data.version){
   stage=profileStart();
   raster!.add(bands.filter(b=>b.minutes%10===0||b.minutes===data.maxMinutes));
   profileEnd('render.standard',stage);
   partials.clear();version=data.version;
  }
  const partial=data.cutoff%10!==0&&data.cutoff!==data.maxMinutes;
  if(partial&&!partials.has(data.cutoff)){
   stage=profileStart();
   partials.set(data.cutoff,rasterBands(bands.filter(b=>b.minutes===data.cutoff),data.grid));
   profileEnd('render.partial',stage);
   while(partials.size>3)partials.delete(partials.keys().next().value!);
  }
  stage=profileStart();
  const pixels=paintBands(raster!.field,data.grid,data.maxMinutes,data.cutoff,partial?partials.get(data.cutoff):undefined,directRaster);
  profileEnd('render.paint',stage);stage=profileStart();
  let x0=data.grid.width,y0=data.grid.height,x1=0,y1=0;
  for(let i=0;i<raster!.field.length;i++)if(pixels[i*4+3]){const x=i%data.grid.width,y=Math.floor(i/data.grid.width);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);}
  profileEnd('render.extent',stage);profileEnd('render.total',started,{generation:data.generation,version:data.version,pixels:data.grid.width*data.grid.height,files:files.size});
  const extent=x1>x0?[x0,y0,x1,y1]:undefined;
  (self as unknown as {postMessage(value:unknown,transfer:Transferable[]):void}).postMessage({profileEvents:drainProfile(),version,view:data.view,generation:data.generation,cutoff:data.cutoff,width:data.grid.width,height:data.grid.height,pixels,extent,cachedCutoffs:[...partials.keys()]},[pixels.buffer]);
 }catch{version='';generation=-1;raster=undefined;directRaster=undefined;partials.clear();self.postMessage({version:data.version,view:data.view,generation:data.generation,error:true});}
};

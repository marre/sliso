import {profileStart,profileEnd,profiling} from './profile';
import type {Polygon,MultiPolygon} from 'geojson';
import {packedRuns,type PackedGeometry} from './contours';
import {colorFor} from './settings';
export type AreaGeometry=Polygon|MultiPolygon;
export type RasterGeometry=AreaGeometry|PackedGeometry;
export interface AreaBand {minutes:number;geometries:RasterGeometry[]}
export type ClipBounds=[number,number,number,number];
export interface RasterGrid {width:number;height:number;bounds:ClipBounds}

export function bandLimits(maxMinutes:number,cutoff=maxMinutes):number[]{
 const limit=Math.min(maxMinutes,Math.max(1,Math.floor(cutoff)));
 return Array.from({length:Math.ceil(limit/10)},(_,i)=>Math.min((i+1)*10,limit));
}
const mercator=(latitude:number)=>Math.log(Math.tan(Math.PI/4+latitude*Math.PI/360));
/** Rasterize the existing contour, without buffering, hulls or invented links.
 * Scanline pairs include all rings, so holes stay empty and overlapping stops
 * union naturally. Sampling is at display-pixel centres, not a new travel model. */
export function contourRuns(geometry:RasterGeometry,grid:RasterGrid):Uint32Array{
 if(geometry.type==='Packed')return packedRuns(geometry,grid);
 const {width,height,bounds:[west,south,east,north]}=grid;
 const top=mercator(north),sx=width/(east-west),sy=height/(top-mercator(south));
 const project=(p:number[])=>[(p[0]-west)*sx,(top-mercator(p[1]))*sy];
 const result:number[]=[];
 type Edge={end:number;x:number;step:number};
 for(const polygon of geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates){
  const buckets=new Map<number,Edge[]>();let first=height,last=0;
  for(const ring of polygon)for(let i=1;i<ring.length;i++){
   let [ax,ay]=project(ring[i-1]),[bx,by]=project(ring[i]);
   if(ay===by)continue;if(ay>by){[ax,bx]=[bx,ax];[ay,by]=[by,ay];}
   const start=Math.max(0,Math.ceil(ay-.5)),end=Math.min(height,Math.ceil(by-.5));
   if(start>=end)continue;
   const step=(bx-ax)/(by-ay),edge={end,x:ax+(start+.5-ay)*step,step};
   const bucket=buckets.get(start)??[];bucket.push(edge);buckets.set(start,bucket);
   first=Math.min(first,start);last=Math.max(last,end);
  }
  let active:Edge[]=[];
  for(let row=first;row<last;row++){
   active=active.filter(edge=>edge.end>row);active.push(...(buckets.get(row)??[]));
   const xs=active.map(edge=>edge.x).sort((a,b)=>a-b);
   for(let i=0;i+1<xs.length;i+=2){
    const start=Math.max(0,Math.ceil(xs[i]-.5)),end=Math.min(width,Math.ceil(xs[i+1]-.5));
    if(end>start)result.push(row*width+start,row*width+end);
   }
   for(const edge of active)edge.x+=edge.step;
  }
 }
 return new Uint32Array(result);
}

/** Add contours once per viewport. New files can only improve arrival times. */
export class BandRaster {
 readonly field:Uint8Array;
 private earliest=new Map<RasterGeometry,number>();
 constructor(readonly grid:RasterGrid){this.field=new Uint8Array(grid.width*grid.height);}
 add(bands:AreaBand[]):Uint8Array{
  const started=profileStart(),measure=profiling();let scanMs=0,fillMs=0,vertices=0,runsCount=0;
  const additions=new Map<RasterGeometry,number>();
  for(const band of bands)for(const geometry of band.geometries){
   const previous=additions.get(geometry)??this.earliest.get(geometry)??Infinity;
   if(band.minutes<previous)additions.set(geometry,band.minutes);
  }
  for(const [geometry,minutes] of additions){
   let t=measure?performance.now():0;
   const runs=contourRuns(geometry,this.grid);
   if(measure){scanMs+=performance.now()-t;runsCount+=runs.length/2;if(geometry.type==='Packed')vertices+=geometry.xy.length/2;t=performance.now();}
   for(let i=0;i<runs.length;i+=2)for(let p=runs[i];p<runs[i+1];p++){
    if(!this.field[p]||minutes<this.field[p])this.field[p]=minutes;
   }
   if(measure)fillMs+=performance.now()-t;
   this.earliest.set(geometry,minutes);
  }
  profileEnd('raster.add',started,{scanMs,fillMs,vertices,runs:runsCount,geometries:additions.size});
  return this.field;
 }
}
export function rasterBands(bands:AreaBand[],grid:RasterGrid):Uint8Array{
 const field=new Uint8Array(grid.width*grid.height),earliest=new Map<RasterGeometry,number>();
 for(const band of bands)for(const geometry of band.geometries)earliest.set(geometry,Math.min(band.minutes,earliest.get(geometry)??Infinity));
 for(const [geometry,minutes] of [...earliest].sort((a,b)=>b[1]-a[1])){
  const runs=contourRuns(geometry,grid);
  for(let i=0;i<runs.length;i+=2)field.fill(minutes,runs[i],runs[i+1]);
 }
 return field;
}

export function paintBands(field:Uint8Array,grid:RasterGrid,maxMinutes:number,cutoff:number,partial?:Uint8Array,directSeconds?:Uint16Array):Uint8ClampedArray{
 const visible=new Uint8Array(field.length),rgba=new Uint8ClampedArray(field.length*4);
 const lower=Math.floor(cutoff/10)*10;
 for(let i=0;i<field.length;i++){
  const value=field[i];
  visible[i]=partial?(value&&value<=lower?value:partial[i]?cutoff:0):(value&&value<=cutoff?value:0);
  // The direct walking graph has second-level costs. Quantize to the same
  // ten-minute colour bands as the stop contours, while respecting a partial
  // cutoff exactly. Keep the fastest of the two independent alternatives.
  const direct=directSeconds?.[i]??0;
  if(direct&&direct<=cutoff*60){
    const band=Math.min(maxMinutes,Math.max(1,Math.ceil(direct/600)*10));
    const minutes=Math.min(band,cutoff);
    if(!visible[i]||minutes<visible[i])visible[i]=minutes;
  }
 }
 const colors=Array.from({length:maxMinutes+1},(_,n)=>colorFor(n*60,maxMinutes).slice(1).match(/../g)!.map(v=>parseInt(v,16)));
 const {width,height}=grid;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=y*width+x,value=visible[i];if(!value)continue;
  const border=(x>0&&visible[i-1]!==value)||(x<width-1&&visible[i+1]!==value)||(y>0&&visible[i-width]!==value)||(y<height-1&&visible[i+width]!==value);
  const color=border?[255,255,255]:colors[value];
  const offset=i*4;rgba[offset]=color[0];rgba[offset+1]=color[1];rgba[offset+2]=color[2];rgba[offset+3]=border?235:255;
 }
 return rgba;
}

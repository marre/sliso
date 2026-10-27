import {contourRuns,type RasterGrid,type AreaGeometry} from './core/bands';

type Feature={type:'Feature';geometry:AreaGeometry|null};
type WaterData={type:'FeatureCollection';features:Feature[]};
type Index={schema:1;tileDegrees:number;tiles:Record<string,string>};
const root=(import.meta.env.VITE_WATER_TILES_URL as string|undefined)?.replace(/\/$/,'');
let indexRequest:Promise<Index>|undefined;
const tileRequests=new Map<string,Promise<AreaGeometry[]>>();
function index():Promise<Index>{
  return indexRequest??=fetch(root+'/index.json').then(async response=>{
    if(!response.ok)throw new Error('Water tile index unavailable');
    const data=await response.json() as Index;
    if(data.schema!==1||!Number.isFinite(data.tileDegrees)||data.tileDegrees<=0||!data.tiles||typeof data.tiles!=='object')throw new Error('Invalid water tile index');
    return data;
  });
}
function tile(name:string):Promise<AreaGeometry[]>{
  let request=tileRequests.get(name);
  if(!request){
    request=fetch(root+'/'+encodeURIComponent(name)).then(async response=>{
      if(!response.ok)throw new Error('Water tile unavailable: '+name);
      const data=await response.json() as WaterData;
      if(data.type!=='FeatureCollection'||!Array.isArray(data.features))throw new Error('Invalid water tile');
      return data.features.flatMap((f):AreaGeometry[]=>f.geometry&&(f.geometry.type==='Polygon'||f.geometry.type==='MultiPolygon')?[f.geometry]:[]);
    });
    tileRequests.set(name,request);
  }
  return request;
}
async function water(bounds:[number,number,number,number]):Promise<AreaGeometry[]>{
  const manifest=await index(),d=manifest.tileDegrees,keys=new Set<string>();
  const [west,south,east,north]=bounds;
  for(let x=Math.floor(west/d);x<=Math.floor(east/d);x++)
    for(let y=Math.floor(south/d);y<=Math.floor(north/d);y++){
      const name=manifest.tiles[x+','+y];if(name)keys.add(name);
    }
  return (await Promise.all([...keys].map(tile))).flat();
}

export class WaterMask {
  private cached?:{key:string;pixels:Uint8Array};
  async apply(rgba:Uint8ClampedArray,width:number,height:number,bounds:[number,number,number,number]):Promise<void>{
    if(!root)return;
    const key=JSON.stringify([width,height,bounds]);
    if(this.cached?.key!==key){
      let geometries:AreaGeometry[];
      try{geometries=await water(bounds);}
      catch(error){console.warn('Water mask disabled:',error);return;}
      const grid:RasterGrid={width,height,bounds},pixels=new Uint8Array(width*height);
      for(const geometry of geometries){
        const runs=contourRuns(geometry,grid);
        for(let i=0;i<runs.length;i+=2)pixels.fill(1,runs[i],runs[i+1]);
      }
      this.cached={key,pixels};
    }
    const mask=this.cached.pixels;
    for(let i=0;i<mask.length;i++)if(mask[i])rgba[i*4+3]=0;
  }
}

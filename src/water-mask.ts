import {contourRuns,type RasterGrid,type AreaGeometry} from './core/bands';

type Feature={type:'Feature';geometry:AreaGeometry|null};
type WaterData={type:'FeatureCollection';features:Feature[]};
let request:Promise<AreaGeometry[]>|undefined;

/** Optional, versioned OSM water polygon export; never infer water from basemap styling. */
function water():Promise<AreaGeometry[]> {
  const url=import.meta.env.VITE_WATER_GEOJSON_URL as string|undefined;
  if(!url)return Promise.resolve([]);
  return request??=fetch(url).then(async response=>{
    if(!response.ok)throw new Error('Water mask unavailable');
    const data=await response.json() as WaterData;
    if(data.type!=='FeatureCollection'||!Array.isArray(data.features))throw new Error('Invalid water mask');
    return data.features.filter(f=>f.geometry?.type==='Polygon'||f.geometry?.type==='MultiPolygon').map(f=>f.geometry!);
  }).catch(error=>{console.warn('Water mask disabled:',error);return [];});
}

export class WaterMask {
  private cached?:{key:string;pixels:Uint8Array};
  async apply(rgba:Uint8ClampedArray,width:number,height:number,bounds:[number,number,number,number]):Promise<void>{
    const geometries=await water();
    if(!geometries.length)return;
    const key=JSON.stringify([width,height,bounds]);
    if(this.cached?.key!==key){
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

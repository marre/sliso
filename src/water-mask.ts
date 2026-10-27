import type {Manifest} from './core/types';

type Mask=NonNullable<Manifest['waterMask']>;
const requests=new Map<string,Promise<Uint8Array>>();
const mercator=(lat:number)=>Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));
const unmercator=(y:number)=>(2*Math.atan(Math.exp(y))-Math.PI/2)*180/Math.PI;

async function bitmap(url:string,bytes:number):Promise<Uint8Array>{
  let request=requests.get(url);
  if(!request){
    request=fetch(url).then(async response=>{
      if(!response.ok)throw new Error('Missing water bitmap '+url);
      const data=new Uint8Array(await response.arrayBuffer());
      if(data.length!==bytes)throw new Error('Invalid water bitmap length');
      return data;
    });
    requests.set(url,request);
    request.catch(()=>requests.delete(url));
  }
  return request;
}

export class WaterMask {
  private cached?:{key:string;pixels:Uint8Array};
  constructor(private readonly manifest?:Mask){}
  async apply(rgba:Uint8ClampedArray,width:number,height:number,bounds:[number,number,number,number]):Promise<void>{
    const m=this.manifest;
    if(!m)return;
    if(m.format!=='sliso-water-bitmap-v1'||m.resolution!==512||!Number.isFinite(m.tileDegrees)||m.tileDegrees<=0)return;
    const key=JSON.stringify([width,height,bounds,m]);
    if(this.cached?.key!==key){
      const [west,south,east,north]=bounds,d=m.tileDegrees,n=m.resolution;
      const names=new Set<string>();
      for(let x=Math.floor(west/d);x<=Math.floor(east/d);x++)
        for(let y=Math.floor(south/d);y<=Math.floor(north/d);y++){
          const name=x+','+y;if(m.tiles[name])names.add(name);
        }
      const tiles=new Map<string,Uint8Array>();
      try{
        await Promise.all([...names].map(async name=>{
          const ref=m.tiles[name];
          if(!ref||ref.bytes!==n*n/8)throw new Error('Invalid water bitmap reference');
          tiles.set(name,await bitmap(ref.url,ref.bytes));
        }));
      }catch(error){console.warn('Water mask unavailable:',error);return;}
      const pixels=new Uint8Array(width*height);
      const top=mercator(north),bottom=mercator(south);
      for(let row=0;row<height;row++){
        const lat=unmercator(top-(row+.5)/height*(top-bottom));
        const ty=Math.floor(lat/d),localY=Math.min(n-1,Math.max(0,Math.floor((lat/d-ty)*n)));
        for(let col=0;col<width;col++){
          const lon=west+(col+.5)/width*(east-west),tx=Math.floor(lon/d);
          const tile=tiles.get(tx+','+ty);if(!tile)continue;
          const localX=Math.min(n-1,Math.max(0,Math.floor((lon/d-tx)*n)));
          const bit=localY*n+localX;
          if(tile[bit>>3]&(128>>(bit&7)))pixels[row*width+col]=1;
        }
      }
      this.cached={key,pixels};
    }
    const mask=this.cached.pixels;
    for(let i=0;i<mask.length;i++)if(mask[i])rgba[i*4+3]=0;
  }
}

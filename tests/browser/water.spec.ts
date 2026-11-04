import {test,expect} from '@playwright/test';
import {createHash} from 'node:crypto';

test('water mask clips the displayed raster and preserves an island at overview and detail scales',async({page})=>{
 const bits=Buffer.alloc(512*512/8,255);
 for(let y=192;y<320;y++)for(let x=192;x<320;x++){const bit=y*512+x;bits[bit>>3]&=~(128>>(bit&7));}
 const ref={url:'/data/water-browser/tile.bin',bytes:bits.length,sha256:createHash('sha256').update(bits).digest('hex')};
 await page.route('**/data/water-browser/tile.bin',route=>route.fulfill({body:bits,contentType:'application/octet-stream'}));
 await page.goto('/');
 const samples=await page.evaluate(async(ref)=>{
  const mapModule='/src/map.ts',canvasModule='/src/band-canvas.ts';
  const {createMap}=await import(mapModule),{BandCanvas}=await import(canvasModule);
  const el=document.createElement('div');el.style.cssText='position:fixed;inset:0;width:300px;height:300px';document.body.append(el);
  const map=await createMap(el,[18.125,59.375],10,'none');
  const results=[];
  for(const zoom of [10,14]){
   map.setZoom(zoom);
   const image=new BandCanvas(map,map.getBounds().setSouthWest([18,59.25]).setNorthEast([18.25,59.5]),{format:'sliso-water-bitmap-v1',resolution:512,tileDegrees:.25,tiles:{'72,237':ref}});
   const pixels=new Uint8ClampedArray(64*64*4).fill(255);
   await image.image(64,64,pixels,30);
   const ctx=image.canvas.getContext('2d');
   results.push({water:ctx.getImageData(4,4,1,1).data[3],island:ctx.getImageData(32,32,1,1).data[3],layer:!!map.getLayer('walking-areas')});
   image.remove();
  }
  map.remove();el.remove();return results;
 },ref);
 expect(samples).toEqual([{water:0,island:255,layer:true},{water:0,island:255,layer:true}]);
});
